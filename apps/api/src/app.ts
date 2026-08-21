// buildApp() 不 listen，测试用 app.inject()（K3）。
// PR 3 空壳：仅 health 路由；cookie/session/rbac/static-spa 等插件在后续 PR 注册。
import fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = fastify({ logger: false, ...options });

  app.get("/api/v1/health", async () => ({ data: { ok: true } }));

  return app;
}
