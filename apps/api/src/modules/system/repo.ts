// system_configs 通用配置表访问（K50）。跨模块复用：system 路由 + customers AI 打标端点。
// 存储形态：code 主键 + value JSON 字符串；LLM 配置 code='llm'（provider/baseUrl/apiKey/model）。
import { eq } from "drizzle-orm";

import type { PageAccessConfig, PageKey } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { systemConfigs } from "../../db/schema.js";

export const LLM_CONFIG_CODE = "llm";
/** 角色→页面权限（前端功能级，K-shape；存储为 system_configs code='pageAccess'） */
export const PAGE_ACCESS_CONFIG_CODE = "pageAccess";

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
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    provider: str(obj.provider),
    baseUrl: str(obj.baseUrl),
    apiKey: str(obj.apiKey),
    model: str(obj.model),
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
