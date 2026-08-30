// buildApp() 不 listen，测试用 app.inject()（K3）。
// PR 4：注册 helmet / 签名 cookie / 限流（仅 login）/ session-auth / 统一错误信封 / auth 路由。
// PR 14：NODE_ENV=production 时注册 static-spa（托管 apps/web/dist + SPA fallback，K20）。
// env 与 db 由调用方注入（生产 index.ts 用真实 env+db，测试注入临时库与假时钟）。
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { Db } from "./db/client.js";
import type { AppEnv } from "./env.js";
import { authRoutes } from "./modules/auth/routes.js";
import { agentRoutes } from "./modules/agent/routes.js";
import { channelsRoutes } from "./modules/channels/routes.js";
import { customersRoutes } from "./modules/customers/routes.js";
import { customerRecordsRoutes } from "./modules/customer-records/routes.js";
import { dealsRoutes } from "./modules/deals/routes.js";
import { deliveriesRoutes } from "./modules/deliveries/routes.js";
import { productsRoutes } from "./modules/products/routes.js";
import { jobsRoutes } from "./modules/jobs/routes.js";
import { jobSchedulesRoutes } from "./modules/jobs/schedule-routes.js";
import { materialsRoutes } from "./modules/materials/routes.js";
import { systemRoutes } from "./modules/system/routes.js";
import { tagsRoutes } from "./modules/tags/routes.js";
import { usersRoutes, type UsersRoutesOptions } from "./modules/users/routes.js";
import { registerCookie } from "./plugins/cookie.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { sessionAuth } from "./plugins/session-auth.js";
import { DEFAULT_WEB_DIST, registerStaticSpa, spaNotFoundHandler } from "./plugins/static-spa.js";

export interface BuildAppOptions extends FastifyServerOptions {
  env: AppEnv;
  db: Db;
  /** 时钟注入（epoch 毫秒）；默认 Date.now() */
  now?: () => number;
  /** 登录限流上限（/min/IP），默认 10；测试可调小 */
  rateLimitMax?: number;
  /** 带 cookie 请求的 GC 概率，默认 1%（K29） */
  gcProbability?: number;
  /** 密码 hash 函数注入（users 模块；测试可用降参数 argon2 提速） */
  hashFn?: UsersRoutesOptions["hashFn"];
  /** K46：LLM 客户端 fetch 注入（AI 打标测试 mock）；默认全局 fetch */
  llmFetch?: typeof fetch;
  /** K53：S3 客户端 fetch 注入（远程备份/连通性测试 mock）；默认全局 fetch */
  s3Fetch?: typeof fetch;
  /** 生产静态资源目录覆盖（默认 env.WEB_DIST ?? 仓库布局推导）；仅 NODE_ENV=production 生效 */
  webDist?: string;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { env, db, now, rateLimitMax, gcProbability, hashFn, llmFetch, s3Fetch, webDist, ...serverOptions } =
    options;
  const clock = now ?? (() => Date.now());

  const app = fastify({
    logger: false,
    // TRUST_PROXY=true（生产在 Caddy 后必须设）时才信 X-Forwarded-For；
    // 未开时用 socket IP。禁止未信任代理时读 XFF（可伪造）——Fastify 会按此选项决定 request.ip。
    trustProxy: env.TRUST_PROXY,
    ...serverOptions,
  });

  // K20：仅生产托管 apps/web/dist（SPA fallback）；开发期走 Vite :5173 + 代理。
  // 404 只能注册一次，故生产时把 SPA 分流注入 error-handler。
  const production = env.NODE_ENV === "production";
  registerErrorHandler(app, production ? { notFound: spaNotFoundHandler } : {});
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
    usersRoutes(instance, { db, now: clock, hashFn });
    channelsRoutes(instance, { db, now: clock });
    productsRoutes(instance, { db, now: clock });
    customersRoutes(instance, { db, now: clock, llmFetch });
    customerRecordsRoutes(instance, { db, now: clock });
    dealsRoutes(instance, { db, now: clock });
    deliveriesRoutes(instance, { db, now: clock });
    tagsRoutes(instance, { db, now: clock });
    materialsRoutes(instance, { db, now: clock });
    systemRoutes(instance, { db, now: clock, s3Fetch });
    jobsRoutes(instance, { db, now: clock });
    jobSchedulesRoutes(instance, { db, now: clock });
    agentRoutes(instance, { db });
    done();
  });

  if (production) {
    registerStaticSpa(app, webDist ?? env.WEB_DIST ?? DEFAULT_WEB_DIST);
  }

  return app;
}
