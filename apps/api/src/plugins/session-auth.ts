// session-auth 插件（§5 / K5）：
// - 解签名 cookie 得 sessions.id → 查 session → 判定 now < created_at+7d AND now < expires_at，
//   且用户 enabled、未软删、system_role 非空 → 挂 request.user；
// - Touch 节流：仅当 now-last_touched_at >= 30min 或 expires_at-now < 11h 时
//   UPDATE expires_at = min(now+12h, created_at+7d), last_touched_at = now，
//   并刷新 cookie maxAge 为剩余 idle；
// - 带 cookie 的请求以 1% 概率 GC 过期 session（K29）；
// - Authorization: Bearer → 查 api_tokens（hash），不回落到 cookie；
//   read 令牌仅允许 GET/HEAD，以及撤销自己的 DELETE /auth/tokens/:id；
// - 未登录访问 /api/v1/**（除 login / 签发 token / health）→ 401 UNAUTHORIZED。
// 所有时间戳一律 epoch 毫秒；仅 cookie maxAge 按规范用秒（毫秒换算）。
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { SystemRole, TokenScope } from "@gb-crm/shared";

import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import {
  findSessionById,
  gcSessions,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TOUCH_REMAINING_MS,
} from "../modules/auth/session-repo.js";
import type { AuthUser } from "../modules/auth/service.js";
import {
  findTokenByHash,
  hashToken,
  TOKEN_TOUCH_INTERVAL_MS,
  touchTokenLastUsed,
} from "../modules/auth/token-repo.js";
import { SESSION_COOKIE_NAME, setSessionCookie } from "./cookie.js";
import { forbidden, unauthorized } from "./error-handler.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
    /** cookie 会话为 null；Bearer 为令牌范围 */
    tokenScope: TokenScope | null;
  }
}

function isPublicApi(path: string, method: string): boolean {
  if (path === "/api/v1/health") return true;
  if (path === "/api/v1/auth/login") return true;
  if (path === "/api/v1/auth/tokens" && method === "POST") return true;
  return false;
}

/** read 令牌：GET/HEAD，以及撤销自己的 DELETE /api/v1/auth/tokens/:id */
function isReadTokenAllowed(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return true;
  if (method === "DELETE" && /^\/api\/v1\/auth\/tokens\/\d+$/.test(path)) return true;
  return false;
}

function loadAuthUser(db: Db, userId: number): AuthUser | null {
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  if (
    !row ||
    row.deletedAt !== null ||
    row.accountStatus !== "enabled" ||
    row.systemRole === null ||
    row.username === null
  ) {
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    systemRole: row.systemRole as SystemRole,
  };
}

export interface SessionAuthOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒），测试可替换 */
  now: () => number;
  cookieSecure: boolean;
  /** 带 cookie 请求的 GC 概率，默认 1%（测试可注入 1 走确定路径） */
  gcProbability?: number;
}

export function sessionAuth(app: FastifyInstance, opts: SessionAuthOptions): void {
  const { db, now } = opts;
  const gcProbability = opts.gcProbability ?? 0.01;

  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);
  app.decorateRequest("tokenScope", null);

  app.addHook("onRequest", async (req, reply) => {
    req.user = null;
    req.sessionId = null;
    req.tokenScope = null;

    const path = req.url.split("?", 1)[0] ?? req.url;
    if (!path.startsWith("/api/v1/")) return; // 非 API（静态资源/SPA/agent 脚本）不拦截
    if (isPublicApi(path, req.method)) return;

    const t = now();
    const authz = req.headers.authorization;
    if (typeof authz === "string" && authz.length > 0) {
      const match = /^Bearer\s+(\S+)$/.exec(authz);
      if (!match) throw unauthorized();
      const row = findTokenByHash(db, hashToken(match[1]!));
      if (!row || row.revokedAt !== null || !(t < row.expiresAt)) throw unauthorized();
      const user = loadAuthUser(db, row.userId);
      if (!user) throw unauthorized();
      req.user = user;
      req.tokenScope = row.scope as TokenScope;
      if (req.tokenScope === "read" && !isReadTokenAllowed(req.method, path)) {
        throw forbidden("此令牌为只读，无法执行写操作");
      }
      if (row.lastUsedAt === null || t - row.lastUsedAt >= TOKEN_TOUCH_INTERVAL_MS) {
        touchTokenLastUsed(db, row.id, t);
      }
      return;
    }

    const raw = req.cookies[SESSION_COOKIE_NAME];
    if (!raw) throw unauthorized();
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value === null) throw unauthorized(); // 未签名/伪造一律 401

    const session = findSessionById(db, unsigned.value);
    if (!session) throw unauthorized();
    if (!(t < session.createdAt + SESSION_ABSOLUTE_TTL_MS && t < session.expiresAt)) {
      throw unauthorized();
    }

    const user = loadAuthUser(db, session.userId);
    if (!user) throw unauthorized(); // 禁用/软删/角色被剥 → 旧 session 立即失效

    req.user = user;
    req.sessionId = session.id;

    // Touch 节流（K5）：列表轮询不写库
    if (
      t - session.lastTouchedAt >= SESSION_TOUCH_INTERVAL_MS ||
      session.expiresAt - t < SESSION_TOUCH_REMAINING_MS
    ) {
      const newExpiresAt = Math.min(
        t + SESSION_IDLE_TTL_MS,
        session.createdAt + SESSION_ABSOLUTE_TTL_MS,
      );
      db.update(sessions)
        .set({ expiresAt: newExpiresAt, lastTouchedAt: t })
        .where(eq(sessions.id, session.id))
        .run();
      setSessionCookie(reply, session.id, {
        secure: opts.cookieSecure,
        // cookie maxAge 按规范是秒：剩余 idle 毫秒 → 秒
        maxAgeSeconds: Math.floor((newExpiresAt - t) / 1000),
      });
    }

    if (Math.random() < gcProbability) gcSessions(db, t);
  });
}
