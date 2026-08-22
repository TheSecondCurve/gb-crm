// /api/v1/tags 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// K45：词表写操作仅 admin（tags.create/update/delete），operator/assistant 只读（list/read）。
import { tagListQuerySchema, tagPatchSchema, tagWriteSchema } from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  createTag,
  deleteTag,
  getTagResult,
  listTagsResult,
  patchTag,
} from "./service.js";

export interface TagsRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function tagsRoutes(app: FastifyInstance, opts: TagsRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get("/api/v1/tags", { preHandler: requireCan("tags", "list") }, async (req) => {
    const query = tagListQuerySchema.parse(req.query ?? {});
    const { data, total } = listTagsResult(db, query);
    return { data, meta: listMeta(query.page, query.pageSize, total) };
  });

  app.post(
    "/api/v1/tags",
    { preHandler: requireCan("tags", "create") },
    async (req, reply) => {
      const body = tagWriteSchema.parse(req.body ?? {});
      const data = createTag(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.get("/api/v1/tags/:id", { preHandler: requireCan("tags", "read") }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return { data: getTagResult(db, id) };
  });

  app.patch(
    "/api/v1/tags/:id",
    { preHandler: requireCan("tags", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = tagPatchSchema.parse(req.body ?? {});
      return { data: patchTag(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/tags/:id",
    { preHandler: requireCan("tags", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteTag(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );
}
