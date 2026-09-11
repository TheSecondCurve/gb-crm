// /api/v1/copywriting 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// RBAC（K60）：admin/operator 全量，assistant 只 list/read；generate/audit 按 create 计（写权限）。
import {
  copyAuditBodySchema,
  copyGenerateBodySchema,
  copyItemListQuerySchema,
  copyItemPatchSchema,
  copyItemWriteSchema,
  copyReviewBodySchema,
  copyTemplateListQuerySchema,
  copyTemplatePatchSchema,
  copyTemplateWriteSchema,
} from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  auditCopy,
  createCopyItem,
  createCopyTemplate,
  deleteCopyItem,
  deleteCopyTemplate,
  generateCopy,
  getCopyItemResult,
  listCopyItemsResult,
  listCopyTemplatesResult,
  patchCopyItem,
  patchCopyTemplate,
  reviewCopy,
} from "./service.js";

export interface CopywritingRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
  /** LLM 客户端 fetch 注入（测试 mock）；默认全局 fetch */
  llmFetch?: typeof fetch;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function copywritingRoutes(app: FastifyInstance, opts: CopywritingRoutesOptions): void {
  const { db, now, llmFetch } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  // -------------------------------------------------------------------------
  // 模板词表（不分页）
  // -------------------------------------------------------------------------

  app.get(
    "/api/v1/copywriting/templates",
    { preHandler: requireCan("copywriting", "list") },
    async (req) => {
      const query = copyTemplateListQuerySchema.parse(req.query ?? {});
      const { data, total } = listCopyTemplatesResult(db, query);
      return { data, meta: { page: 1, pageSize: total, total } };
    },
  );

  app.post(
    "/api/v1/copywriting/templates",
    { preHandler: requireCan("copywriting", "create") },
    async (req, reply) => {
      const body = copyTemplateWriteSchema.parse(req.body ?? {});
      const data = createCopyTemplate(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.patch(
    "/api/v1/copywriting/templates/:id",
    { preHandler: requireCan("copywriting", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = copyTemplatePatchSchema.parse(req.body ?? {});
      return { data: patchCopyTemplate(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/copywriting/templates/:id",
    { preHandler: requireCan("copywriting", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteCopyTemplate(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // LLM 生成 / 审计
  // -------------------------------------------------------------------------

  app.post(
    "/api/v1/copywriting/generate",
    { preHandler: requireCan("copywriting", "create") },
    async (req) => {
      const body = copyGenerateBodySchema.parse(req.body ?? {});
      const data = await generateCopy(db, body, { fetchFn: llmFetch });
      return { data };
    },
  );

  app.post(
    "/api/v1/copywriting/audit",
    { preHandler: requireCan("copywriting", "create") },
    async (req) => {
      const body = copyAuditBodySchema.parse(req.body ?? {});
      const data = await auditCopy(db, body, { fetchFn: llmFetch });
      return { data };
    },
  );

  // K60 迭代：逆向检查——生成后第二轮 LLM 审修（检查文本并执行一轮修改，修订稿才是产出）
  app.post(
    "/api/v1/copywriting/review",
    { preHandler: requireCan("copywriting", "create") },
    async (req) => {
      const body = copyReviewBodySchema.parse(req.body ?? {});
      const data = await reviewCopy(db, body, { fetchFn: llmFetch });
      return { data };
    },
  );

  // -------------------------------------------------------------------------
  // 文案
  // -------------------------------------------------------------------------

  app.get(
    "/api/v1/copywriting/items",
    { preHandler: requireCan("copywriting", "list") },
    async (req) => {
      const query = copyItemListQuerySchema.parse(req.query ?? {});
      const { data, total } = listCopyItemsResult(db, query);
      return { data, meta: listMeta(query.page, query.pageSize, total) };
    },
  );

  app.post(
    "/api/v1/copywriting/items",
    { preHandler: requireCan("copywriting", "create") },
    async (req, reply) => {
      const body = copyItemWriteSchema.parse(req.body ?? {});
      const data = createCopyItem(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.get(
    "/api/v1/copywriting/items/:id",
    { preHandler: requireCan("copywriting", "read") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      return { data: getCopyItemResult(db, id) };
    },
  );

  app.patch(
    "/api/v1/copywriting/items/:id",
    { preHandler: requireCan("copywriting", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = copyItemPatchSchema.parse(req.body ?? {});
      return { data: patchCopyItem(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/copywriting/items/:id",
    { preHandler: requireCan("copywriting", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteCopyItem(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );
}
