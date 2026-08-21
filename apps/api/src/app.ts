// buildApp() 不 listen，测试用 app.inject()（K3）。
// PR 4：注册 helmet / 签名 cookie / 限流（仅 login）/ session-auth / 统一错误信封 / auth 路由。
// env 与 db 由调用方注入（生产 index.ts 用真实 env+db，测试注入临时库与假时钟）。
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { Db } from "./db/client.js";
import type { AppEnv } from "./env.js";
import { authRoutes } from "./modules/auth/routes.js";
import { registerCookie } from "./plugins/cookie.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { sessionAuth } from "./plugins/session-auth.js";

export interface BuildAppOptions extends FastifyServerOptions {
  env: AppEnv;
  db: Db;
  /** 时钟注入（epoch 秒）；默认 Date.now() */
  now?: () => number;
  /** 登录限流上限（/min/IP），默认 10；测试可调小 */
  rateLimitMax?: number;
  /** 带 cookie 请求的 GC 概率，默认 1%（K29） */
  gcProbability?: number;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { env, db, now, rateLimitMax, gcProbability, ...serverOptions } = options;
  const clock = now ?? (() => Math.floor(Date.now() / 1000));

  const app = fastify({
    logger: false,
    // TRUST_PROXY=true（生产在 Caddy 后必须设）时才信 X-Forwarded-For；
    // 未开时用 socket IP。禁止未信任代理时读 XFF（可伪造）——Fastify 会按此选项决定 request.ip。
    trustProxy: env.TRUST_PROXY,
    ...serverOptions,
  });

  registerErrorHandler(app);
  void app.register(helmet);
  registerCookie(app, env.SESSION_SECRET);
  // 限流仅挂 login 路由（global: false + 路由 config.rateLimit）；键为 request.ip（尊重 trustProxy）
  void app.register(rateLimit, { global: false });

  // 钩子须在路由注册之前挂上（root scope）
  sessionAuth(app, { db, now: clock, cookieSecure: env.COOKIE_SECURE, gcProbability });

  // 路由放进 register 插件：avvio 保证在 rate-limit 的 onRoute 钩子等插件逻辑就绪后才注册路由，
  // 否则同步注册的路由吃不到 config.rateLimit / helmet。
  void app.register((instance, _opts, done) => {
    instance.get("/api/v1/health", async () => ({ data: { ok: true } }));
    authRoutes(instance, { db, env, now: clock, rateLimitMax });
    done();
  });

  return app;
}
