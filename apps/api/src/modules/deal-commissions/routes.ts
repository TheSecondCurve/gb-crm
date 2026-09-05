// /api/v1/deals/commissions 与 /api/v1/deals/:id/commissions 路由（§3：routes 只做 Zod、requireCan、HTTP 映射）。
// RBAC（K56）：assistant 只读（list/read）；update（配置分成）仅 admin/operator。
import {
  dealCommissionListQuerySchema,
  dealCommissionPutSchema,
  dealPayoutPatchSchema,
  dealPayoutUpsertSchema,
} from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import { buildCommissionXlsx } from "./export.js";
import {
  exportCommissionResult,
  getDealCommissionResult,
  listCommissionResult,
  listPayoutResult,
  patchDealPayoutStatus,
  setDealCommission,
  setDealPayouts,
} from "./service.js";

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

  // 导出 Excel：与列表同一 WHERE（日期范围/状态/q），全量不分页；注册在 /:id 之前
  app.get(
    "/api/v1/deals/commissions/export.xlsx",
    { preHandler: requireCan("dealCommissions", "list") },
    async (req, reply) => {
      const query = dealCommissionListQuerySchema.parse(req.query ?? {});
      const buf = await buildCommissionXlsx(exportCommissionResult(db, query), {
        start: query.startDate ?? null,
        end: query.endDate ?? null,
      });
      const d = new Date(now());
      const pad = (n: number) => String(n).padStart(2, "0");
      const filename = `成交分成-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.xlsx`;
      return reply
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header(
          "Content-Disposition",
          `attachment; filename="deals-commissions.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        )
        .send(buf);
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

  // ---- payout（v2）----

  app.get(
    "/api/v1/deals/:id/payouts",
    { preHandler: requireCan("dealCommissions", "read") },
    async (req) => {
      const { id } = dealIdParamSchema.parse(req.params);
      return { data: listPayoutResult(db, id) };
    },
  );

  app.put(
    "/api/v1/deals/:id/payouts",
    { preHandler: requireCan("dealCommissions", "update") },
    async (req) => {
      const { id } = dealIdParamSchema.parse(req.params);
      const body = dealPayoutUpsertSchema.parse(req.body ?? {});
      return { data: setDealPayouts(db, id, body, auditCtx(req)) };
    },
  );

  const payoutSeqParamSchema = z.object({
    id: z.coerce.number().int().positive(),
    seq: z.coerce.number().int().min(1).max(2),
  });

  app.patch(
    "/api/v1/deals/:id/payouts/:seq",
    { preHandler: requireCan("dealCommissions", "update") },
    async (req) => {
      const { id, seq } = payoutSeqParamSchema.parse(req.params);
      const body = dealPayoutPatchSchema.parse(req.body ?? {});
      return { data: patchDealPayoutStatus(db, id, seq, body, auditCtx(req)) };
    },
  );
}
