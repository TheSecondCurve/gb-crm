// K20 SPA fallback：NODE_ENV=production 时同一 Fastify 进程托管 apps/web/dist。
// 已存在的静态文件按路径提供；非 /api/* 且非静态文件的 GET → index.html；
// /api/* 的 404 与非 GET 的 404 仍走统一 JSON 错误信封（见 error-handler）。
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

import { notFoundEnvelope, type NotFoundHandler } from "./error-handler.js";

/** 默认 dist：按仓库布局 <repo>/apps/web/dist 推导（Docker 内保持同一布局） */
export const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../../web/dist", import.meta.url));

/**
 * 生产 404 分流（注入 error-handler 的 options.notFound）：
 * 非 /api/* 的 GET → index.html；其余（/api/*、非 GET）→ JSON 错误信封。
 * reply.sendFile 由下方注册的 @fastify/static 提供（请求时已完成插件加载）。
 */
export const spaNotFoundHandler: NotFoundHandler = (req, reply) => {
  if (req.method === "GET" && !req.url.startsWith("/api/")) {
    return reply.sendFile("index.html");
  }
  return notFoundEnvelope(req, reply);
};

/** 托管 webDist 下的静态文件；已存在文件由 @fastify/static 直接提供，不经过 404 */
export function registerStaticSpa(app: FastifyInstance, webDist: string): void {
  void app.register(fastifyStatic, { root: webDist });
}
