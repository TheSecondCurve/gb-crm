// /api/v1/users 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// 全部挂 requireCan（K18）；PATCH 含 systemRole/accountStatus 键时再加 users.updateRole 门槛。
import { can, PASSWORD_MIN_LENGTH, userListQuerySchema, userPatchSchema } from "@gb-crm/shared";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { forbidden } from "../../plugins/error-handler.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  createUser,
  deleteUser,
  getUserResult,
  listUsersResult,
  patchUser,
  setUserPassword,
  userCreateSchema,
  type UsersServiceOptions,
} from "./service.js";

export interface UsersRoutesOptions extends UsersServiceOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const setPasswordSchema = z.object({ password: z.string().min(PASSWORD_MIN_LENGTH) });

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** PATCH 含 systemRole/accountStatus 键 → 还需 users.updateRole（矩阵：仅 admin） */
const requireUpdateRoleWhenRoleKeys: preHandlerHookHandler = async (req) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if ("systemRole" in body || "accountStatus" in body) {
    if (!can(req.user?.systemRole ?? null, "users", "updateRole")) throw forbidden();
  }
};

export function usersRoutes(app: FastifyInstance, opts: UsersRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get("/api/v1/users", { preHandler: requireCan("users", "list") }, async (req) => {
    const query = userListQuerySchema.parse(req.query ?? {});
    const { data, total } = listUsersResult(db, query);
    return { data, meta: listMeta(query.page, query.pageSize, total) };
  });

  app.post("/api/v1/users", { preHandler: requireCan("users", "create") }, async (req, reply) => {
    const body = userCreateSchema.parse(req.body ?? {});
    const data = await createUser(db, body, auditCtx(req), opts);
    return reply.code(201).send({ data });
  });

  app.get("/api/v1/users/:id", { preHandler: requireCan("users", "read") }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return { data: getUserResult(db, id) };
  });

  app.patch(
    "/api/v1/users/:id",
    { preHandler: [requireCan("users", "update"), requireUpdateRoleWhenRoleKeys] },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = userPatchSchema.parse(req.body ?? {});
      return { data: patchUser(db, id, patch, auditCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/users/:id",
    { preHandler: requireCan("users", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteUser(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );

  // 管理员给他人设密码（密码不是表格单元格，走独立端点）
  app.post(
    "/api/v1/users/:id/password",
    { preHandler: requireCan("users", "setPassword") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const { password } = setPasswordSchema.parse(req.body ?? {});
      await setUserPassword(db, id, password, auditCtx(req), opts);
      return reply.code(204).send();
    },
  );
}
