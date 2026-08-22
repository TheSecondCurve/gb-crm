// /api/v1/system 路由（K46：LLM 打标配置，仅 admin——system.read/update）。
// 单行配置：GET 掩码返回；PATCH 单管理员、有意不做 OCC（见 service.ts 注释）。
import { aiConfigPatchSchema } from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";

import type { Db } from "../../db/client.js";
import { requireCan } from "../../plugins/rbac.js";
import { getAiConfigResult, patchAiConfig } from "./service.js";

export interface SystemRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

export function systemRoutes(app: FastifyInstance, opts: SystemRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get(
    "/api/v1/system/ai-config",
    { preHandler: requireCan("system", "read") },
    async () => ({ data: getAiConfigResult(db) }),
  );

  app.patch(
    "/api/v1/system/ai-config",
    { preHandler: requireCan("system", "update") },
    async (req) => {
      const patch = aiConfigPatchSchema.parse(req.body ?? {});
      return { data: patchAiConfig(db, patch, auditCtx(req)) };
    },
  );
}
