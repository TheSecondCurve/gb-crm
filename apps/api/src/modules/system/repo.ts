// ai_config 单行表访问（K46）。跨模块复用：system 路由 + customers AI 打标端点。
import { eq } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { aiConfig } from "../../db/schema.js";

export interface AiConfigRow {
  provider: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  updatedAt: number | null;
  updatedBy: number | null;
}

export function getAiConfig(db: Db): AiConfigRow | undefined {
  return db.select().from(aiConfig).where(eq(aiConfig.id, 1)).get();
}

/** 单行 upsert（id 恒为 1）；调用方拼好最终值（含 apiKey 保留逻辑） */
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
  db.insert(aiConfig)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({
      target: aiConfig.id,
      set: {
        provider: values.provider,
        baseUrl: values.baseUrl,
        model: values.model,
        apiKey: values.apiKey,
        updatedAt: values.updatedAt,
        updatedBy: values.updatedBy,
      },
    })
    .run();
}
