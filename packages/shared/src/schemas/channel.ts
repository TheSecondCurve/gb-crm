import { z } from "zod";

import {
  accountTypeSchema,
  channelStatusSchema,
  channelTypeSchema,
  platformSchema,
} from "../enums";
import { pageQuerySchema } from "./common";

const nullableText = z.string().nullable();

const idArraySchema = z.array(z.number().int().positive());

// 渠道密钥字段（K27）：assistant GET 置 null、不可 PATCH 这些键
export const CHANNEL_SECRET_KEYS = [
  "accountId",
  "registerPhone",
  "registrant",
  "realNamePerson",
  "loginDevice",
] as const;

// 字段与 0000_init.sql channels 表列对应（camelCase）。
export const channelWriteSchema = z.object({
  name: z.string().min(1),
  description: nullableText.optional(),
  accountId: nullableText.optional(),
  registerPhone: nullableText.optional(),
  registrant: nullableText.optional(),
  realNamePerson: nullableText.optional(),
  loginDevice: nullableText.optional(),
  notes: nullableText.optional(),
  platform: platformSchema.default("other"),
  channelType: channelTypeSchema.default("private"),
  accountType: accountTypeSchema.default("public_account"),
  status: channelStatusSchema.default("operating"),
  followerCount: z.number().int().nullable().optional(),
  // channel_owners 关系：缺席=不动；[]=清空
  ownerIds: idArraySchema.optional(),
});
export type ChannelWrite = z.infer<typeof channelWriteSchema>;

export const channelPatchSchema = channelWriteSchema
  .partial()
  .extend({ updatedAt: z.number().int() });
export type ChannelPatch = z.infer<typeof channelPatchSchema>;

export const channelSortSchema = z.enum(["updatedAt", "createdAt", "name"]);

export const channelListQuerySchema = pageQuerySchema.extend({
  sort: channelSortSchema.optional(),
  platform: platformSchema.optional(),
  channelType: channelTypeSchema.optional(),
  accountType: accountTypeSchema.optional(),
  status: channelStatusSchema.optional(),
});
export type ChannelListQuery = z.infer<typeof channelListQuerySchema>;
