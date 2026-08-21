import { z } from "zod";

// docs/design.md §9 / API 章节「共享 Zod 示例」。query 一律 camelCase（K21）。

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(200).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** query string 里的布尔过滤（如 products 的 isPackage）：只接受 "true"/"false" */
export const queryBooleanSchema = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

export type ListEnvelope<T> = {
  data: T[];
  meta: { page: number; pageSize: number; total: number };
};

export const errorCodeSchema = z.enum([
  "INVALID_CREDENTIALS",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "CONFLICT",
  "RATE_LIMITED",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export type ErrorEnvelope = {
  error: {
    code: ErrorCode;
    /** 中文，可直接 Toast */
    message: string;
    details?: unknown;
  };
  /** CONFLICT 时带上当前行 */
  data?: unknown;
};
