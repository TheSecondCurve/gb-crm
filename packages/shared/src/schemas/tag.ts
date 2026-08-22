import { z } from "zod";

import { tagScopeSchema } from "../enums.js";
import { epochMsSchema, pageQuerySchema } from "./common.js";

// K45 标签词表（tags 表，camelCase）。写字段：name / scope / sort / enabled；
// PATCH 内核（K24）走 partial + updatedAt OCC。

export const tagWriteSchema = z.object({
  name: z.string().trim().min(1).max(50),
  scope: tagScopeSchema.default("other"),
  sort: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});
export type TagWrite = z.infer<typeof tagWriteSchema>;

export const tagPatchSchema = tagWriteSchema.partial().extend({ updatedAt: epochMsSchema });
export type TagPatch = z.infer<typeof tagPatchSchema>;

export const tagSortSchema = z.enum(["updatedAt", "createdAt", "name"]);

export const tagListQuerySchema = pageQuerySchema.extend({
  sort: tagSortSchema.optional(),
  scope: tagScopeSchema.optional(),
});
export type TagListQuery = z.infer<typeof tagListQuerySchema>;
