import { z } from "zod";

import { customerTypeSchema, tagSchema } from "../enums.js";
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
  otherSocial: nullableText.optional(),
  wechatChannelsAccount: nullableText.optional(),
  xiaoyuzhouAccount: nullableText.optional(),
  xiaohongshuAccount: nullableText.optional(),
  weiboAccount: nullableText.optional(),
  douyinAccount: nullableText.optional(),
  country: nullableText.optional(),
  city: nullableText.optional(),
  originStory: nullableText.optional(),
  notes: nullableText.optional(),
  customerType: customerTypeSchema.default("customer"),
  wechatOpenid: nullableText.optional(),
  lastFollowedAt: z.number().int().nullable().optional(),
  // 关系数组（K24）：缺席=不动；[]=清空；[ids]=事务内整表替换
  tagCodes: z.array(tagSchema).optional(),
  ownerIds: idArraySchema.optional(),
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
  tag: tagSchema.optional(),
  ownerId: z.coerce.number().int().positive().optional(),
  channelId: z.coerce.number().int().positive().optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;
