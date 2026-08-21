// session-auth 插件（§5 / K5）：
// - 解签名 cookie 得 sessions.id → 查 session → 判定 now < created_at+7d AND now < expires_at，
//   且用户 enabled、未软删、system_role 非空 → 挂 request.user；
// - Touch 节流：仅当 now-last_touched_at >= 30min 或 expires_at-now < 11h 时
//   UPDATE expires_at = min(now+12h, created_at+7d), last_touched_at = now，
//   并刷新 cookie maxAge 为剩余 idle；
// - 带 cookie 的请求以 1% 概率 GC 过期 session（K29）；
// - 未登录访问 /api/v1/**（除 /auth/login、health）→ 401 UNAUTHORIZED。
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { SystemRole } from "@gb-crm/shared";

import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import {
  findSessionById,
  gcSessions,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
  SESSION_TOUCH_INTERVAL_SECONDS,
  SESSION_TOUCH_REMAINING_SECONDS,
} from "../modules/auth/session-repo.js";
import type { AuthUser } from "../modules/auth/service.js";
import { SESSION_COOKIE_NAME, setSessionCookie } from "./cookie.js";
import { unauthorized } from "./error-handler.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
  }
}

/** 免登录路径（均在 /api/v1 前缀下） */
const PUBLIC_PATHS = new Set(["/api/v1/health", "/api/v1/auth/login"]);

export interface SessionAuthOptions {
  db: Db;
  /** 时钟注入（epoch 秒），测试可替换 */
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

  app.addHook("onRequest", async (req, reply) => {
    req.user = null;
    req.sessionId = null;

    const path = req.url.split("?", 1)[0] ?? req.url;
    if (!path.startsWith("/api/v1/")) return; // 非 API（未来静态资源/SPA）不拦截
    if (PUBLIC_PATHS.has(path)) return;

    const t = now();
    const raw = req.cookies[SESSION_COOKIE_NAME];
    if (!raw) throw unauthorized();
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value === null) throw unauthorized(); // 未签名/伪造一律 401

    const session = findSessionById(db, unsigned.value);
    if (!session) throw unauthorized();
    if (!(t < session.createdAt + SESSION_ABSOLUTE_TTL_SECONDS && t < session.expiresAt)) {
      throw unauthorized();
    }

    const row = db.select().from(users).where(eq(users.id, session.userId)).get();
    if (
      !row ||
      row.deletedAt !== null ||
      row.accountStatus !== "enabled" ||
      row.systemRole === null ||
      row.username === null
    ) {
      throw unauthorized(); // 禁用/软删/角色被剥 → 旧 session 立即失效
    }

    req.user = {
      id: row.id,
      username: row.username,
      nickname: row.nickname,
      systemRole: row.systemRole as SystemRole,
    };
    req.sessionId = session.id;

    // Touch 节流（K5）：列表轮询不写库
    if (
      t - session.lastTouchedAt >= SESSION_TOUCH_INTERVAL_SECONDS ||
      session.expiresAt - t < SESSION_TOUCH_REMAINING_SECONDS
    ) {
      const newExpiresAt = Math.min(
        t + SESSION_IDLE_TTL_SECONDS,
        session.createdAt + SESSION_ABSOLUTE_TTL_SECONDS,
      );
      db.update(sessions)
        .set({ expiresAt: newExpiresAt, lastTouchedAt: t })
        .where(eq(sessions.id, session.id))
        .run();
      setSessionCookie(reply, session.id, {
        secure: opts.cookieSecure,
        maxAgeSeconds: newExpiresAt - t, // 剩余 idle
      });
    }

    if (Math.random() < gcProbability) gcSessions(db, t);
  });
}
