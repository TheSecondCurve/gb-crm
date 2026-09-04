// /api/v1/materials 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// K54：admin/operator 全量，assistant 只读（list/read）——由 shared can() 驱动。
// K57：对象存储上传 / 替换 / 预览下载。
import {
  materialListQuerySchema,
  materialPatchSchema,
  materialUploadMetaSchema,
  materialWriteSchema,
} from "@gb-crm/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { unprocessable } from "../../plugins/error-handler.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  contentDisposition,
  MATERIAL_FILE_BODY_LIMIT,
  readMaterialFile,
  replaceMaterialFile,
  uploadMaterialFile,
  type UploadedFile,
} from "./file.js";
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
  /** K57 S3 fetch 注入（测试 mock）；默认全局 fetch */
  s3Fetch?: typeof fetch;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const fileQuerySchema = z.object({
  download: z.enum(["1"]).optional(),
});
const replaceFileFieldsSchema = z.object({
  updatedAt: z.coerce.number().int().positive(),
});

function parseOptionalInt(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t === "" || t === "null") return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n <= 0) {
    throw unprocessable("deliveryId 不合法", [{ path: "deliveryId", message: "必须是正整数" }]);
  }
  return n;
}

function parseIdArray(raw: string | undefined, fieldName: string): number[] | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    throw unprocessable(`${fieldName} 必须是 JSON 数组`, [
      { path: fieldName, message: "必须是 JSON 数组" },
    ]);
  }
  const result = z.array(z.number().int().positive()).safeParse(parsed);
  if (!result.success) {
    throw unprocessable(`${fieldName} 必须是正整数数组`, [
      { path: fieldName, message: "必须是正整数数组" },
    ]);
  }
  return result.data;
}

/** K58 newTagNames：JSON 字符串数组（非数组的合法 JSON → 422） */
function parseNewTagNames(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    throw unprocessable("newTagNames 必须是 JSON 数组", [
      { path: "newTagNames", message: "必须是 JSON 数组" },
    ]);
  }
  const result = z.array(z.string()).safeParse(parsed);
  if (!result.success) {
    throw unprocessable("newTagNames 必须是字符串数组", [
      { path: "newTagNames", message: "必须是字符串数组" },
    ]);
  }
  return result.data;
}

async function readMultipart(
  req: FastifyRequest,
): Promise<{ file: UploadedFile; fields: Record<string, string> }> {
  if (!req.isMultipart()) {
    throw unprocessable("请使用 multipart/form-data 上传文件");
  }
  const fields: Record<string, string> = {};
  let file: UploadedFile | null = null;
  for await (const part of req.parts()) {
    if (part.type === "file") {
      if (file) throw unprocessable("一次只能上传一个文件");
      const buffer = await part.toBuffer();
      file = { buffer, filename: part.filename, contentType: part.mimetype };
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }
  if (!file) throw unprocessable("请选择要上传的文件");
  return { file, fields };
}

export function materialsRoutes(app: FastifyInstance, opts: MaterialsRoutesOptions): void {
  const { db, now, s3Fetch } = opts;
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

  app.post(
    "/api/v1/materials/upload",
    {
      preHandler: requireCan("materials", "create"),
      bodyLimit: MATERIAL_FILE_BODY_LIMIT,
    },
    async (req, reply) => {
      const { file, fields } = await readMultipart(req);
      const meta = materialUploadMetaSchema.parse({
        title: fields.title,
        deliveryId: parseOptionalInt(fields.deliveryId),
        customerIds: parseIdArray(fields.customerIds, "customerIds"),
        tagIds: parseIdArray(fields.tagIds, "tagIds"),
        newTagNames: parseNewTagNames(fields.newTagNames),
      });
      const data = await uploadMaterialFile(db, meta, file, auditCtx(req), { fetchFn: s3Fetch });
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

  app.get(
    "/api/v1/materials/:id/file",
    { preHandler: requireCan("materials", "read") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const { download } = fileQuerySchema.parse(req.query ?? {});
      const file = await readMaterialFile(db, id, { fetchFn: s3Fetch });
      const disposition = file.isImage && download !== "1" ? "inline" : "attachment";
      return reply
        .header("Content-Type", file.contentType)
        .header("Content-Disposition", contentDisposition(disposition, file.filename))
        .header("Cache-Control", "private, max-age=3600")
        .send(file.body);
    },
  );

  app.post(
    "/api/v1/materials/:id/file",
    {
      preHandler: requireCan("materials", "update"),
      bodyLimit: MATERIAL_FILE_BODY_LIMIT,
    },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const { file, fields } = await readMultipart(req);
      const { updatedAt } = replaceFileFieldsSchema.parse({ updatedAt: fields.updatedAt });
      const data = await replaceMaterialFile(db, id, file, updatedAt, auditCtx(req), {
        fetchFn: s3Fetch,
      });
      return { data };
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
      await deleteMaterial(db, id, auditCtx(req), { fetchFn: s3Fetch });
      return reply.code(204).send();
    },
  );
}
