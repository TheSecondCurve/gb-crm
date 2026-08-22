// /api/v1/deliverables 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// RBAC（K43）：assistant 只读（list/read）；交付项与动作清单的写操作均 requireCan("deliverables","update")。
import {
  deliverableListQuerySchema,
  deliverablePatchSchema,
  deliverableWriteSchema,
  deliveryTaskPatchSchema,
  deliveryTaskWriteSchema,
} from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  createDeliverable,
  createTask,
  deleteDeliverable,
  deleteTaskById,
  getDeliverableResult,
  listDeliverablesResult,
  patchDeliverable,
  patchTask,
} from "./service.js";

export interface DeliverablesRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const taskParamSchema = z.object({ id: z.coerce.number().int().positive(), taskId: z.coerce.number().int().positive() });

export function deliverablesRoutes(app: FastifyInstance, opts: DeliverablesRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get("/api/v1/deliverables", { preHandler: requireCan("deliverables", "list") }, async (req) => {
    const query = deliverableListQuerySchema.parse(req.query ?? {});
    const { data, total } = listDeliverablesResult(db, query);
    return { data, meta: listMeta(query.page, query.pageSize, total) };
  });

  app.post(
    "/api/v1/deliverables",
    { preHandler: requireCan("deliverables", "create") },
    async (req, reply) => {
      const body = deliverableWriteSchema.parse(req.body ?? {});
      const data = createDeliverable(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.get("/api/v1/deliverables/:id", { preHandler: requireCan("deliverables", "read") }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return { data: getDeliverableResult(db, id) };
  });

  app.patch(
    "/api/v1/deliverables/:id",
    { preHandler: requireCan("deliverables", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = deliverablePatchSchema.parse(req.body ?? {});
      return { data: patchDeliverable(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/deliverables/:id",
    { preHandler: requireCan("deliverables", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteDeliverable(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );

  // ---- 动作打勾清单（子资源，写权限 = deliverables.update） ----

  app.post(
    "/api/v1/deliverables/:id/tasks",
    { preHandler: requireCan("deliverables", "update") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const body = deliveryTaskWriteSchema.parse(req.body ?? {});
      const data = createTask(db, id, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.patch(
    "/api/v1/deliverables/:id/tasks/:taskId",
    { preHandler: requireCan("deliverables", "update") },
    async (req) => {
      const { id, taskId } = taskParamSchema.parse(req.params);
      const patch = deliveryTaskPatchSchema.parse(req.body ?? {});
      return { data: patchTask(db, id, taskId, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/deliverables/:id/tasks/:taskId",
    { preHandler: requireCan("deliverables", "update") },
    async (req, reply) => {
      const { id, taskId } = taskParamSchema.parse(req.params);
      deleteTaskById(db, id, taskId);
      return reply.code(204).send();
    },
  );
}
