// /api/v1/products 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// RBAC（§6）：assistant 只读（list/read）；create/update/delete 仅 admin/operator。
import { productListQuerySchema, productPatchSchema, productWriteSchema } from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  createProduct,
  deleteProduct,
  getProductResult,
  listProductsResult,
  patchProduct,
} from "./service.js";

export interface ProductsRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function productsRoutes(app: FastifyInstance, opts: ProductsRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get("/api/v1/products", { preHandler: requireCan("products", "list") }, async (req) => {
    const query = productListQuerySchema.parse(req.query ?? {});
    const { data, total } = listProductsResult(db, query);
    return { data, meta: listMeta(query.page, query.pageSize, total) };
  });

  app.post(
    "/api/v1/products",
    { preHandler: requireCan("products", "create") },
    async (req, reply) => {
      const body = productWriteSchema.parse(req.body ?? {});
      const data = createProduct(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.get("/api/v1/products/:id", { preHandler: requireCan("products", "read") }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return { data: getProductResult(db, id) };
  });

  app.patch(
    "/api/v1/products/:id",
    { preHandler: requireCan("products", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = productPatchSchema.parse(req.body ?? {});
      return { data: patchProduct(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/products/:id",
    { preHandler: requireCan("products", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteProduct(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );
}
