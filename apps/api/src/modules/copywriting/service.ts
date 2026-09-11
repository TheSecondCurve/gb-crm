// copywriting 业务规则（§3 service 层）：
// - PATCH 内核（K24）：键存在才 SET（null → SET NULL），updatedAt 必带 OCC；
//   changes===0 → 软删 404，否则 409 且 data 带当前完整行；空 patch（仅 updatedAt）→ 422；
// - 模板 name live-unique 按 (dimension,name)：create / PATCH 改名冲突 → 409 带当前 live 行；
//   软删后名字可复用；删除 = 软删（K9）；
// - K60 迭代：generate/audit/review 的 system prompt 统一走 system_configs code='copywritingPrompts'
//   （内置默认 = prompts.ts 女商红线版，null/空串恢复默认）；请求体 systemPrompt/reviewPrompt 可临时覆盖；
// - generate → {title, content}（LLM 产出标题，缺省回退正文首行截断）；
//   review = 逆向检查第二轮审修，修订稿才是产出；
// - generate / audit / review 走 OpenAI 兼容 chatJson：未配置 → 422，上游失败/不可解析 → 502 LLM_ERROR。
import type {
  CopyAuditBody,
  CopyAuditReport,
  CopyGenerateBody,
  CopyGenerateResult,
  CopyItemListQuery,
  CopyItemPatch,
  CopyItemWrite,
  CopyReviewBody,
  CopyReviewResult,
  CopyTemplateListQuery,
  CopyTemplatePatch,
  CopyTemplateWrite,
} from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { chatJson, LlmError } from "../../lib/llm.js";
import { applyScalarPatch } from "../../lib/patch-kernel.js";
import { conflict, llmError, notFound, unprocessable } from "../../plugins/error-handler.js";
import { getAiConfig, getCopywritingPromptsConfig } from "../system/repo.js";
import {
  assembleCopyItem,
  assembleCopyItems,
  assembleCopyTemplate,
  assembleCopyTemplates,
  type CopyItemDto,
  type CopyTemplateDto,
} from "./assemble.js";
import {
  DEFAULT_AUDIT_SYSTEM_PROMPT,
  DEFAULT_GENERATE_SYSTEM_PROMPT,
  DEFAULT_REVIEW_SYSTEM_PROMPT,
} from "./prompts.js";
import {
  getItemRowAny,
  getLiveTemplateByName,
  getTemplateRowAny,
  insertItem,
  insertTemplate,
  listItems,
  listTemplates,
  occUpdateItem,
  occUpdateTemplate,
  softDeleteItem,
  softDeleteTemplate,
  type CopyItemRow,
} from "./repo.js";

// ---------------------------------------------------------------------------
// 模板词表
// ---------------------------------------------------------------------------

export function listCopyTemplatesResult(
  db: Db,
  query: CopyTemplateListQuery,
): { data: CopyTemplateDto[]; total: number } {
  const rows = listTemplates(db, query);
  return { data: assembleCopyTemplates(db, rows), total: rows.length };
}

export function getCopyTemplateResult(db: Db, id: number): CopyTemplateDto {
  const row = getTemplateRowAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("模板不存在");
  return assembleCopyTemplate(db, row);
}

/** 同 dimension live 同名 → 409（data 带冲突的 live 行） */
function assertTemplateNameFree(db: Db, dimension: string, name: string, excludeId?: number): void {
  const existing = getLiveTemplateByName(db, dimension, name, excludeId);
  if (existing) {
    throw conflict(`模板「${name}」已存在`, assembleCopyTemplate(db, existing));
  }
}

export function createCopyTemplate(
  db: Db,
  body: CopyTemplateWrite,
  ctx: AuditContext,
): CopyTemplateDto {
  const { enabled, ...fields } = body;
  assertTemplateNameFree(db, fields.dimension, fields.name);
  const id = insertTemplate(db, {
    ...fields,
    enabled: enabled ? 1 : 0,
    ...createAudit(ctx),
  });
  return assembleCopyTemplate(db, getTemplateRowAny(db, id)!);
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证不是数据列；dimension 创建后不可改，Zod 已 strip） */
const TEMPLATE_PATCHABLE_KEYS = new Set(["name", "content", "sort", "enabled"]);

export function patchCopyTemplate(
  db: Db,
  id: number,
  patch: CopyTemplatePatch,
  ctx: AuditContext,
): CopyTemplateDto {
  const hasField = Object.entries(patch).some(
    ([key, value]) => key !== "updatedAt" && value !== undefined && TEMPLATE_PATCHABLE_KEYS.has(key),
  );
  if (!hasField) {
    throw unprocessable("没有可更新的字段", [{ path: "name", message: "必填" }]);
  }

  const existing = getTemplateRowAny(db, id);
  if (!existing || existing.deletedAt !== null) throw notFound("模板不存在");
  if (patch.name !== undefined) {
    assertTemplateNameFree(db, existing.dimension, patch.name, id);
  }

  const set: Record<string, unknown> = { ...updateAudit(ctx) };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "updatedAt" || value === undefined) continue;
    if (key === "enabled") {
      set.enabled = value ? 1 : 0; // API boolean ↔ 库 0/1
      continue;
    }
    if (!TEMPLATE_PATCHABLE_KEYS.has(key)) continue;
    set[key] = value;
  }

  const changes = occUpdateTemplate(db, id, patch.updatedAt, set);
  if (changes === 0) {
    const row = getTemplateRowAny(db, id);
    if (!row || row.deletedAt !== null) throw notFound("模板不存在");
    throw conflict("数据已被他人修改，请刷新后重试", assembleCopyTemplate(db, row));
  }
  return assembleCopyTemplate(db, getTemplateRowAny(db, id)!);
}

export function deleteCopyTemplate(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteTemplate(db, id, { deletedAt: ctx.now, ...updateAudit(ctx) });
  if (changes === 0) throw notFound("模板不存在");
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

export function listCopyItemsResult(
  db: Db,
  query: CopyItemListQuery,
): { data: CopyItemDto[]; total: number } {
  const { rows, total } = listItems(db, query);
  return { data: assembleCopyItems(db, rows), total };
}

export function getCopyItemResult(db: Db, id: number): CopyItemDto {
  const row = getItemRowAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("文案不存在");
  return assembleCopyItem(db, row);
}

export function createCopyItem(db: Db, body: CopyItemWrite, ctx: AuditContext): CopyItemDto {
  const id = insertItem(db, {
    title: body.title,
    background: body.background ?? null,
    audience: body.audience ?? null,
    topic: body.topic ?? null,
    goal: body.goal ?? null,
    outputType: body.outputType ?? null,
    polish: body.polish ?? null,
    content: body.content,
    auditReport: body.auditReport ?? null,
    ...createAudit(ctx),
  });
  return assembleCopyItem(db, getItemRowAny(db, id)!);
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证） */
const ITEM_PATCHABLE_KEYS = new Set([
  "title",
  "background",
  "audience",
  "topic",
  "goal",
  "outputType",
  "polish",
  "content",
  "auditReport",
]);

export function patchCopyItem(
  db: Db,
  id: number,
  patch: CopyItemPatch,
  ctx: AuditContext,
): CopyItemDto {
  const hasField = Object.entries(patch).some(
    ([key, value]) => key !== "updatedAt" && value !== undefined && ITEM_PATCHABLE_KEYS.has(key),
  );
  if (!hasField) {
    throw unprocessable("没有可更新的字段", [{ path: "title", message: "必填" }]);
  }

  applyScalarPatch<CopyItemRow>(patch, ctx, {
    scalarKeys: ITEM_PATCHABLE_KEYS,
    occUpdate: (set) => occUpdateItem(db, id, patch.updatedAt, set),
    getRowAny: () => getItemRowAny(db, id),
    isDeleted: (row) => row.deletedAt !== null,
    serialize: (row) => assembleCopyItem(db, row),
    notFoundMessage: "文案不存在",
  });
  return assembleCopyItem(db, getItemRowAny(db, id)!);
}

export function deleteCopyItem(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteItem(db, id, { deletedAt: ctx.now, ...updateAudit(ctx) });
  if (changes === 0) throw notFound("文案不存在");
}

// ---------------------------------------------------------------------------
// LLM 生成 / 逆向检查 / 审计
// ---------------------------------------------------------------------------

/** 六段维度中文标签（prompt 拼接顺序固定；空段省略） */
const DIMENSION_LABELS = [
  ["background", "业务背景"],
  ["audience", "目标客群"],
  ["topic", "主题内容"],
  ["goal", "预期目的"],
  ["outputType", "产出类型"],
  ["polish", "润色要求"],
] as const;

function buildDimensionText(body: Record<string, string | null | undefined>): string {
  const parts: string[] = [];
  for (const [key, label] of DIMENSION_LABELS) {
    const value = body[key];
    if (value) parts.push(`${label}：${value}`);
  }
  return parts.join("\n");
}

/** 读取 LLM 配置；未就绪 → 422（与 AI 打标同口径） */
function requireLlmSettings(db: Db): { baseUrl: string; apiKey: string; model: string } {
  const cfg = getAiConfig(db);
  if (!cfg?.apiKey || !cfg?.baseUrl || !cfg?.model) {
    throw unprocessable("请先在「系统设置」配置 LLM 服务", [
      { path: "ai-config", message: "缺少 baseUrl/apiKey/model" },
    ]);
  }
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model };
}

/** 生效 system prompt：请求快照（systemPrompt/reviewPrompt）> copywritingPrompts 配置 >
 *  内置默认（女商红线版，prompts.ts 为最后真相；配置缺失/字段空串 → 默认） */
function effectiveSystemPrompt(
  db: Db,
  kind: "generate" | "audit" | "review",
  snapshot?: string,
): string {
  const trimmed = snapshot?.trim();
  if (trimmed) return trimmed;
  const cfg = getCopywritingPromptsConfig(db);
  if (kind === "generate") return cfg?.generateSystemPrompt ?? DEFAULT_GENERATE_SYSTEM_PROMPT;
  if (kind === "review") return cfg?.reviewSystemPrompt ?? DEFAULT_REVIEW_SYSTEM_PROMPT;
  return cfg?.auditSystemPrompt ?? DEFAULT_AUDIT_SYSTEM_PROMPT;
}

/** LLM 产出的标题：非空字符串用（≤100），否则回退正文首行截断（保存必填，兜底保证可存） */
function pickTitle(raw: unknown, content: string): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 100);
  return (content.split("\n")[0] ?? "").trim().slice(0, 30);
}

/** 生成文案：六段文本 → prompt → {"title","content"}（LLM 产出标题）；temperature 0.7（创作） */
export async function generateCopy(
  db: Db,
  body: CopyGenerateBody,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<CopyGenerateResult> {
  const settings = requireLlmSettings(db);
  let result: Record<string, unknown>;
  try {
    result = await chatJson({
      settings,
      fetchFn: opts.fetchFn,
      temperature: 0.7,
      messages: [
        { role: "system", content: effectiveSystemPrompt(db, "generate", body.systemPrompt) },
        { role: "user", content: buildDimensionText(body) },
      ],
    });
  } catch (err) {
    if (err instanceof LlmError) throw llmError(err.message);
    throw err;
  }
  const content = typeof result.content === "string" ? result.content.trim() : "";
  if (!content) throw llmError("LLM 返回内容无法解析为文案");
  return { title: pickTitle(result.title, content), content };
}

/** 逆向检查（K60 迭代）：第二轮 LLM 审修——检查文本并执行一轮修改，修订稿才是产出；
 * 修订稿标题缺省时沿用输入标题，再兜底正文首行。temperature 0.3（审修偏稳）。 */
export async function reviewCopy(
  db: Db,
  body: CopyReviewBody,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<CopyReviewResult> {
  const settings = requireLlmSettings(db);
  const dimensionText = buildDimensionText(body);
  const userContent =
    (body.title ? `原标题：${body.title}\n` : "") +
    `待审文案：\n${body.content}` +
    (dimensionText ? `\n\n维度上下文：\n${dimensionText}` : "");

  let result: Record<string, unknown>;
  try {
    result = await chatJson({
      settings,
      fetchFn: opts.fetchFn,
      temperature: 0.3,
      messages: [
        { role: "system", content: effectiveSystemPrompt(db, "review", body.reviewPrompt) },
        { role: "user", content: userContent },
      ],
    });
  } catch (err) {
    if (err instanceof LlmError) throw llmError(err.message);
    throw err;
  }
  const content = typeof result.content === "string" ? result.content.trim() : "";
  if (!content) throw llmError("LLM 返回内容无法解析为文案");
  const title =
    typeof result.title === "string" && result.title.trim()
      ? result.title.trim().slice(0, 100)
      : body.title?.trim() || pickTitle(undefined, content);
  return { title, content };
}

/** 用户视角审计：正文 + 维度上下文 → CopyAuditReport（宽松解析兜底）；temperature 0 */
export async function auditCopy(
  db: Db,
  body: CopyAuditBody,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<CopyAuditReport> {
  const settings = requireLlmSettings(db);
  const dimensionText = buildDimensionText(body);
  const userContent =
    `文案正文：\n${body.content}` + (dimensionText ? `\n\n维度上下文：\n${dimensionText}` : "");

  let result: Record<string, unknown>;
  try {
    result = await chatJson({
      settings,
      fetchFn: opts.fetchFn,
      temperature: 0,
      messages: [
        { role: "system", content: effectiveSystemPrompt(db, "audit", body.systemPrompt) },
        { role: "user", content: userContent },
      ],
    });
  } catch (err) {
    if (err instanceof LlmError) throw llmError(err.message);
    throw err;
  }

  // 宽松解析：verdict 非法/缺失 → warn；summary 非字符串 → ""；issues 非数组 → []，
  // 逐项过滤非对象、字段非字符串给 ""
  const verdict =
    result.verdict === "pass" || result.verdict === "warn" || result.verdict === "fail"
      ? result.verdict
      : "warn";
  const summary = typeof result.summary === "string" ? result.summary : "";
  const rawIssues = Array.isArray(result.issues) ? result.issues : [];
  const issues = rawIssues
    .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
    .map((i) => ({
      aspect: typeof i.aspect === "string" ? i.aspect : "",
      detail: typeof i.detail === "string" ? i.detail : "",
      suggestion: typeof i.suggestion === "string" ? i.suggestion : "",
    }));
  return { verdict, summary, issues };
}
