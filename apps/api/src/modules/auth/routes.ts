// /api/v1/auth/* 路由（API / Interface Changes 鉴权表）。
// 注意：session-auth 的 onRequest 钩子在路由注册前挂到 root scope，
// login / POST tokens / health 免登录；GET /agent/login.sh 不在 /api/v1 下，钩子不拦。
import {
  adminTokenListQuerySchema,
  changePasswordSchema,
  loginSchema,
  mintTokenSchema,
} from "@gb-crm/shared";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import type { AppEnv } from "../../env.js";
import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { clearSessionCookie, setSessionCookie } from "../../plugins/cookie.js";
import { ApiError, forbidden } from "../../plugins/error-handler.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  createSession,
  deleteSessionById,
  gcSessions,
  SESSION_IDLE_TTL_MS,
} from "./session-repo.js";
import { publicBaseUrl, renderLoginScript, renderLoginScriptPs1 } from "./login-script.js";
import {
  changeOwnPassword,
  getSessionImpersonator,
  listImpersonationTargets,
  LOGIN_FAIL_MESSAGE,
  startImpersonation,
  stopImpersonation,
  verifyLogin,
} from "./service.js";
import { getEffectivePages } from "../system/service.js";
import {
  adminRevokeToken,
  listAdminTokenResult,
  listOwnTokens,
  mintToken,
  revokeOwnToken,
} from "./token-service.js";

const tokenIdParamSchema = z.object({ id: z.coerce.number().int().positive() });
const impersonateIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

// K49：扮演端点仅 cookie session 可用；Bearer PAT 一律 403（PAT 不承载扮演状态）。
const cookieOnly: preHandlerHookHandler = async (req) => {
  if (req.tokenScope !== null) throw forbidden("仅登录会话可切换身份");
};

export interface AuthRoutesOptions {
  db: Db;
  env: AppEnv;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
  /** 登录限流上限（/min/IP），默认 10；测试可调小 */
  rateLimitMax?: number;
}

export function authRoutes(app: FastifyInstance, opts: AuthRoutesOptions): void {
  const { db, env, now } = opts;

  app.post(
    "/api/v1/auth/login",
    {
      config: {
        rateLimit: { max: opts.rateLimitMax ?? 10, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const body = loginSchema.parse(req.body ?? {});
      gcSessions(db, now()); // login 时 GC（K29）

      const user = await verifyLogin(db, body.username, body.password);
      if (!user) throw new ApiError(401, "INVALID_CREDENTIALS", LOGIN_FAIL_MESSAGE);

      const session = createSession(db, {
        userId: user.id,
        now: now(),
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      setSessionCookie(reply, session.id, {
        secure: env.COOKIE_SECURE,
        maxAgeSeconds: SESSION_IDLE_TTL_MS / 1000, // cookie 规范用秒；idle TTL 与服务器 expires_at 对齐
      });
      return reply.code(204).send();
    },
  );

  app.post("/api/v1/auth/logout", async (req, reply) => {
    if (req.sessionId !== null) deleteSessionById(db, req.sessionId);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/me", async (req) => {
    const user = req.user!;
    // K49：cookie 会话携带扮演发起人信息；Bearer 无会话 → null
    const impersonatedBy =
      req.sessionId !== null ? getSessionImpersonator(db, req.sessionId) : null;
    return {
      data: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        systemRole: user.systemRole,
        impersonatedBy,
        /** 当前角色实际可见的菜单页（安全层 can() ∩ 配置允许集） */
        pages: getEffectivePages(db, user.systemRole),
      },
    };
  });

  // ── K49：admin「扮演用户（act as user）」──
  // targets / start 需 auth.impersonate（仅 admin）+ cookie-only；
  // stop 例外：不查角色，以「当前会话正处于扮演中」为唯一准入——否则扮成 operator/assistant
  // 后（有效角色变弱）将无法自行退出；扮演只能由 admin 发起，故无提权面。
  app.get(
    "/api/v1/auth/impersonate/targets",
    { preHandler: [requireCan("auth", "impersonate"), cookieOnly] },
    async (req) => {
      return { data: listImpersonationTargets(db, req.user!.id) };
    },
  );

  app.post(
    "/api/v1/auth/impersonate/:id",
    { preHandler: [requireCan("auth", "impersonate"), cookieOnly] },
    async (req, reply) => {
      const { id } = impersonateIdParamSchema.parse(req.params);
      startImpersonation(db, {
        sessionId: req.sessionId!,
        adminId: req.user!.id,
        targetId: id,
        now: now(),
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/auth/impersonate/stop",
    { preHandler: cookieOnly },
    async (req, reply) => {
      stopImpersonation(db, { sessionId: req.sessionId!, now: now() });
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/auth/tokens",
    {
      config: {
        rateLimit: { max: opts.rateLimitMax ?? 10, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const body = mintTokenSchema.parse(req.body ?? {});
      const minted = await mintToken(db, {
        username: body.username,
        password: body.password,
        scope: body.scope,
        name: body.name,
        now: now(),
      });
      if (!minted) throw new ApiError(401, "INVALID_CREDENTIALS", LOGIN_FAIL_MESSAGE);
      return reply.code(201).send({ data: minted });
    },
  );

  app.get("/api/v1/auth/tokens", async (req) => {
    return { data: listOwnTokens(db, req.user!.id) };
  });

  app.delete("/api/v1/auth/tokens/:id", async (req, reply) => {
    const { id } = tokenIdParamSchema.parse(req.params);
    revokeOwnToken(db, req.user!.id, id, now());
    return reply.code(204).send();
  });

  // ── 后台「授权管理」（K35 治理；仅 admin：auth.list / auth.revoke）──
  app.get(
    "/api/v1/auth/tokens/admin",
    { preHandler: requireCan("auth", "list") },
    async (req) => {
      const query = adminTokenListQuerySchema.parse(req.query ?? {});
      const { data, total } = listAdminTokenResult(db, query, now());
      return { data, meta: listMeta(query.page, query.pageSize, total) };
    },
  );

  app.delete(
    "/api/v1/auth/tokens/admin/:id",
    { preHandler: requireCan("auth", "revoke") },
    async (req, reply) => {
      const { id } = tokenIdParamSchema.parse(req.params);
      adminRevokeToken(db, id, req.user!.id, now());
      return reply.code(204).send();
    },
  );

  app.get("/agent/login.sh", async (req, reply) => {
    const script = renderLoginScript(publicBaseUrl(req));
    return reply
      .header("Content-Type", "text/x-shellscript; charset=utf-8")
      .header("Content-Disposition", 'inline; filename="login.sh"')
      .send(script);
  });

  app.get("/agent/login.ps1", async (req, reply) => {
    const script = renderLoginScriptPs1(publicBaseUrl(req));
    return reply
      .header("Content-Type", "text/x-powershell; charset=utf-8")
      .header("Content-Disposition", 'inline; filename="login.ps1"')
      .send(script);
  });

  app.patch("/api/v1/auth/password", async (req, reply) => {
    const body = changePasswordSchema.parse(req.body ?? {});
    const ok = await changeOwnPassword(db, {
      userId: req.user!.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      now: now(),
    });
    if (!ok) throw new ApiError(401, "INVALID_CREDENTIALS", "当前密码错误");
    // 改密后该用户全部 session（含当前）已删；清 cookie，客户端重新登录
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
