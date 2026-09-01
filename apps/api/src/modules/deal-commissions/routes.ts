// /api/v1/deals/commissions 与 /api/v1/deals/:id/commissions 路由（§3：routes 只做 Zod、requireCan、HTTP 映射）。
// RBAC（K56）：assistant 只读（list/read）；update（配置分成）仅 admin/operator。
import {
  dealCommissionListQuerySchema,
  dealCommissionPutSchema,
} from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import { getDealCommissionResult, listCommissionResult, setDealCommission } from "./service.js";

export interface DealCommissionsRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const dealIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function dealCommissionsRoutes(app: FastifyInstance, opts: DealCommissionsRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get(
    "/api/v1/deals/commissions",
    { preHandler: requireCan("dealCommissions", "list") },
    async (req) => {
      const query = dealCommissionListQuerySchema.parse(req.query ?? {});
      const { data, total } = listCommissionResult(db, query);
      return { data, meta: listMeta(query.page, query.pageSize, total) };
    },
  );

  app.get(
    "/api/v1/deals/:id/commissions",
    { preHandler: requireCan("dealCommissions", "read") },
    async (req) => {
      const { id } = dealIdParamSchema.parse(req.params);
      return { data: getDealCommissionResult(db, id) };
    },
  );

  app.put(
    "/api/v1/deals/:id/commissions",
    { preHandler: requireCan("dealCommissions", "update") },
    async (req) => {
      const { id } = dealIdParamSchema.parse(req.params);
      const body = dealCommissionPutSchema.parse(req.body ?? {});
      return { data: setDealCommission(db, id, body, auditCtx(req)) };
    },
  );
}
