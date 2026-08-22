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
  // K48：行业（画像与 AI 打标输入）
  industry: nullableText.optional(),
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
  // 标签（K45）：缺席=不动；[]=清空；[ids]=事务内整表替换
  tagIds: idArraySchema.optional(),
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
  // K45：按标签筛选（单值等值，UI 一个下拉）
  tagId: z.coerce.number().int().positive().optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

/** K51 批量打标任务结果（存入 background_jobs.result）：逐客户串行，LLM 失败收集明细 */
export const tagFailureSchema = z.object({
  customerId: z.number().int(),
  nickname: z.string(),
  message: z.string(),
});
export type TagFailure = z.infer<typeof tagFailureSchema>;

export const bulkTagGenerateResultSchema = z.object({
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  failures: z.array(tagFailureSchema).default([]),
  /** K51：任务被取消时提前结束（isCancelled 回调触发） */
  cancelled: z.boolean().default(false),
});
export type BulkTagGenerateResult = z.infer<typeof bulkTagGenerateResultSchema>;
