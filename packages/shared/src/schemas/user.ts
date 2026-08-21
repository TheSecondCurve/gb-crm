import { z } from "zod";

import {
  accountStatusSchema,
  employmentStatusSchema,
  jobTitleSchema,
  systemRoleSchema,
} from "../enums.js";
import { pageQuerySchema } from "./common.js";

const nullableText = z.string().nullable();

// 字段与 0000_init.sql users 表列对应（camelCase）。审计 / 软删 / feishu_record_id /
// feishu_user_id / password_hash 不在 API 写路径上（passwordHash 永不出现在 JSON）。
// username 创建时可写，之后只读（改用户名不在 v1）。
export const userWriteSchema = z.object({
  username: z.string().min(1).nullable().optional(),
  nickname: z.string().min(1),
  realName: nullableText.optional(),
  phone: nullableText.optional(),
  wechat: nullableText.optional(),
  jobTitle: jobTitleSchema.default("other"),
  systemRole: systemRoleSchema.nullable().optional(),
  employmentStatus: employmentStatusSchema.default("employed"),
  accountStatus: accountStatusSchema.default("disabled"),
  duties: nullableText.optional(),
  notes: nullableText.optional(),
});
export type UserWrite = z.infer<typeof userWriteSchema>;

// PATCH 内核（K24）：.partial() 只表示键可缺席，不得把缺席键绑默认值；
// ZodOptional 包装后 undefined 短路，默认值不会在 PATCH 上触发。
export const userPatchSchema = userWriteSchema
  .partial()
  .extend({ updatedAt: z.number().int() });
export type UserPatch = z.infer<typeof userPatchSchema>;

export const userSortSchema = z.enum(["updatedAt", "createdAt", "nickname", "username"]);

export const userListQuerySchema = pageQuerySchema.extend({
  sort: userSortSchema.optional(),
  systemRole: systemRoleSchema.optional(),
  accountStatus: accountStatusSchema.optional(),
  employmentStatus: employmentStatusSchema.optional(),
  jobTitle: jobTitleSchema.optional(),
});
export type UserListQuery = z.infer<typeof userListQuerySchema>;
