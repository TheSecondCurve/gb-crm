// system 配置业务规则（K46/K50/K53，存储为 system_configs code='llm'/'pageAccess'/'s3'）：
// - GET 只回掩码：secret 永不全量返回（LLM apiKey / S3 secretAccessKey）；
// - PATCH：单配置、单管理员，有意不做 OCC（偏离 K24 内核：无并发写场景，做了反而要
//   每次先 GET 拿 updatedAt，纯负担）；secret 空/缺席保留旧值（placeholder 语义）。
import type {
  AiConfigGet,
  AiConfigPatch,
  CommissionDefaultGet,
  CommissionDefaultPatch,
  CommissionDefaultRule,
  S3ConfigGet,
  S3ConfigPatch,
  S3TestResult,
} from "@gb-crm/shared";
import {
  canAllowedPageKeys,
  computeEffectivePages,
  type PageAccessConfig,
  type PageAccessGet,
  type PageAccessPatch,
  type PageKey,
  type SystemRole,
} from "@gb-crm/shared";

import { s3Probe, S3Error, type S3ClientConfig } from "../../lib/s3.js";
import { ApiError, s3Error, unprocessable } from "../../plugins/error-handler.js";
import type { Db } from "../../db/client.js";
import { findLiveUserIds } from "../deal-commissions/repo.js";
import {
  getAiConfig,
  getCommissionDefault,
  getPageAccessConfig,
  getS3Config,
  isS3RemoteReady,
  upsertAiConfig,
  upsertCommissionDefault,
  upsertPageAccessConfig,
  upsertS3Config,
} from "./repo.js";

const CONFIGURABLE_ROLES = ["operator", "assistant"] as const;

/** 掩码规则通用（LLM apiKey / S3 secretAccessKey）：≤8 位全遮，否则首 4…末 4 */
export function maskSecret(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function getAiConfigResult(db: Db): AiConfigGet {
  const row = getAiConfig(db);
  const apiKey = row?.apiKey ?? null;
  return {
    provider: row?.provider ?? null,
    baseUrl: row?.baseUrl ?? null,
    model: row?.model ?? null,
    apiKeySet: apiKey !== null && apiKey !== "",
    apiKeyMasked: maskSecret(apiKey),
  };
}

export function patchAiConfig(
  db: Db,
  patch: AiConfigPatch,
  ctx: { now: number; userId: number },
): AiConfigGet {
  const current = getAiConfig(db);
  upsertAiConfig(db, {
    provider: patch.provider !== undefined ? patch.provider : (current?.provider ?? null),
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : (current?.baseUrl ?? null),
    model: patch.model !== undefined ? patch.model : (current?.model ?? null),
    // 空/缺席保留旧值
    apiKey: patch.apiKey !== undefined ? patch.apiKey : (current?.apiKey ?? null),
    updatedAt: ctx.now,
    updatedBy: ctx.userId,
  });
  return getAiConfigResult(db);
}

// ---- 角色→页面权限（配置层；only admin 经 requireCan("system") 访问）----
// 配置只能在 can() 允许集内收缩；超发（如给 assistant 配 users）在 PATCH 时 422 拒绝。
// admin 固定全量、不参与配置（防锁死管理页）。

function assertAllowedPageKeys(role: SystemRole, keys: string[]): PageKey[] {
  const allowed = new Set(canAllowedPageKeys(role));
  for (const k of keys) {
    if (!allowed.has(k as PageKey)) {
      throw new ApiError(422, "VALIDATION", `角色 ${role} 无权访问页面 ${k}`);
    }
  }
  return keys as PageKey[];
}

export function getPageAccessMatrix(db: Db): PageAccessGet {
  const config = getPageAccessConfig(db);
  return {
    roles: {
      operator: {
        allowed: canAllowedPageKeys("operator"),
        enabled: computeEffectivePages("operator", config),
      },
      assistant: {
        allowed: canAllowedPageKeys("assistant"),
        enabled: computeEffectivePages("assistant", config),
      },
    },
  };
}

export function patchPageAccess(
  db: Db,
  patch: PageAccessPatch,
  ctx: { now: number; userId: number },
): PageAccessGet {
  const next: PageAccessConfig = { ...getPageAccessConfig(db) };
  for (const role of CONFIGURABLE_ROLES) {
    const arr = patch.roles[role];
    if (arr !== undefined) {
      next[role] = assertAllowedPageKeys(role, arr);
    }
  }
  upsertPageAccessConfig(db, next, ctx.now, ctx.userId);
  return getPageAccessMatrix(db);
}

// ---- S3 兼容对象存储（code='s3'，K53；仅 admin 经 requireCan("system") 访问）----
// enabled=true 时四要素必须齐备（endpoint/bucket/accessKeyId/secretAccessKey），
// 防止存出「启用但残缺」的配置导致每日备份静默不上传。

/** prefix 归一化：去开头/结尾/重复斜杠；空 → "" */
export function normalizeS3Prefix(prefix: string | null): string | null {
  if (prefix === null) return null;
  const trimmed = prefix
    .split("/")
    .filter((seg) => seg !== "")
    .join("/");
  return trimmed === "" ? "" : `${trimmed}/`;
}

function s3ConfigToClientConfig(cfg: NonNullable<ReturnType<typeof getS3Config>>): S3ClientConfig {
  // 调用方先用 isS3RemoteReady 断言过四要素
  return {
    endpoint: cfg.endpoint!,
    region: cfg.region,
    bucket: cfg.bucket!,
    accessKeyId: cfg.accessKeyId!,
    secretAccessKey: cfg.secretAccessKey!,
  };
}

export function getS3ConfigResult(db: Db): S3ConfigGet {
  const cfg = getS3Config(db);
  const secret = cfg?.secretAccessKey ?? null;
  return {
    enabled: cfg?.enabled ?? false,
    endpoint: cfg?.endpoint ?? null,
    region: cfg?.region ?? null,
    bucket: cfg?.bucket ?? null,
    prefix: cfg?.prefix ?? null,
    accessKeyId: cfg?.accessKeyId ?? null,
    secretKeySet: secret !== null,
    secretKeyMasked: maskSecret(secret),
    keep: cfg?.keep ?? 7,
  };
}

export function patchS3Config(
  db: Db,
  patch: S3ConfigPatch,
  ctx: { now: number; userId: number },
): S3ConfigGet {
  const current = getS3Config(db);
  const next = {
    enabled: patch.enabled !== undefined ? patch.enabled : (current?.enabled ?? false),
    endpoint: patch.endpoint !== undefined ? patch.endpoint : (current?.endpoint ?? null),
    region: patch.region !== undefined ? patch.region : (current?.region ?? null),
    bucket: patch.bucket !== undefined ? patch.bucket : (current?.bucket ?? null),
    prefix:
      patch.prefix !== undefined
        ? normalizeS3Prefix(patch.prefix)
        : normalizeS3Prefix(current?.prefix ?? null),
    accessKeyId:
      patch.accessKeyId !== undefined ? patch.accessKeyId : (current?.accessKeyId ?? null),
    // 空/缺席保留旧值
    secretAccessKey:
      patch.secretAccessKey !== undefined
        ? patch.secretAccessKey
        : (current?.secretAccessKey ?? null),
    keep: patch.keep !== undefined ? patch.keep : (current?.keep ?? 7),
    updatedAt: ctx.now,
    updatedBy: ctx.userId,
  };
  if (next.enabled && !isS3RemoteReady(next)) {
    throw unprocessable("启用远程备份需先完整填写 Endpoint / Bucket / AccessKeyId / SecretAccessKey");
  }
  upsertS3Config(db, next);
  return getS3ConfigResult(db);
}

/** 连通性测试：写探针对象再删除；配置未保存/不完整 → 422，上游失败 → 502 S3_ERROR */
export async function testS3Connection(
  db: Db,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<S3TestResult> {
  const cfg = getS3Config(db);
  if (!cfg || !isS3RemoteReady(cfg)) {
    throw unprocessable("请先保存完整的对象存储配置");
  }
  try {
    const probeKey = await s3Probe(s3ConfigToClientConfig(cfg), cfg.prefix ?? "", {
      fetchFn: opts.fetchFn,
    });
    return { ok: true, probeKey };
  } catch (err) {
    if (err instanceof S3Error) throw s3Error(err.message);
    throw err;
  }
}

/** 供 /auth/me 计算当前角色实际可见的菜单页（含安全边界交集） */
export function getEffectivePages(db: Db, role: SystemRole | null): PageKey[] {
  return computeEffectivePages(role, getPageAccessConfig(db));
}

// ---- K56 成交分红全局默认方案（仅 admin 经 requireCan("system") 访问）----
// 未配置的成交动态套用该方案；Σ percentage ≤ 1；source=user 的 userId 必须为 live 用户。

export function getCommissionDefaultResult(db: Db): CommissionDefaultGet {
  return { rules: getCommissionDefault(db) };
}

export function patchCommissionDefault(
  db: Db,
  patch: CommissionDefaultPatch,
  ctx: { now: number; userId: number },
): CommissionDefaultGet {
  validateCommissionDefault(db, patch.rules);
  upsertCommissionDefault(db, patch.rules, ctx.now, ctx.userId);
  return getCommissionDefaultResult(db);
}

function validateCommissionDefault(db: Db, rules: readonly CommissionDefaultRule[]): void {
  let sum = 0;
  const userIds: number[] = [];
  for (const rule of rules) {
    sum += rule.percentage;
    if (rule.userId !== undefined) userIds.push(rule.userId);
  }
  if (sum > 1) {
    throw unprocessable("默认分成比例总和不能超过 100%", [
      { path: "rules", message: `Σpercentage = ${Math.round(sum * 10000) / 10000} > 1` },
    ]);
  }
  const live = findLiveUserIds(db, [...new Set(userIds)]);
  const missing = [...new Set(userIds)].filter((id) => !live.has(id));
  if (missing.length > 0) {
    throw unprocessable("分成人不存在或已删除", [
      { path: "rules", message: `无效 user_id: ${missing.join(",")}` },
    ]);
  }
}
