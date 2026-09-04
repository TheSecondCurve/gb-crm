// system_configs 通用配置表访问（K50）。跨模块复用：system 路由 + customers AI 打标端点。
// 存储形态：code 主键 + value JSON 字符串；LLM 配置 code='llm'（provider/baseUrl/apiKey/model），
// S3 远程备份配置 code='s3'（K53：enabled/endpoint/region/bucket/prefix/accessKeyId/secretAccessKey），
// 资料存储配置 code='materialsS3'（K57：同凭证字段，无 keep）。
import { eq } from "drizzle-orm";

import type { CommissionDefaultRule, PageAccessConfig, PageKey } from "@gb-crm/shared";
import { commissionDefaultGetSchema } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { systemConfigs } from "../../db/schema.js";

export const LLM_CONFIG_CODE = "llm";
/** 角色→页面权限（前端功能级，K-shape；存储为 system_configs code='pageAccess'） */
export const PAGE_ACCESS_CONFIG_CODE = "pageAccess";
/** S3 兼容对象存储远程备份（K53） */
export const S3_CONFIG_CODE = "s3";
/** S3 兼容对象存储资料文件（K57） */
export const MATERIALS_S3_CONFIG_CODE = "materialsS3";
/** K56 成交分成的全局默认方案 */
export const COMMISSION_DEFAULT_CODE = "commissionDefault";

export interface SystemConfigRow {
  code: string;
  value: string;
  updatedAt: number;
  updatedBy: number | null;
}

export interface AiConfigValue {
  provider: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
}

export interface AiConfigRow extends AiConfigValue {
  updatedAt: number | null;
  updatedBy: number | null;
}

/** JSON 值归一为非空字符串或 null（空串/缺键/类型不对 → null） */
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** 取任意 code 的配置行（value 原样返回，不做 JSON 解析） */
export function getConfigRow(db: Db, code: string): SystemConfigRow | undefined {
  return db.select().from(systemConfigs).where(eq(systemConfigs.code, code)).get();
}

/** 按 code upsert（code 为主键）；调用方拼好 value 字符串与审计值 */
export function upsertConfigRow(
  db: Db,
  code: string,
  value: string,
  updatedAt: number,
  updatedBy: number | null,
): void {
  db.insert(systemConfigs)
    .values({ code, value, updatedAt, updatedBy })
    .onConflictDoUpdate({
      target: systemConfigs.code,
      set: { value, updatedAt, updatedBy },
    })
    .run();
}

// ---- LLM 配置（code='llm'）编解码 ----
// value JSON 只含字符串；空串/缺键统一归一为 null（迁移写入时空值 COALESCE 成了 ''）。

function parseLlmValue(json: string): AiConfigValue {
  const parsed: unknown = JSON.parse(json);
  const obj = (parsed ?? {}) as Record<string, unknown>;
  return {
    provider: strOrNull(obj.provider),
    baseUrl: strOrNull(obj.baseUrl),
    apiKey: strOrNull(obj.apiKey),
    model: strOrNull(obj.model),
  };
}

export function getAiConfig(db: Db): AiConfigRow | undefined {
  const row = getConfigRow(db, LLM_CONFIG_CODE);
  if (!row) return undefined;
  return { ...parseLlmValue(row.value), updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}

/** 单配置 upsert（code='llm'）；调用方拼好最终值（含 apiKey 保留逻辑） */
export function upsertAiConfig(
  db: Db,
  values: {
    provider: string | null;
    baseUrl: string | null;
    model: string | null;
    apiKey: string | null;
    updatedAt: number;
    updatedBy: number | null;
  },
): void {
  upsertConfigRow(
    db,
    LLM_CONFIG_CODE,
    JSON.stringify({
      provider: values.provider,
      baseUrl: values.baseUrl,
      apiKey: values.apiKey,
      model: values.model,
    }),
    values.updatedAt,
    values.updatedBy,
  );
}

// ---- 角色→页面权限（code='pageAccess'）编解码 ----
// value = { operator: string[], assistant: string[] }（admin 固定全量，不存）。

const CONFIGURABLE_ROLES = ["operator", "assistant"] as const;

export function getPageAccessConfig(db: Db): PageAccessConfig {
  const row = getConfigRow(db, PAGE_ACCESS_CONFIG_CODE);
  if (!row) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return {};
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const out: PageAccessConfig = {};
  for (const role of CONFIGURABLE_ROLES) {
    const arr = obj[role];
    if (Array.isArray(arr)) {
      out[role] = arr.filter((k): k is PageKey => typeof k === "string");
    }
  }
  return out;
}

export function upsertPageAccessConfig(
  db: Db,
  value: PageAccessConfig,
  updatedAt: number,
  updatedBy: number | null,
): void {
  upsertConfigRow(db, PAGE_ACCESS_CONFIG_CODE, JSON.stringify(value), updatedAt, updatedBy);
}

// ---- S3 兼容对象存储（code='s3'，K53）编解码 ----
// value = { enabled, endpoint, region, bucket, prefix, accessKeyId, secretAccessKey, keep }；
// secretAccessKey 明文存库（同 LLM apiKey，库文件 chmod 600 + 内网），API 只回掩码。
// prefix 归一化为 "" 或 "xxx/"（无开头斜杠）；keep 为远端滚动保留份数（1~30，默认 7）。

export const DEFAULT_S3_KEEP = 7;
export const MIN_S3_KEEP = 1;
export const MAX_S3_KEEP = 30;

/** S3 兼容凭证（备份 / 资料存储共用四要素 + enabled/region/prefix） */
export interface S3CredentialsValue {
  enabled: boolean;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  /** 归一化后的对象 key 前缀："" 或 "xxx/" */
  prefix: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
}

export interface S3ConfigValue extends S3CredentialsValue {
  /** 远端滚动保留份数（1~30，默认 7） */
  keep: number;
}

function parseS3Credentials(json: string): S3CredentialsValue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    endpoint: strOrNull(obj.endpoint),
    region: strOrNull(obj.region),
    bucket: strOrNull(obj.bucket),
    prefix: strOrNull(obj.prefix),
    accessKeyId: strOrNull(obj.accessKeyId),
    secretAccessKey: strOrNull(obj.secretAccessKey),
  };
}

function parseS3Value(json: string): S3ConfigValue | undefined {
  const creds = parseS3Credentials(json);
  if (!creds) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const rawKeep = obj.keep;
  let keep = DEFAULT_S3_KEEP;
  if (typeof rawKeep === "number" && Number.isInteger(rawKeep) && rawKeep >= MIN_S3_KEEP && rawKeep <= MAX_S3_KEEP) {
    keep = rawKeep;
  }
  return { ...creds, keep };
}

export function getS3Config(db: Db): S3ConfigValue | undefined {
  const row = getConfigRow(db, S3_CONFIG_CODE);
  if (!row) return undefined;
  return parseS3Value(row.value);
}

export function upsertS3Config(
  db: Db,
  values: S3ConfigValue & { updatedAt: number; updatedBy: number | null },
): void {
  upsertConfigRow(
    db,
    S3_CONFIG_CODE,
    JSON.stringify({
      enabled: values.enabled,
      endpoint: values.endpoint,
      region: values.region,
      bucket: values.bucket,
      prefix: values.prefix,
      accessKeyId: values.accessKeyId,
      secretAccessKey: values.secretAccessKey,
      keep: values.keep,
    }),
    values.updatedAt,
    values.updatedBy,
  );
}

/** 启用远程上传所需的四要素是否齐备（region/prefix 可缺省） */
export function isS3RemoteReady(cfg: S3CredentialsValue): boolean {
  return (
    cfg.endpoint !== null && cfg.bucket !== null && cfg.accessKeyId !== null && cfg.secretAccessKey !== null
  );
}

export function getMaterialsS3Config(db: Db): S3CredentialsValue | undefined {
  const row = getConfigRow(db, MATERIALS_S3_CONFIG_CODE);
  if (!row) return undefined;
  return parseS3Credentials(row.value);
}

export function upsertMaterialsS3Config(
  db: Db,
  values: S3CredentialsValue & { updatedAt: number; updatedBy: number | null },
): void {
  upsertConfigRow(
    db,
    MATERIALS_S3_CONFIG_CODE,
    JSON.stringify({
      enabled: values.enabled,
      endpoint: values.endpoint,
      region: values.region,
      bucket: values.bucket,
      prefix: values.prefix,
      accessKeyId: values.accessKeyId,
      secretAccessKey: values.secretAccessKey,
    }),
    values.updatedAt,
    values.updatedBy,
  );
}

// ---- 成交分红全局默认方案（code='commissionDefault'，K56）编解码 ----
// value = { rules: [{ source, percentage, userId? }] }；source ∈ owner/dealOwner/user。
// 未配置的成交动态套用该方案；解析失败/缺席 → []（默认无分红）。

export function getCommissionDefault(db: Db): CommissionDefaultRule[] {
  const row = getConfigRow(db, COMMISSION_DEFAULT_CODE);
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    const result = commissionDefaultGetSchema.safeParse(parsed);
    return result.success ? result.data.rules : [];
  } catch {
    return [];
  }
}

export function upsertCommissionDefault(
  db: Db,
  rules: readonly CommissionDefaultRule[],
  updatedAt: number,
  updatedBy: number | null,
): void {
  upsertConfigRow(db, COMMISSION_DEFAULT_CODE, JSON.stringify({ rules }), updatedAt, updatedBy);
}
