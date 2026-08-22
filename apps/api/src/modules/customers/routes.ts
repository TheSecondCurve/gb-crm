// /api/v1/customers 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// K31：POST 用 customers.create（assistant 403）；PATCH body 含 ownerIds 或
// upsellOwnerIds 键时追加 customers.updateOwners 门槛（assistant 403，值即使是 [] 键存在即拦），
// 对齐 channels 的密钥键预检模式，策略唯一来源仍是 shared.can()。
import {
  can,
  customerListQuerySchema,
  customerPatchSchema,
  customerWriteSchema,
} from "@gb-crm/shared";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { forbidden } from "../../plugins/error-handler.js";
import { requireCan } from "../../plugins/rbac.js";
import { buildCustomersXlsx } from "./export.js";
import {
  createCustomer,
  deleteCustomer,
  exportCustomers,
  getCustomerResult,
  listCustomersResult,
  patchCustomer,
} from "./service.js";

export interface CustomersRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** PATCH 含归属人/升单人键 → 还需 customers.updateOwners（K31：assistant ✗） */
const OWNER_KEYS = ["ownerIds", "upsellOwnerIds"] as const;
const requireUpdateOwnersWhenOwnerKeys: preHandlerHookHandler = async (req) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (OWNER_KEYS.some((key) => key in body)) {
    if (!can(req.user?.systemRole ?? null, "customers", "updateOwners")) throw forbidden();
  }
};

export function customersRoutes(app: FastifyInstance, opts: CustomersRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get("/api/v1/customers", { preHandler: requireCan("customers", "list") }, async (req) => {
    const query = customerListQuerySchema.parse(req.query ?? {});
    const { data, total } = listCustomersResult(db, query);
    return { data, meta: listMeta(query.page, query.pageSize, total) };
  });

  // 导出 Excel：与列表同一 WHERE（含 q/customerType 等筛选），不分页（注册在 /:id 之前）
  app.get(
    "/api/v1/customers/export.xlsx",
    { preHandler: requireCan("customers", "list") },
    async (req, reply) => {
      const query = customerListQuerySchema.parse(req.query ?? {});
      const buf = await buildCustomersXlsx(exportCustomers(db, query));
      const d = new Date(now());
      const pad = (n: number) => String(n).padStart(2, "0");
      const filename = `客户信息-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.xlsx`;
      return reply
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header(
          "Content-Disposition",
          `attachment; filename="customers.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        )
        .send(buf);
    },
  );

  app.post(
    "/api/v1/customers",
    { preHandler: requireCan("customers", "create") },
    async (req, reply) => {
      const body = customerWriteSchema.parse(req.body ?? {});
      const data = createCustomer(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.get("/api/v1/customers/:id", { preHandler: requireCan("customers", "read") }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return { data: getCustomerResult(db, id) };
  });

  app.patch(
    "/api/v1/customers/:id",
    { preHandler: [requireCan("customers", "update"), requireUpdateOwnersWhenOwnerKeys] },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = customerPatchSchema.parse(req.body ?? {});
      return { data: patchCustomer(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/customers/:id",
    { preHandler: requireCan("customers", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteCustomer(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );
}
