// /api/v1/payout-batches 路由（§3：routes 只做 Zod、requireCan、HTTP 映射）。
// RBAC（K59）：复用 dealCommissions 资源——list/read 全角色；写操作（update）仅 admin/operator。
import {
  payoutBatchCandidatesQuerySchema,
  payoutBatchCreateSchema,
  payoutBatchItemAddSchema,
  payoutBatchListQuerySchema,
  payoutBatchPatchSchema,
} from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import { buildPayoutBatchXlsx } from "./export.js";
import {
  addItem,
  createBatch,
  getBatchDetail,
  listBatches,
  listCandidates,
  lockBatch,
  markBatchPaid,
  patchBatch,
  removeBatch,
  removeItem,
  unlockBatch,
} from "./service.js";

export interface PayoutBatchesRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const itemParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
});

export function payoutBatchesRoutes(app: FastifyInstance, opts: PayoutBatchesRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get(
    "/api/v1/payout-batches",
    { preHandler: requireCan("dealCommissions", "list") },
    async (req) => {
      const query = payoutBatchListQuerySchema.parse(req.query ?? {});
      const { data, total } = listBatches(db, query);
      return { data, meta: listMeta(query.page, query.pageSize, total) };
    },
  );

  app.post(
    "/api/v1/payout-batches",
    { preHandler: requireCan("dealCommissions", "update") },
    async (req, reply) => {
      const body = payoutBatchCreateSchema.parse(req.body ?? {});
      return reply.code(201).send({ data: createBatch(db, body, auditCtx(req)) });
    },
  );

  // 待发候选（静态路径注册在 /:id 之前，find-my-way 静态优先双保险）
  app.get(
    "/api/v1/payout-batches/candidates",
    { preHandler: requireCan("dealCommissions", "read") },
    async (req) => {
      const query = payoutBatchCandidatesQuerySchema.parse(req.query ?? {});
      return { data: listCandidates(db, query) };
    },
  );

  app.get(
    "/api/v1/payout-batches/:id",
    { preHandler: requireCan("dealCommissions", "read") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      return { data: getBatchDetail(db, id) };
    },
  );

  app.get(
    "/api/v1/payout-batches/:id/export.xlsx",
    { preHandler: requireCan("dealCommissions", "list") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const detail = getBatchDetail(db, id);
      const buf = await buildPayoutBatchXlsx(detail);
      const filename = `分成发放-${detail.batch.name}.xlsx`;
      return reply
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header(
          "Content-Disposition",
          `attachment; filename="payout-batch-${id}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        )
        .send(buf);
    },
  );

  app.patch(
    "/api/v1/payout-batches/:id",
    { preHandler: requireCan("dealCommissions", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = payoutBatchPatchSchema.parse(req.body ?? {});
      return { data: patchBatch(db, id, body, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/payout-batches/:id",
    { preHandler: requireCan("dealCommissions", "update") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      removeBatch(db, id);
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/payout-batches/:id/items",
    { preHandler: requireCan("dealCommissions", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = payoutBatchItemAddSchema.parse(req.body ?? {});
      return { data: addItem(db, id, body, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/payout-batches/:id/items/:itemId",
    { preHandler: requireCan("dealCommissions", "update") },
    async (req) => {
      const { id, itemId } = itemParamSchema.parse(req.params);
      return { data: removeItem(db, id, itemId) };
    },
  );

  app.post(
    "/api/v1/payout-batches/:id/lock",
    { preHandler: requireCan("dealCommissions", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      return { data: lockBatch(db, id, auditCtx(req)) };
    },
  );

  app.post(
    "/api/v1/payout-batches/:id/unlock",
    { preHandler: requireCan("dealCommissions", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      return { data: unlockBatch(db, id, auditCtx(req)) };
    },
  );

  app.post(
    "/api/v1/payout-batches/:id/mark-paid",
    { preHandler: requireCan("dealCommissions", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const { detail, marked, skipped } = markBatchPaid(db, id, auditCtx(req));
      return { data: detail, meta: { marked, skipped } };
    },
  );
}
