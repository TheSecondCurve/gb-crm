// /api/v1/customers/:customerId/records 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// RBAC（K55）：assistant 只读（list/read）；create/update/delete 仅 admin/operator。
import {
  maintenanceRecordListQuerySchema,
  maintenanceRecordPatchSchema,
  maintenanceRecordWriteSchema,
} from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  createRecord,
  deleteRecord,
  getRecordResult,
  listRecordsResult,
  patchRecord,
} from "./service.js";

export interface CustomerRecordsRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const customerIdParamSchema = z.object({
  customerId: z.coerce.number().int().positive(),
});
const recordIdParamSchema = z.object({
  customerId: z.coerce.number().int().positive(),
  id: z.coerce.number().int().positive(),
});

export function customerRecordsRoutes(app: FastifyInstance, opts: CustomerRecordsRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get(
    "/api/v1/customers/:customerId/records",
    { preHandler: requireCan("customerRecords", "list") },
    async (req) => {
      const { customerId } = customerIdParamSchema.parse(req.params);
      const query = maintenanceRecordListQuerySchema.parse(req.query ?? {});
      const { data, total } = listRecordsResult(db, customerId, query);
      return { data, meta: listMeta(query.page, query.pageSize, total) };
    },
  );

  app.post(
    "/api/v1/customers/:customerId/records",
    { preHandler: requireCan("customerRecords", "create") },
    async (req, reply) => {
      const { customerId } = customerIdParamSchema.parse(req.params);
      const body = maintenanceRecordWriteSchema.parse(req.body ?? {});
      const data = createRecord(db, customerId, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.get(
    "/api/v1/customers/:customerId/records/:id",
    { preHandler: requireCan("customerRecords", "read") },
    async (req) => {
      const { customerId, id } = recordIdParamSchema.parse(req.params);
      return { data: getRecordResult(db, customerId, id) };
    },
  );

  app.patch(
    "/api/v1/customers/:customerId/records/:id",
    { preHandler: requireCan("customerRecords", "update") },
    async (req) => {
      const { customerId, id } = recordIdParamSchema.parse(req.params);
      const patch = maintenanceRecordPatchSchema.parse(req.body ?? {});
      return { data: patchRecord(db, customerId, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/customers/:customerId/records/:id",
    { preHandler: requireCan("customerRecords", "delete") },
    async (req, reply) => {
      const { customerId, id } = recordIdParamSchema.parse(req.params);
      deleteRecord(db, customerId, id, auditCtx(req));
      return reply.code(204).send();
    },
  );
}
