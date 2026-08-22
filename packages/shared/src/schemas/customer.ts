import { z } from "zod";

import { customerTypeSchema, socialPlatformSchema } from "../enums.js";
import { epochMsSchema, pageQuerySchema } from "./common.js";

const nullableText = z.string().nullable();

const idArraySchema = z.array(z.number().int().positive());

// 字段与 0000_init.sql customers 表列对应（camelCase）。
export const customerWriteSchema = z.object({
  nickname: z.string().min(1),
  realName: nullableText.optional(),
  title: nullableText.optional(),
  phone: nullableText.optional(),
  wechat: nullableText.optional(),
  country: nullableText.optional(),
  city: nullableText.optional(),
  originStory: nullableText.optional(),
  notes: nullableText.optional(),
  customerType: customerTypeSchema.default("customer"),
  wechatOpenid: nullableText.optional(),
  lastFollowedAt: z.number().int().nullable().optional(),
  // 归属人单值（K39）：可空标量，缺席=不动，null=清空
  ownerId: z.number().int().positive().nullable().optional(),
  // 关系数组（K24）：缺席=不动；[]=清空；[ids]=事务内整表替换
  // 社交账号（K41）：值数组 { platform, account }，缺席=不动；[]=清空
  socialAccounts: z
    .array(z.object({ platform: socialPlatformSchema, account: z.string().min(1) }))
    .optional(),
  sourceChannelIds: idArraySchema.optional(),
});
export type CustomerWrite = z.infer<typeof customerWriteSchema>;

// PATCH 内核（K24）：.partial() 只表示键可缺席，实现不得把缺席键绑成 SQL NULL。
export const customerPatchSchema = customerWriteSchema
  .partial()
  .extend({ updatedAt: epochMsSchema });
export type CustomerPatch = z.infer<typeof customerPatchSchema>;

export const customerSortSchema = z.enum(["updatedAt", "createdAt", "nickname"]);

export const customerListQuerySchema = pageQuerySchema.extend({
  sort: customerSortSchema.optional(),
  customerType: customerTypeSchema.optional(),
  ownerId: z.coerce.number().int().positive().optional(),
  channelId: z.coerce.number().int().positive().optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;
