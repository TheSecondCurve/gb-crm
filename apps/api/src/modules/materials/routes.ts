// /api/v1/materials 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// K54：admin/operator 全量，assistant 只读（list/read）——由 shared can() 驱动。
import { materialListQuerySchema, materialPatchSchema, materialWriteSchema } from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  createMaterial,
  deleteMaterial,
  getMaterialResult,
  listMaterialsResult,
  patchMaterial,
} from "./service.js";

export interface MaterialsRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function materialsRoutes(app: FastifyInstance, opts: MaterialsRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get(
    "/api/v1/materials",
    { preHandler: requireCan("materials", "list") },
    async (req) => {
      const query = materialListQuerySchema.parse(req.query ?? {});
      const { data, total } = listMaterialsResult(db, query);
      return { data, meta: listMeta(query.page, query.pageSize, total) };
    },
  );

  app.post(
    "/api/v1/materials",
    { preHandler: requireCan("materials", "create") },
    async (req, reply) => {
      const body = materialWriteSchema.parse(req.body ?? {});
      const data = createMaterial(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.get(
    "/api/v1/materials/:id",
    { preHandler: requireCan("materials", "read") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      return { data: getMaterialResult(db, id) };
    },
  );

  app.patch(
    "/api/v1/materials/:id",
    { preHandler: requireCan("materials", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = materialPatchSchema.parse(req.body ?? {});
      return { data: patchMaterial(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/materials/:id",
    { preHandler: requireCan("materials", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteMaterial(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );
}
