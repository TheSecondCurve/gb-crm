// customers 业务规则（§3 service 层）：
// - PATCH 内核用收口后的 lib/patch-kernel.ts（K24）：键存在才 SET；updatedAt 必带 OCC；
//   changes===0 → 软删 404，否则 409 且 data 带当前完整行（含 expansions）；
// - 关系数组（K24）：socialAccounts（K41 值数组）/sourceChannelIds
//   缺席=不动、[]=清空、[values/ids]=事务内整表替换并 bump updated_at；
//   引用的渠道必须存在且未软删，否则 422；socialAccounts.platform 枚举由 Zod 挡 422；
// - 归属人单值（K39）：ownerId 是可空标量，缺席=不动、null=清空，非 null 必须引用 live 用户；
// - wechatOpenid 可空唯一（live 行内）：冲突 → 409；软删后释放可复用（partial unique 兜底）；
// - create：nickname 必填（shared schema 要求 min(1)）；「未命名客户」默认值由 web/导入侧决定，
//   API 不代填；customerType 默认 customer（schema default）。
// - 删除 = 软删，join 行保留（K9/K33）。
import {
  tagScopeSchema,
  type BulkTagGenerateResult,
  type BulkTagJobParams,
  type CustomerListQuery,
  type CustomerPatch,
  type CustomerWrite,
  type TagFailure,
} from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { chatJson, LlmError } from "../../lib/llm.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { applyScalarPatch } from "../../lib/patch-kernel.js";
import { ApiError, conflict, llmError, notFound, unprocessable } from "../../plugins/error-handler.js";
import { assembleDeals } from "../deals/assemble.js";
import {
  countLiveDealsByCustomer,
  lastDealAtByCustomer,
  listLiveDealsByCustomer,
  paidTotalCentsByCustomer,
} from "../deals/repo.js";
import { assembleDeliveries } from "../deliveries/assemble.js";
import { listActiveCircleRowsByCustomer } from "../deliveries/repo.js";
import { assembleMaterials } from "../materials/assemble.js";
import { countLiveMaterialsByCustomer, listLiveMaterialsByCustomer } from "../materials/repo.js";
import { assembleCustomerMaintenanceRecords } from "../customer-records/assemble.js";
import {
  countRecordsByCustomer,
  listRecentRecordsByCustomer,
} from "../customer-records/repo.js";
import { getAiConfig } from "../system/repo.js";
import { findLiveTagIds, getLiveTagByName, insertTag, listEnabledLiveTags, maxTagSort } from "../tags/repo.js";
import {
  assembleCustomer,
  assembleCustomers,
  type CustomerDto,
  type CustomerOverviewDto,
} from "./assemble.js";
import {
  findLiveByWechatOpenid,
  findLiveChannelIds,
  findLiveUserIds,
  getCustomerByIdAny,
  insertCustomer,
  listAllCustomers,
  listCustomerTagRows,
  listCustomers,
  occUpdateCustomer,
  replaceCustomerSocialAccounts,
  replaceCustomerSourceChannels,
  replaceCustomerTags,
  softDeleteCustomer,
  touchCustomer,
  updateCustomerIndustry,
  type CustomerRow,
} from "./repo.js";

// better-sqlite3 事务是同步的；tx 与 Db 的查询接口同构，收窄类型以复用 repo 函数
function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

function assertLiveChannels(db: Db, ids: readonly number[], path: string, label: string): void {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const live = findLiveChannelIds(db, unique);
  const missing = unique.filter((id) => !live.has(id));
  if (missing.length > 0) {
    throw unprocessable(`${label}不存在或已删除`, [
      { path, message: `无效渠道 id: ${missing.join(",")}` },
    ]);
  }
}

/** ownerId 单值校验（K39）：null/缺席跳过；非 null 必须引用 live 用户 */
function assertLiveOwner(db: Db, ownerId: number | null | undefined, path: string): void {
  if (ownerId == null) return;
  if (!findLiveUserIds(db, [ownerId]).has(ownerId)) {
    throw unprocessable("归属人不存在或已删除", [{ path, message: `无效用户 id: ${ownerId}` }]);
  }
}

/** wechatOpenid 可空唯一（live 行内）；冲突 → 409。null/缺席不校验 */
function assertWechatOpenidFree(db: Db, openid: string, excludeId?: number): void {
  if (findLiveByWechatOpenid(db, openid, excludeId)) {
    throw conflict("wechatOpenid 已被其它客户占用");
  }
}

/** 关系键校验（存在才校验；同事务替换在 PATCH 标量成功后执行） */
function assertRelations(db: Db, body: {
  sourceChannelIds?: number[];
  tagIds?: number[];
}): void {
  if (body.sourceChannelIds !== undefined) {
    assertLiveChannels(db, body.sourceChannelIds, "sourceChannelIds", "来源渠道");
  }
  if (body.tagIds !== undefined) {
    const unique = [...new Set(body.tagIds)];
    if (unique.length > 0) {
      const live = findLiveTagIds(db, unique);
      const missing = unique.filter((id) => !live.has(id));
      if (missing.length > 0) {
        throw unprocessable("标签不存在或已删除", [
          { path: "tagIds", message: `无效标签 id: ${missing.join(",")}` },
        ]);
      }
    }
  }
}

/** 关系整表替换（仅处理出现的键；调用方保证在事务内，审计值由调用方注入） */
function replaceRelations(
  db: Db,
  id: number,
  body: {
    socialAccounts?: { platform: string; account: string }[];
    sourceChannelIds?: number[];
    tagIds?: number[];
  },
  audit: { createdAt: number; updatedAt: number; createdBy: number | null; updatedBy: number | null },
): void {
  if (body.socialAccounts !== undefined) {
    replaceCustomerSocialAccounts(db, id, body.socialAccounts, audit);
  }
  if (body.sourceChannelIds !== undefined) {
    replaceCustomerSourceChannels(db, id, body.sourceChannelIds);
  }
  if (body.tagIds !== undefined) {
    replaceCustomerTags(db, id, body.tagIds, { createdAt: audit.createdAt, createdBy: audit.createdBy });
  }
}

export function listCustomersResult(
  db: Db,
  query: CustomerListQuery,
): { data: CustomerDto[]; total: number } {
  const { rows, total } = listCustomers(db, query);
  return { data: assembleCustomers(db, rows), total };
}

export function getCustomerResult(db: Db, id: number): CustomerDto {
  const row = getCustomerByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("客户不存在");
  return assembleCustomer(db, row);
}

/** 导出：与列表同一 WHERE（含筛选），不分页取全部 live 行并展开 */
export function exportCustomers(db: Db, query: CustomerListQuery): CustomerDto[] {
  return assembleCustomers(db, listAllCustomers(db, query));
}

export function createCustomer(db: Db, body: CustomerWrite, ctx: AuditContext): CustomerDto {
  return inTx(db, (tx) => {
    const { socialAccounts, sourceChannelIds, tagIds, ...fields } = body;
    assertRelations(tx, { sourceChannelIds, tagIds });
    assertLiveOwner(tx, fields.ownerId, "ownerId");
    if (fields.wechatOpenid != null) assertWechatOpenidFree(tx, fields.wechatOpenid);

    const id = insertCustomer(tx, { ...fields, ...createAudit(ctx) });
    replaceRelations(tx, id, { socialAccounts, sourceChannelIds, tagIds }, createAudit(ctx));
    return assembleCustomer(tx, getCustomerByIdAny(tx, id)!);
  });
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证；ownerId 单值走标量内核，关系键走整表替换） */
const PATCHABLE_KEYS = new Set([
  "nickname",
  "realName",
  "title",
  "phone",
  "wechat",
  "country",
  "city",
  "industry",
  "originStory",
  "notes",
  "customerType",
  "wechatOpenid",
  "lastFollowedAt",
  "ownerId",
]);

export function patchCustomer(
  db: Db,
  id: number,
  patch: CustomerPatch,
  ctx: AuditContext,
): CustomerDto {
  return inTx(db, (tx) => {
    // 先校验（422 先于任何写入；事务回滚兜底）
    assertRelations(tx, patch);
    assertLiveOwner(tx, patch.ownerId, "ownerId");
    if (patch.wechatOpenid !== undefined && patch.wechatOpenid !== null) {
      assertWechatOpenidFree(tx, patch.wechatOpenid, id);
    }

    // 标量内核：键存在才 SET + 行级 OCC；409 data 带当前完整行（含 expansions）
    applyScalarPatch(patch, ctx, {
      scalarKeys: PATCHABLE_KEYS,
      occUpdate: (set) => occUpdateCustomer(tx, id, patch.updatedAt, set),
      getRowAny: () => getCustomerByIdAny(tx, id),
      isDeleted: (row) => row.deletedAt !== null,
      serialize: (row) => assembleCustomer(tx, row),
      notFoundMessage: "客户不存在",
    });

    // 关系键：缺席=不动；[]=清空；[ids]=整表替换（与标量同一事务，updated_at 已 bump）
    replaceRelations(tx, id, patch, createAudit(ctx));
    return assembleCustomer(tx, getCustomerByIdAny(tx, id)!);
  });
}

export function deleteCustomer(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteCustomer(db, id, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("客户不存在");
}

// ---- K46 AI 打标 ----

const SCOPE_LIMITS: Record<string, { label: string; max: number }> = {
  identity: { label: "身份", max: 2 },
  stage: { label: "阶段", max: 1 },
  interest: { label: "兴趣", max: 3 },
};

const SCOPE_KEYS = Object.keys(SCOPE_LIMITS);

// K48 扩展：AI 打标同时推断行业。总是覆盖——LLM 给出非空值即写回；缺失/空串不动（防清空人工值）。
const AI_INDUSTRY_MAX_LEN = 100;
// AI 自建新标签（免审批自动入词表，用户拍板）：单条 ≤2，批量任务全局 ≤20，防词表爆炸。
const AI_NEW_TAG_MAX = 2;
const AI_NEW_TAG_BATCH_MAX = 20;
const AI_TAG_NAME_MAX_LEN = 50; // 对齐 tagWriteSchema.name max(50)
const AI_TAG_SCOPES: Set<string> = new Set(tagScopeSchema.options);

/** AI 自建新标签预算（单条/批量共用；used 跨客户累计即批量全局上限） */
interface NewTagBudget {
  used: number;
  max: number;
}

/** 客户基本信息 → prompt 用对象（K46：只给基本信息，不喂成交/交付明细） */
function promptCustomerInfo(row: CustomerDto): Record<string, unknown> {
  return {
    nickname: row.nickname,
    realName: row.realName,
    title: row.title,
    industry: row.industry,
    city: row.city,
    customerType: row.customerType,
    originStory: row.originStory,
    notes: row.notes,
    socialAccounts: row.socialAccounts,
    sourceChannels: row.sourceChannels.map((c) => c.name),
  };
}

/**
 * 前置校验：LLM 已配置 + 词表非空（单条/批量共用；未就绪 → 422）。
 * 返回收窄后的 settings（baseUrl/apiKey/model 均非空）与 enabled 词表。
 * 导出供 K51 jobs 注册表复用（创建任务时预检）。
 */
export function assertAiReady(db: Db): {
  settings: { baseUrl: string; apiKey: string; model: string };
  vocabulary: { id: number; name: string; scope: string }[];
} {
  const cfg = getAiConfig(db);
  if (!cfg?.apiKey || !cfg?.baseUrl || !cfg?.model) {
    throw unprocessable("请先在「系统设置」配置 LLM 服务", [
      { path: "ai-config", message: "缺少 baseUrl/apiKey/model" },
    ]);
  }
  const vocabulary = listEnabledLiveTags(db);
  if (vocabulary.length === 0) {
    throw unprocessable("标签词表为空，请先在「业务设置」维护标签", [
      { path: "tags", message: "无可用标签" },
    ]);
  }
  return {
    settings: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    vocabulary,
  };
}

/**
 * 单个客户打标核心（K46，单条/批量共用）：
 * 词表（仅 enabled）+ 客户基本信息 → prompt → OpenAI 兼容 chat/completions（chatJson）→
 * ① 词表内名称 → tag id；未命中名称按预算少量自建入词表（免审批，ensureAiTag）；
 * ② 行业非空 → 覆盖写回（总是覆盖；缺失/空串不动）；
 * ③ 与原标签取并集合并写入（不替换手动标签），touch updated_at 刷新 OCC 凭证。
 * 失败（网络/超时/不可解析）→ 抛 llmError（502）。
 */
async function aiTagCustomer(
  db: Db,
  row: CustomerRow,
  settings: { baseUrl: string; apiKey: string; model: string },
  vocabulary: { id: number; name: string; scope: string }[],
  ctx: AuditContext,
  budget: NewTagBudget,
  opts: { fetchFn?: typeof fetch },
): Promise<void> {
  const customer = assembleCustomer(db, row);

  const vocabText = SCOPE_KEYS.map((key) => {
    const { label } = SCOPE_LIMITS[key]!;
    const names = vocabulary.filter((t) => t.scope === key).map((t) => t.name);
    return `${label}：${names.length > 0 ? names.join("、") : "（无）"}`;
  }).join("\n");
  const limitText = SCOPE_KEYS.map(
    (key) => `${SCOPE_LIMITS[key]!.label}最多选 ${SCOPE_LIMITS[key]!.max} 个`,
  ).join("；");

  let result: Record<string, unknown>;
  try {
    result = await chatJson({
      settings,
      fetchFn: opts.fetchFn,
      messages: [
        {
          role: "system",
          content:
            "你是客户画像整理助手。根据客户基本信息推断其身份、阶段、兴趣标签与所属行业。" +
            "标签应优先从给定词表中选择，名称必须与词表完全一致；" +
            `若客户画像确实无法被词表覆盖，可新建最多 ${AI_NEW_TAG_MAX} 个新标签` +
            "（名称通用、可复用、≤50 字符，scope 取值 identity/stage/interest/other），" +
            "不得新建过细的个性化标签；行业推断为客户所属行业的一句话描述，无法判断时填空字符串。" +
            `只输出一个 JSON 对象：{"identity":[...],"stage":[...],"interest":[...],` +
            `"newTags":[{"name":"...","scope":"..."}],"industry":"..."}，不要输出任何其它内容。`,
        },
        {
          role: "user",
          content:
            `标签词表：\n${vocabText}\n\n${limitText}；新标签最多 ${AI_NEW_TAG_MAX} 个` +
            "（scope：identity/stage/interest/other）。\n\n" +
            `客户信息（JSON）：\n${JSON.stringify(promptCustomerInfo(customer))}\n\n请按约束输出 JSON。`,
        },
      ],
    });
  } catch (err) {
    if (err instanceof LlmError) throw llmError(err.message);
    throw err;
  }

  // 行业：非空字符串（trim 后）→ 覆盖写回；缺失/空串 → 不动（防止清空人工维护值）
  let industry: string | null = null;
  if (typeof result.industry === "string") {
    const trimmed = result.industry.trim().slice(0, AI_INDUSTRY_MAX_LEN);
    if (trimmed.length > 0) industry = trimmed;
  }

  // 名称 → live tag id：词表命中直接用；未命中按预算自建入词表（免审批）
  const idByName = new Map(vocabulary.map((t) => [t.name, t.id]));
  const picked: number[] = [];
  for (const key of SCOPE_KEYS) {
    const values = Array.isArray(result[key]) ? (result[key] as unknown[]) : [];
    for (const v of values) {
      const name = typeof v === "string" ? v : "";
      const tagId = idByName.get(name);
      if (tagId !== undefined && !picked.includes(tagId)) picked.push(tagId);
    }
  }
  const rawNewTags = Array.isArray(result.newTags) ? (result.newTags as unknown[]) : [];
  for (const item of rawNewTags) {
    if (typeof item !== "object" || item === null) continue;
    const { name, scope } = item as Record<string, unknown>;
    if (typeof name !== "string") continue;
    const trimmedName = name.trim().slice(0, AI_TAG_NAME_MAX_LEN);
    if (trimmedName.length === 0) continue;
    if (typeof scope !== "string" || !AI_TAG_SCOPES.has(scope)) continue;
    const tagId = ensureAiTag(db, trimmedName, scope, ctx, budget);
    if (tagId !== undefined && !picked.includes(tagId)) picked.push(tagId);
  }

  // 与原标签取并集（不覆盖手动标签）
  const existing = new Set(
    listCustomerTagRows(db, [row.id]).map((r) => r.tagId),
  );
  const union = [...new Set([...existing, ...picked])];

  inTx(db, (tx) => {
    const audit = createAudit(ctx);
    replaceCustomerTags(tx, row.id, union, { createdAt: audit.createdAt, createdBy: audit.createdBy });
    if (industry !== null) updateCustomerIndustry(tx, row.id, industry, updateAudit(ctx));
    touchCustomer(tx, row.id, updateAudit(ctx));
  });
}

/**
 * AI 自建新标签（免审批自动入词表，用户拍板扩展）：词表已有同名 live 标签 → 复用其 id（不计预算）；
 * 否则预算内 insert（enabled=1, sort=max+1, 审计列）；预算耗尽 → 丢弃返回 undefined。
 * 名称/scope 已由调用方 sanitize（trim/截断/枚举校验）。
 */
function ensureAiTag(
  db: Db,
  name: string,
  scope: string,
  ctx: AuditContext,
  budget: NewTagBudget,
): number | undefined {
  const existing = getLiveTagByName(db, name, { domain: "customer" });
  if (existing) return existing.id;
  if (budget.used >= budget.max) return undefined;
  const audit = createAudit(ctx);
  const id = insertTag(db, {
    name,
    domain: "customer",
    scope,
    sort: maxTagSort(db) + 1,
    enabled: 1,
    ...audit,
  });
  budget.used += 1;
  return id;
}

/**
 * AI 一键打标（K46）：客户 live 校验 → assertAiReady → aiTagCustomer；
 * 一键直接保存、无人工确认步骤（用户拍板）。失败（未配置/词表空 422，LLM 502）。
 */
export async function generateCustomerTags(
  db: Db,
  id: number,
  ctx: AuditContext,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<CustomerDto> {
  const row = getCustomerByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("客户不存在");
  const { settings, vocabulary } = assertAiReady(db);
  await aiTagCustomer(db, row, settings, vocabulary, ctx, { used: 0, max: AI_NEW_TAG_MAX }, opts);
  return assembleCustomer(db, getCustomerByIdAny(db, id)!);
}

// ---- K51 批量打标（后台任务执行核心） ----

export interface BulkTaggingJobOptions {
  fetchFn?: typeof fetch;
  /** 每客户处理前检查；返回 true 则提前结束（result.cancelled=true，供任务取消） */
  isCancelled?: () => boolean;
  /** 进度回调（初始 + 每客户后）：{ processed, total, succeeded, failed } */
  onProgress?: (p: { processed: number; total: number; succeeded: number; failed: number }) => void;
  /** AI 自建新标签预算（测试可注入小值验证上限；默认批量全局 ≤20） */
  newTagBudget?: NewTagBudget;
}

/**
 * 批量生成客户标签（K51，jobs 任务执行核心）：与列表/导出同一 WHERE
 * （q/customerType/ownerId/channelId/tagId/sort/order，M11：经 bulkTagJobParamsSchema 校验后的子集，
 * 不含分页——任务不分页全量跑），不分页逐客户串行打标（复用 aiTagCustomer）；
 * 单个客户 LLM 失败（502 LLM_ERROR）跳过并收集明细，不中断整体；
 * 返回 { total, succeeded, failed, failures, cancelled }。未配置/词表空 → 422（跑之前即拦）。
 */
export async function runBulkTaggingJob(
  db: Db,
  query: BulkTagJobParams,
  ctx: AuditContext,
  opts: BulkTaggingJobOptions = {},
): Promise<BulkTagGenerateResult> {
  const { settings, vocabulary } = assertAiReady(db);
  // listAllCustomers 不分页（签名要求完整列表查询类型），page/pageSize 补默认值仅为满足其签名，不参与查询
  const rows = listAllCustomers(db, { page: 1, pageSize: 25, ...query });
  const total = rows.length;
  // 批量全局预算：跨客户累计（默认 ≤20；测试注入小值）
  const newTagBudget: NewTagBudget = opts.newTagBudget ?? { used: 0, max: AI_NEW_TAG_BATCH_MAX };

  let succeeded = 0;
  let failed = 0;
  const failures: TagFailure[] = [];
  const report = () =>
    opts.onProgress?.({ processed: succeeded + failed, total, succeeded, failed });
  report();

  for (const row of rows) {
    if (opts.isCancelled?.()) {
      return { total, succeeded, failed, failures, cancelled: true };
    }
    try {
      await aiTagCustomer(db, row, settings, vocabulary, ctx, newTagBudget, opts);
      succeeded += 1;
    } catch (err) {
      // aiTagCustomer 已把 LlmError 映射为 502 LLM_ERROR（ApiError）；跳过该客户继续
      if (err instanceof ApiError && err.code === "LLM_ERROR") {
        failed += 1;
        failures.push({ customerId: row.id, nickname: row.nickname, message: err.message });
      } else {
        throw err;
      }
    }
    report();
  }
  return { total, succeeded, failed, failures, cancelled: false };
}

// ---- K47 客户总览 ----

export function getCustomerOverviewResult(
  db: Db,
  id: number,
  now: number,
): CustomerOverviewDto {
  const row = getCustomerByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("客户不存在");

  return {
    customer: assembleCustomer(db, row),
    stats: {
      dealCount: countLiveDealsByCustomer(db, id),
      paidTotalCents: paidTotalCentsByCustomer(db, id),
      lastDealAt: lastDealAtByCustomer(db, id),
      materialCount: countLiveMaterialsByCustomer(db, id),
      maintenanceRecordCount: countRecordsByCustomer(db, id),
    },
    deals: assembleDeals(db, listLiveDealsByCustomer(db, id)),
    circles: assembleDeliveries(db, listActiveCircleRowsByCustomer(db, id, now)),
    materials: assembleMaterials(db, listLiveMaterialsByCustomer(db, id)),
    maintenanceRecords: assembleCustomerMaintenanceRecords(db, listRecentRecordsByCustomer(db, id)),
  };
}
