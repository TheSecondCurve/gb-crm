// /api/v1/delivery-types / /api/v1/deliveries 路由（§3：routes 只做 Zod、requireCan、HTTP 映射）。
// K44：交付相关（类型/交付单/交付项/任务）统一 requireCan("deliveries", …)，assistant 只读。
import {
  deliverablePatchSchema,
  deliverableWriteSchema,
  deliveryListQuerySchema,
  deliveryPatchSchema,
  deliveryTaskPatchSchema,
  deliveryTaskWriteSchema,
  deliveryTypeListQuerySchema,
  deliveryTypePatchSchema,
  deliveryTypeWriteSchema,
  deliveryWriteSchema,
} from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import { buildCustomersXlsx, CUSTOMER_EXPORT_KEYS } from "../customers/export.js";
import {
  createDeliverable,
  createDelivery,
  createDeliveryType,
  createTask,
  deleteDeliverable,
  deleteDelivery,
  deleteDeliveryType,
  deleteTaskById,
  getDeliveryResult,
  getDeliveryTypeResult,
  listDeliverablesResult,
  listDeliveriesResult,
  listDeliveryCustomersResult,
  listDeliveryTypesResult,
  patchDeliverable,
  patchDelivery,
  patchDeliveryType,
  patchTask,
} from "./service.js";

export interface DeliveriesRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const itemParamSchema = z.object({ id: z.coerce.number().int().positive(), itemId: z.coerce.number().int().positive() });
const taskParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
  taskId: z.coerce.number().int().positive(),
});

// 圈子客户导出按所选字段选列：逗号分隔 key（与 web 字段选择器对齐）；空串 = 全列
const circleCustomerExportQuerySchema = z.object({
  fields: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .refine((keys) => keys.every((k) => CUSTOMER_EXPORT_KEYS.includes(k)), {
      message: "包含未知的导出字段",
    }),
});

export function deliveriesRoutes(app: FastifyInstance, opts: DeliveriesRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  // ---- delivery-types（配置表） ----

  app.get("/api/v1/delivery-types", { preHandler: requireCan("deliveries", "list") }, async (req) => {
    const query = deliveryTypeListQuerySchema.parse(req.query ?? {});
    const { data, total } = listDeliveryTypesResult(db, query);
    return { data, meta: listMeta(query.page, query.pageSize, total) };
  });

  app.post(
    "/api/v1/delivery-types",
    { preHandler: requireCan("deliveries", "create") },
    async (req, reply) => {
      const body = deliveryTypeWriteSchema.parse(req.body ?? {});
      const data = createDeliveryType(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.get("/api/v1/delivery-types/:id", { preHandler: requireCan("deliveries", "read") }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return { data: getDeliveryTypeResult(db, id) };
  });

  app.patch(
    "/api/v1/delivery-types/:id",
    { preHandler: requireCan("deliveries", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = deliveryTypePatchSchema.parse(req.body ?? {});
      return { data: patchDeliveryType(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/delivery-types/:id",
    { preHandler: requireCan("deliveries", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteDeliveryType(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );

  // ---- deliveries（交付单） ----

  app.get("/api/v1/deliveries", { preHandler: requireCan("deliveries", "list") }, async (req) => {
    const query = deliveryListQuerySchema.parse(req.query ?? {});
    const { data, total } = listDeliveriesResult(db, query);
    return { data, meta: listMeta(query.page, query.pageSize, total) };
  });

  app.post(
    "/api/v1/deliveries",
    { preHandler: requireCan("deliveries", "create") },
    async (req, reply) => {
      const body = deliveryWriteSchema.parse(req.body ?? {});
      const data = createDelivery(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.get("/api/v1/deliveries/:id", { preHandler: requireCan("deliveries", "read") }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return { data: getDeliveryResult(db, id) };
  });

  // ---- deliveries/:id/customers（圈子工作台：客户全量表 + Excel 导出） ----

  app.get(
    "/api/v1/deliveries/:id/customers",
    { preHandler: requireCan("deliveries", "read") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      return { data: listDeliveryCustomersResult(db, id) };
    },
  );

  app.get(
    "/api/v1/deliveries/:id/customers/export.xlsx",
    { preHandler: requireCan("deliveries", "read") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const { fields } = circleCustomerExportQuerySchema.parse(req.query ?? {});
      const buf = await buildCustomersXlsx(listDeliveryCustomersResult(db, id), fields);
      const d = new Date(now());
      const pad = (n: number) => String(n).padStart(2, "0");
      const filename = `圈子客户-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.xlsx`;
      return reply
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header(
          "Content-Disposition",
          `attachment; filename="circle-customers.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        )
        .send(buf);
    },
  );

  app.patch(
    "/api/v1/deliveries/:id",
    { preHandler: requireCan("deliveries", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = deliveryPatchSchema.parse(req.body ?? {});
      return { data: patchDelivery(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/deliveries/:id",
    { preHandler: requireCan("deliveries", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteDelivery(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );

  // ---- deliverables（交付项） ----

  app.get("/api/v1/deliveries/:id/items", { preHandler: requireCan("deliveries", "read") }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return { data: listDeliverablesResult(db, id) };
  });

  app.post(
    "/api/v1/deliveries/:id/items",
    { preHandler: requireCan("deliveries", "update") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = deliverableWriteSchema.parse(req.body ?? {});
      const data = createDeliverable(db, id, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.patch(
    "/api/v1/deliveries/:id/items/:itemId",
    { preHandler: requireCan("deliveries", "update") },
    async (req) => {
      const { id, itemId } = itemParamSchema.parse(req.params);
      const patch = deliverablePatchSchema.parse(req.body ?? {});
      return { data: patchDeliverable(db, id, itemId, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/deliveries/:id/items/:itemId",
    { preHandler: requireCan("deliveries", "delete") },
    async (req, reply) => {
      const { id, itemId } = itemParamSchema.parse(req.params);
      deleteDeliverable(db, id, itemId, auditCtx(req));
      return reply.code(204).send();
    },
  );

  // ---- delivery_tasks（动作清单） ----

  app.post(
    "/api/v1/deliveries/:id/items/:itemId/tasks",
    { preHandler: requireCan("deliveries", "update") },
    async (req, reply) => {
      const { id, itemId } = itemParamSchema.parse(req.params);
      const body = deliveryTaskWriteSchema.parse(req.body ?? {});
      const data = createTask(db, id, itemId, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.patch(
    "/api/v1/deliveries/:id/items/:itemId/tasks/:taskId",
    { preHandler: requireCan("deliveries", "update") },
    async (req) => {
      const { id, itemId, taskId } = taskParamSchema.parse(req.params);
      const patch = deliveryTaskPatchSchema.parse(req.body ?? {});
      return { data: patchTask(db, id, itemId, taskId, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/deliveries/:id/items/:itemId/tasks/:taskId",
    { preHandler: requireCan("deliveries", "update") },
    async (req, reply) => {
      const { id, itemId, taskId } = taskParamSchema.parse(req.params);
      deleteTaskById(db, id, itemId, taskId);
      return reply.code(204).send();
    },
  );
}
