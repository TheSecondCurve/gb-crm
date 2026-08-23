// system 配置业务规则（K46/K50，存储为 system_configs code='llm'）：
// - GET 只回掩码：apiKeySet + apiKeyMasked，永不全量返回 apiKey；
// - PATCH：单配置、单管理员，有意不做 OCC（偏离 K24 内核：无并发写场景，做了反而要
//   每次先 GET 拿 updatedAt，纯负担）；apiKey 空/缺席保留旧值（placeholder 语义）。
import type { AiConfigGet, AiConfigPatch } from "@gb-crm/shared";
import {
  canAllowedPageKeys,
  computeEffectivePages,
  type PageAccessConfig,
  type PageAccessGet,
  type PageAccessPatch,
  type PageKey,
  type SystemRole,
} from "@gb-crm/shared";

import { ApiError } from "../../plugins/error-handler.js";
import type { Db } from "../../db/client.js";
import {
  getAiConfig,
  getPageAccessConfig,
  upsertAiConfig,
  upsertPageAccessConfig,
} from "./repo.js";

const CONFIGURABLE_ROLES = ["operator", "assistant"] as const;

export function maskApiKey(key: string | null): string | null {
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
    apiKeyMasked: maskApiKey(apiKey),
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

/** 供 /auth/me 计算当前角色实际可见的菜单页（含安全边界交集） */
export function getEffectivePages(db: Db, role: SystemRole | null): PageKey[] {
  return computeEffectivePages(role, getPageAccessConfig(db));
}
