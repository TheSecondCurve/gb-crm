import { z } from "zod";

import { copyDimensionSchema, type CopyAuditVerdict } from "../enums.js";
import { epochMsSchema, pageQuerySchema, queryBooleanSchema } from "./common.js";

// K60 文案工作台：提示词模板词表（copy_templates）+ 已保存文案（copy_items）。
// 「选模板」是前端行为（把模板 content 填入输入框），generate/audit/review 只收最终文本快照，
// 服务端不解析模板 id——历史文案不受模板改动影响。
// K60 迭代：generate/audit/review 的 system prompt 由 system_configs code='copywritingPrompts'
// 统一管理（内置默认见 api prompts.ts），请求体 systemPrompt/reviewPrompt 可临时覆盖。

const TEMPLATE_NAME_MAX = 50;
const TEMPLATE_CONTENT_MAX = 4000;
const ITEM_TITLE_MAX = 100;
const DIMENSION_TEXT_MAX = 4000;
const ITEM_CONTENT_MAX = 20000;
/** 系统/审计/逆向检查提示词快照长度上限（K60 迭代） */
const PROMPT_TEXT_MAX = 4000;

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
/** 提示词文本快照（K60 迭代：generate/audit 的 systemPrompt、review 的 reviewPrompt） */
const promptText = z.string().trim().min(1).max(PROMPT_TEXT_MAX).optional();

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

/** 生成文案（K60）：六段文本，topic 必填，其余可空（空段不进 prompt）；
 * systemPrompt 可传自定义系统提示词快照，缺省用内置默认（copy_templates is_builtin=1 行）。 */
export const copyGenerateBodySchema = z.object({
  background: dimensionText,
  audience: dimensionText,
  topic: z.string().trim().min(1).max(DIMENSION_TEXT_MAX),
  goal: dimensionText,
  outputType: dimensionText,
  polish: dimensionText,
  systemPrompt: promptText,
});
export type CopyGenerateBody = z.infer<typeof copyGenerateBodySchema>;

/** 用户视角审计（K60）：content 必填，六段上下文可空；systemPrompt 同 generate */
export const copyAuditBodySchema = z.object({
  ...dimensionSnapshotShape,
  content: z.string().trim().min(1).max(ITEM_CONTENT_MAX),
  systemPrompt: promptText,
});
export type CopyAuditBody = z.infer<typeof copyAuditBodySchema>;

/** 逆向检查（K60 迭代）：生成后第二轮 LLM 审修——检查文本并执行一轮修改，修订稿才是产出；
 * content 必填（待审稿），title 可空（修订稿标题缺省沿用输入标题）；
 * reviewPrompt 可传自定义逆向检查提示词快照，缺省用内置默认。 */
export const copyReviewBodySchema = z.object({
  ...dimensionSnapshotShape,
  title: z.string().trim().min(1).max(ITEM_TITLE_MAX).nullable().optional(),
  content: z.string().trim().min(1).max(ITEM_CONTENT_MAX),
  reviewPrompt: promptText,
});
export type CopyReviewBody = z.infer<typeof copyReviewBodySchema>;

/** 生成 / 逆向检查的共同返回契约：LLM 产出的标题 + 正文（修订稿为最终产出） */
export interface CopyGenerateResult {
  title: string;
  content: string;
}
export type CopyReviewResult = CopyGenerateResult;

/** 审计报告结构（API 返回 / 前端渲染 / copy_items.audit_report 快照的共同契约） */
export interface CopyAuditReport {
  verdict: CopyAuditVerdict;
  summary: string;
  issues: { aspect: string; detail: string; suggestion: string }[];
}
