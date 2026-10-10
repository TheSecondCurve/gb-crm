// /api/v1/material-folders 路由（K63）。
// 权限复用 materials 资源：写 = create/update/delete，读 = list（assistant 只读继承）。
import {
  materialFolderPatchSchema,
  materialFolderWriteSchema,
} from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { requireCan } from "../../plugins/rbac.js";
import { createFolder, deleteFolder, getFolderResult, listFoldersResult, patchFolder } from "./folder-service.js";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function materialFolderRoutes(
  app: FastifyInstance,
  opts: { db: Db; now: () => number },
): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  // 文件夹量级小：全量返回不分类（树形展示/路径推导由前端拼）
  app.get(
    "/api/v1/material-folders",
    { preHandler: requireCan("materials", "list") },
    async () => listFoldersResult(db),
  );

  app.get(
    "/api/v1/material-folders/:id",
    { preHandler: requireCan("materials", "read") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      return { data: getFolderResult(db, id) };
    },
  );

  app.post(
    "/api/v1/material-folders",
    { preHandler: requireCan("materials", "create") },
    async (req, reply) => {
      const body = materialFolderWriteSchema.parse(req.body ?? {});
      const data = createFolder(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.patch(
    "/api/v1/material-folders/:id",
    { preHandler: requireCan("materials", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = materialFolderPatchSchema.parse(req.body ?? {});
      return { data: patchFolder(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/material-folders/:id",
    { preHandler: requireCan("materials", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteFolder(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );
}
