import { z } from "zod";

import {
  deliveryTypeKindSchema,
  MATERIAL_FILE_KIND,
  MATERIAL_TEXT_KINDS,
  materialKindSchema,
} from "../enums.js";
import { epochMsSchema, pageQuerySchema } from "./common.js";

// K54 交付资料（delivery_materials 表，camelCase）。
// 文本类（transcript/text）content 可空（创建后可在全文编辑器页补写）；媒体类（audio/video/link）url 必填。
// K57：kind=file 对象存储，JSON POST 拒绝（走 multipart 上传接口）。
// 关联可空：deliveryId 可空（孤儿资料），customerIds M2M 0..N（PATCH：缺席不动、[] 清空）。

const materialBaseSchema = z.object({
  kind: materialKindSchema,
  title: z.string().trim().min(1).max(200),
  content: z.string().max(2_000_000).nullish(),
  url: z.string().trim().min(1).max(1000).nullish(),
  deliveryId: z.number().int().positive().nullish(),
  customerIds: z.array(z.number().int().positive()).optional(),
});

export const materialWriteSchema = materialBaseSchema.superRefine((v, ctx) => {
  if (v.kind === MATERIAL_FILE_KIND) {
    ctx.addIssue({
      code: "custom",
      path: ["kind"],
      message: "对象存储类型请通过上传接口创建",
    });
    return;
  }
  const textKind = (MATERIAL_TEXT_KINDS as readonly string[]).includes(v.kind);
  if (!textKind && !v.url) {
    ctx.addIssue({ code: "custom", path: ["url"], message: "媒体类资料必须填写链接" });
  }
});
export type MaterialWrite = z.infer<typeof materialWriteSchema>;

/** 对象存储上传的元信息（multipart 文本字段；kind 固定为 file） */
export const materialUploadMetaSchema = z.object({
  title: z.string().trim().min(1).max(200),
  deliveryId: z.number().int().positive().nullish(),
  customerIds: z.array(z.number().int().positive()).optional(),
});
export type MaterialUploadMeta = z.infer<typeof materialUploadMetaSchema>;

// PATCH 内核（K24）：.partial() 只表示键可缺席；kind↔content/url 组合校验在 service 合并后重跑
export const materialPatchSchema = materialBaseSchema.partial().extend({
  updatedAt: epochMsSchema,
});
export type MaterialPatch = z.infer<typeof materialPatchSchema>;

export const materialSortSchema = z.enum(["updatedAt", "createdAt", "title"]);

export const materialListQuerySchema = pageQuerySchema.extend({
  sort: materialSortSchema.optional(),
  kind: materialKindSchema.optional(),
  deliveryId: z.coerce.number().int().positive().optional(),
  customerId: z.coerce.number().int().positive().optional(),
  /**
   * 按关联交付的类型 kind 过滤（咨询/活动/圈子/其他）：
   * consulting/activity/circle 只命中对应类型；other = 未关联（无交付或交付软删/类型软删）或类型本身为 other。
   */
  deliveryKind: deliveryTypeKindSchema.optional(),
  /** orphan=1：只看未完整关联的资料（无交付单或无客户） */
  orphan: z.enum(["1"]).optional(),
});
export type MaterialListQuery = z.infer<typeof materialListQuerySchema>;
