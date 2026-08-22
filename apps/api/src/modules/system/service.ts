// system 配置业务规则（K46/K50，存储为 system_configs code='llm'）：
// - GET 只回掩码：apiKeySet + apiKeyMasked，永不全量返回 apiKey；
// - PATCH：单配置、单管理员，有意不做 OCC（偏离 K24 内核：无并发写场景，做了反而要
//   每次先 GET 拿 updatedAt，纯负担）；apiKey 空/缺席保留旧值（placeholder 语义）。
import type { AiConfigGet, AiConfigPatch } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { getAiConfig, upsertAiConfig } from "./repo.js";

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
