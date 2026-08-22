// /api/v1/deals 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// RBAC（K42）：assistant 只读（list/read）；create/update/delete 仅 admin/operator。
import { dealListQuerySchema, dealPatchSchema, dealWriteSchema } from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  createDeal,
  deleteDeal,
  getDealResult,
  listDealsResult,
  patchDeal,
} from "./service.js";

export interface DealsRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function dealsRoutes(app: FastifyInstance, opts: DealsRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get("/api/v1/deals", { preHandler: requireCan("deals", "list") }, async (req) => {
    const query = dealListQuerySchema.parse(req.query ?? {});
    const { data, total } = listDealsResult(db, query);
    return { data, meta: listMeta(query.page, query.pageSize, total) };
  });

  app.post(
    "/api/v1/deals",
    { preHandler: requireCan("deals", "create") },
    async (req, reply) => {
      const body = dealWriteSchema.parse(req.body ?? {});
      const data = createDeal(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.get("/api/v1/deals/:id", { preHandler: requireCan("deals", "read") }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return { data: getDealResult(db, id) };
  });

  app.patch(
    "/api/v1/deals/:id",
    { preHandler: requireCan("deals", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = dealPatchSchema.parse(req.body ?? {});
      return { data: patchDeal(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/deals/:id",
    { preHandler: requireCan("deals", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteDeal(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );
}
