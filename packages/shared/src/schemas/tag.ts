import { z } from "zod";

import { tagDomainSchema, tagScopeSchema } from "../enums.js";
import { epochMsSchema, pageQuerySchema } from "./common.js";

// K45 标签词表（tags 表，camelCase）。写字段：name / scope / sort / enabled / domain；
// PATCH 内核（K24）走 partial + updatedAt OCC。domain 创建时写入，PATCH 不可改。

export const tagWriteSchema = z.object({
  name: z.string().trim().min(1).max(50),
  scope: tagScopeSchema.default("other"),
  sort: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  /** K58：缺省 customer，与资料词表隔离 */
  domain: tagDomainSchema.default("customer"),
});
export type TagWrite = z.infer<typeof tagWriteSchema>;

export const tagPatchSchema = tagWriteSchema
  .omit({ domain: true })
  .partial()
  .extend({ updatedAt: epochMsSchema });
export type TagPatch = z.infer<typeof tagPatchSchema>;

export const tagSortSchema = z.enum(["updatedAt", "createdAt", "name"]);

export const tagListQuerySchema = pageQuerySchema.extend({
  sort: tagSortSchema.optional(),
  scope: tagScopeSchema.optional(),
  /** 缺省 customer，避免客户页/业务设置混入资料词 */
  domain: tagDomainSchema.default("customer"),
});
export type TagListQuery = z.infer<typeof tagListQuerySchema>;
