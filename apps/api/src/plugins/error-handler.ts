// 统一错误信封 { error: { code, message, details? } }（API / Interface Changes 章节）。
// message 一律中文、可直接 Toast。Zod 校验失败 → 422 VALIDATION。
// 404 也只有一个 handler（Fastify 不允许同前缀重复 setNotFoundHandler）：默认 JSON 信封；
// 生产 SPA fallback 由 app.ts 经 options.notFound 注入（plugins/static-spa.ts，K20）。
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export type ErrorCode =
  | "INVALID_CREDENTIALS"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SQL_ERROR"
  | "INTERNAL";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    /** 信封顶层 data（与 error 同级）；409 CONFLICT 时带当前完整行（API 章节 ErrorEnvelope） */
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const unauthorized = (message = "未登录或会话已失效"): ApiError =>
  new ApiError(401, "UNAUTHORIZED", message);

export const forbidden = (message = "没有权限执行此操作"): ApiError =>
  new ApiError(403, "FORBIDDEN", message);

export const notFound = (message = "资源不存在"): ApiError =>
  new ApiError(404, "NOT_FOUND", message);

export const conflict = (message: string, data?: unknown): ApiError =>
  new ApiError(409, "CONFLICT", message, undefined, data);

export const unprocessable = (message: string, details?: unknown): ApiError =>
  new ApiError(422, "VALIDATION", message, details);

// Fastify 自带错误（限流 429、body 解析 400 等）→ 信封映射；400 统一归并到 422 VALIDATION。
const STATUS_MAP: Record<number, { code: ErrorCode; message: string }> = {
  400: { code: "VALIDATION", message: "请求参数不合法" },
  401: { code: "UNAUTHORIZED", message: "未登录或会话已失效" },
  403: { code: "FORBIDDEN", message: "没有权限执行此操作" },
  404: { code: "NOT_FOUND", message: "资源不存在" },
  409: { code: "CONFLICT", message: "数据已被他人修改，请刷新后重试" },
  422: { code: "VALIDATION", message: "请求参数不合法" },
  429: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" },
};

export type NotFoundHandler = (req: FastifyRequest, reply: FastifyReply) => unknown;

export const notFoundEnvelope: NotFoundHandler = (_req, reply) =>
  reply.code(404).send({ error: { code: "NOT_FOUND", message: "资源不存在" } });

export function registerErrorHandler(
  app: FastifyInstance,
  options: { notFound?: NotFoundHandler } = {},
): void {
  app.setNotFoundHandler(options.notFound ?? notFoundEnvelope);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(422).send({
        error: {
          code: "VALIDATION",
          message: "请求参数不合法",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
        ...(err.data !== undefined ? { data: err.data } : {}),
      });
    }
    const statusCode = getStatusCode(err);
    const mapped = STATUS_MAP[statusCode];
    if (mapped) {
      return reply.code(statusCode).send({ error: { code: mapped.code, message: mapped.message } });
    }
    req.log.error(err);
    return reply
      .code(500)
      .send({ error: { code: "INTERNAL", message: "服务器内部错误" } });
  });
}

function getStatusCode(err: unknown): number {
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    const sc = (err as { statusCode?: unknown }).statusCode;
    if (typeof sc === "number" && sc >= 400) return sc;
  }
  return 500;
}
