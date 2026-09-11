import { z } from "zod";

import { copyDimensionSchema, type CopyAuditVerdict } from "../enums.js";
import { epochMsSchema, pageQuerySchema, queryBooleanSchema } from "./common.js";

// K60 文案工作台：提示词模板词表（copy_templates）+ 已保存文案（copy_items）。
// 「选模板」是前端行为（把模板 content 填入输入框），generate/audit 只收最终文本快照，
// 服务端不解析模板 id——历史文案不受模板改动影响。

const TEMPLATE_NAME_MAX = 50;
const TEMPLATE_CONTENT_MAX = 4000;
const ITEM_TITLE_MAX = 100;
const DIMENSION_TEXT_MAX = 4000;
const ITEM_CONTENT_MAX = 20000;

export const copyTemplateWriteSchema = z.object({
  dimension: copyDimensionSchema,
  name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX),
  content: z.string().trim().min(1).max(TEMPLATE_CONTENT_MAX),
  sort: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});
export type CopyTemplateWrite = z.infer<typeof copyTemplateWriteSchema>;

// PATCH 内核（K24）：.partial() 只表示键可缺席；dimension 创建后不可改。
export const copyTemplatePatchSchema = copyTemplateWriteSchema
  .omit({ dimension: true })
  .partial()
  .extend({ updatedAt: epochMsSchema });
export type CopyTemplatePatch = z.infer<typeof copyTemplatePatchSchema>;

// 词表量级小，不分页；dimension 过滤 + enabled 过滤（前端选择器只拉启用项）。
export const copyTemplateListQuerySchema = z.object({
  dimension: copyDimensionSchema.optional(),
  enabled: queryBooleanSchema.optional(),
});
export type CopyTemplateListQuery = z.infer<typeof copyTemplateListQuerySchema>;

const dimensionText = z.string().trim().min(1).max(DIMENSION_TEXT_MAX).nullable().optional();

// 六段维度快照：保存文案时随文案一起存，之后模板改动不影响历史。
const dimensionSnapshotShape = {
  background: dimensionText,
  audience: dimensionText,
  topic: dimensionText,
  goal: dimensionText,
  outputType: dimensionText,
  polish: dimensionText,
};

export const copyItemWriteSchema = z.object({
  title: z.string().trim().min(1).max(ITEM_TITLE_MAX),
  ...dimensionSnapshotShape,
  content: z.string().trim().min(1).max(ITEM_CONTENT_MAX),
  /** 审计报告 JSON 快照（CopyAuditReport 序列化），未审计可空 */
  auditReport: z.string().max(ITEM_CONTENT_MAX).nullable().optional(),
});
export type CopyItemWrite = z.infer<typeof copyItemWriteSchema>;

export const copyItemPatchSchema = copyItemWriteSchema
  .partial()
  .extend({ updatedAt: epochMsSchema });
export type CopyItemPatch = z.infer<typeof copyItemPatchSchema>;

export const copyItemSortSchema = z.enum(["updatedAt", "createdAt", "title"]);

export const copyItemListQuerySchema = pageQuerySchema.extend({
  sort: copyItemSortSchema.optional(),
});
export type CopyItemListQuery = z.infer<typeof copyItemListQuerySchema>;

/** 生成文案（K60）：六段文本，topic 必填，其余可空（空段不进 prompt） */
export const copyGenerateBodySchema = z.object({
  background: dimensionText,
  audience: dimensionText,
  topic: z.string().trim().min(1).max(DIMENSION_TEXT_MAX),
  goal: dimensionText,
  outputType: dimensionText,
  polish: dimensionText,
});
export type CopyGenerateBody = z.infer<typeof copyGenerateBodySchema>;

/** 用户视角审计（K60）：content 必填，六段上下文可空 */
export const copyAuditBodySchema = z.object({
  ...dimensionSnapshotShape,
  content: z.string().trim().min(1).max(ITEM_CONTENT_MAX),
});
export type CopyAuditBody = z.infer<typeof copyAuditBodySchema>;

/** 审计报告结构（API 返回 / 前端渲染 / copy_items.audit_report 快照的共同契约） */
export interface CopyAuditReport {
  verdict: CopyAuditVerdict;
  summary: string;
  issues: { aspect: string; detail: string; suggestion: string }[];
}
