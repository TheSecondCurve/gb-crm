import { z } from "zod";

// docs/design.md §9 / API 章节「共享 Zod 示例」。query 一律 camelCase（K21）。

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(200).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** query 里的逗号分隔正整数列表（tagIds=1,2,3 → [1,2,3]） */
export const csvIdListSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((val, ctx): number[] => {
    const ids: number[] = [];
    for (const part of val.split(",")) {
      const n = Number(part.trim());
      if (part.trim() === "" || !Number.isInteger(n) || n <= 0) {
        ctx.addIssue({ code: "custom", message: "必须是逗号分隔的正整数列表" });
        return [];
      }
      ids.push(n);
    }
    return ids;
  });

/** query 里的逗号分隔名字列表（中英文逗号都可；tagNames=活动,海报 → [活动,海报]） */
export const csvNameListSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform((val) =>
    val
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );

/** query string 里的布尔过滤（如 products 的 isPackage）：只接受 "true"/"false" */
export const queryBooleanSchema = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

export type ListEnvelope<T> = {
  data: T[];
  meta: { page: number; pageSize: number; total: number };
};

/**
 * 全库/JSON 时间戳一律 **epoch 毫秒（UTC）**（docs/design.md Data Model：`created_at INTEGER -- epoch ms UTC`）。
 * 唯一例外：HTTP cookie 的 maxAge 按规范用秒。
 * 用于 PATCH 的行级 OCC updatedAt（K8/K24）。
 */
export const epochMsSchema = z.number().int();

export const errorCodeSchema = z.enum([
  "INVALID_CREDENTIALS",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "CONFLICT",
  "RATE_LIMITED",
  "LLM_ERROR",
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
