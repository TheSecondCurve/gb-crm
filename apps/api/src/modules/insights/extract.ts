// K62 signal.extract 抽取任务：打包客户文本 bundle → LLM（OpenAI 兼容 chatJson）→ ingestExtractions。
// 无人工确认（生效即用）；幂等（同源同事实跳过、同源异事实取代、跨源 90 天内合并）。
// 词表种子在首次抽取前预热（兴趣标签 + 产品名 + 高频行业）。
import type { SignalExtraction } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { LlmError, chatJson } from "../../lib/llm.js";
import { getAiConfig } from "../system/repo.js";
import { ensureTopicSeeds, ingestExtractions } from "./service.js";
import * as repo from "./repo.js";

export const SIGNALS_PROMPT_VERSION = "v1";

const SYSTEM_PROMPT = `你是客户经营信号抽取器。输入是某位客户的全部自由文本记录（来历/备注/维护记录），从中抽取「值得记住的类型化事实」。

信号类型（只能取这 8 个）：
- growth 成长信号：她的生意在扩张/好转（开店、招人、融资、新品、涨势）
- risk 风险信号：生意在收缩/遇困（关店、转型收缩、资金紧张、客源下滑）
- intent 明确意向：明确表达对某产品/服务有购买或参与意向
- interest_hint 兴趣提示：表现出兴趣但未明确表态
- need 需求：她在找某种资源/合作/人（如找代运营、找供应链、找渠道）
- supply 供给：她自己能提供什么（职业/生意/资源，如开代运营工作室、有工厂）
- lifecycle 人生节点：影响经营节奏的个人大事（生育、搬迁、健康、家庭）
- sentiment 情感倾向：对团队/服务的情绪（不满、投诉、特别认可）

归一主题词规则（topic）：
- 必须是「领域/平台 + 动作或对象」的形式（如「小红书运营」「饰品供应链」「直播带货」「品牌设计」），禁止裸大词（「营销」「运营」「推广」）。
- 优先从给定词表中选；选不上才建新词，且必须同时给出 topicNearest = 最接近的现有词。
- need/supply/intent/interest_hint 尽量给 topic；纯情绪/人生节点可省略。

抽取纪律：
- 只抽文本明确支持的事实，不推测；没有就返回空数组。
- content 是一句话事实摘要（≤80 字），保留关键细节（数字、城市、类目）。
- 每条标注 sourceIndex（对应输入文本序号）与 confidence（0-1）。
- 输出 JSON：{"signals":[{"type":"...","topic":"...","topicNearest":"...","content":"...","confidence":0.9,"sourceIndex":0}]}`;

export interface SignalExtractRunResult {
  total: number;
  succeeded: number;
  failed: number;
  failures: { customerId: number; nickname: string; message: string }[];
  cancelled: boolean;
}

interface LlmExtractionItem {
  type: string;
  topic?: string;
  topicNearest?: string;
  content: string;
  confidence?: number;
  sourceIndex: number;
}

function validType(t: string): t is SignalExtraction["type"] {
  return ["growth", "risk", "intent", "interest_hint", "need", "supply", "lifecycle", "sentiment"].includes(t);
}

/** 单客户抽取 + 落库（导出供测试直调）；LLM 未配置 → 抛错（任务侧统计为失败） */
export async function extractCustomerSignals(
  db: Db,
  customerId: number,
  audit: { now: number; userId: number | null },
  fetchFn?: typeof fetch,
): Promise<{ inserted: number; merged: number; skipped: number; superseded: number; extracted: number; cleaned: number }> {
  const cfg = getAiConfig(db);
  if (!cfg?.apiKey || !cfg?.baseUrl || !cfg?.model) {
    throw new LlmError("请先在「系统设置」配置 LLM 服务");
  }
  const bundle = repo.listCustomerTextBundle(db, customerId);
  if (!bundle) throw new LlmError(`客户不存在：${customerId}`);

  // 词表种子（空表才预热，幂等）：兴趣标签 + 产品名 + 高频行业
  ensureTopicSeeds(db, audit);

  // 清理：来源文本已消失的信号行 → 软删（来源消失，事实随之消失）。
  // ① 维护记录被软删（判活用该客户全部 live 记录 id，与 bundle 的最新 50 条上限无关，不误伤老记录）；
  // ② 场次语料被软删或已解除与该客户的关联（transcript 源：资料行 live 且仍挂在该客户名下才算活）。
  const cleanDeadSources = (): number => {
    let cleaned = 0;
    const liveRecordIds = repo.listLiveRecordIdsByCustomer(db, customerId);
    for (const row of repo.listActiveRowsByCustomerSourceType(db, customerId, "maintenance_record")) {
      if (row.sourceId !== null && !liveRecordIds.has(row.sourceId)) {
        repo.updateSignalRow(db, row.id, { deletedAt: audit.now, updatedAt: audit.now, updatedBy: audit.userId });
        cleaned += 1;
      }
    }
    for (const row of repo.listActiveRowsByCustomerSourceType(db, customerId, "transcript")) {
      if (row.sourceId === null) continue;
      if (!repo.isMaterialLiveAndLinked(db, row.sourceId, customerId)) {
        repo.updateSignalRow(db, row.id, { deletedAt: audit.now, updatedAt: audit.now, updatedBy: audit.userId });
        cleaned += 1;
      }
    }
    return cleaned;
  };

  if (bundle.texts.length === 0) {
    // 没有可抽文本（如记录全被删）→ 只走清理路径，不调 LLM
    return { inserted: 0, merged: 0, skipped: 0, superseded: 0, extracted: 0, cleaned: cleanDeadSources() };
  }

  const topicNames = repo.listLiveTopicRows(db)
    .filter((t) => t.enabled === 1)
    .map((t) => t.name);

  const numbered = bundle.texts.map((t, i) => `${i}. [${t.sourceAt}] ${t.content}`).join("\n");
  const userPrompt = `客户昵称：${bundle.nickname}\n可用主题词表：${topicNames.join("、") || "（空，可自建）"}\n\n客户文本记录：\n${numbered}`;

  const parsed = await chatJson<{ signals?: LlmExtractionItem[] }>({
    settings: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    fetchFn,
  });

  const items = Array.isArray(parsed.signals) ? parsed.signals : [];
  const extractions: SignalExtraction[] = [];
  for (const item of items) {
    const itemType = String(item.type);
    if (!validType(itemType) || typeof item.content !== "string" || !item.content.trim()) continue;
    const text = bundle.texts[item.sourceIndex];
    if (!text) continue;
    extractions.push({
      type: itemType,
      topic: typeof item.topic === "string" && item.topic.trim() ? item.topic.trim().slice(0, 40) : undefined,
      topicNearest:
        typeof item.topicNearest === "string" && item.topicNearest.trim() ? item.topicNearest.trim().slice(0, 40) : undefined,
      content: item.content.trim().slice(0, 500),
      confidence: typeof item.confidence === "number" ? Math.min(1, Math.max(0, item.confidence)) : 1,
      sourceType: text.sourceType,
      sourceId: text.sourceId,
      sourceAt: text.sourceAt,
    });
  }

  const outcome = ingestExtractions(db, customerId, extractions, SIGNALS_PROMPT_VERSION, audit);
  return { ...outcome, extracted: extractions.length, cleaned: cleanDeadSources() };
}

/** 任务执行体（jobs registry 调用）。目标选择：customerId 单客户 / all 全量 / 缺省 = 扫尾（stale）。 */
export async function runSignalExtractJob(
  db: Db,
  params: { customerId?: number; all?: boolean },
  audit: { now: number; userId: number | null },
  opts: { fetchFn?: typeof fetch; isCancelled: () => boolean; onProgress: (p: { processed: number; total: number; succeeded: number; failed: number }) => void },
): Promise<SignalExtractRunResult> {
  const targetIds =
    params.customerId !== undefined
      ? [params.customerId]
      : params.all
        ? repo.listPivotCustomers(db).map((c) => c.id)
        : repo.listStaleCustomerIds(db);

  const result: SignalExtractRunResult = { total: targetIds.length, succeeded: 0, failed: 0, failures: [], cancelled: false };
  opts.onProgress({ processed: 0, total: result.total, succeeded: 0, failed: 0 });

  const nicknameById = new Map(repo.listPivotCustomers(db).map((c) => [c.id, c.nickname]));
  for (const customerId of targetIds) {
    if (opts.isCancelled()) {
      result.cancelled = true;
      return result;
    }
    try {
      await extractCustomerSignals(db, customerId, audit, opts.fetchFn);
      result.succeeded += 1;
    } catch (err) {
      // LlmError（网络/未配置/不可解析）→ 单客户失败继续（partial）
      if (err instanceof LlmError || err instanceof Error) {
        result.failed += 1;
        result.failures.push({
          customerId,
          nickname: nicknameById.get(customerId) ?? `#${customerId}`,
          message: err instanceof LlmError ? err.message : String(err),
        });
      } else {
        throw err;
      }
    }
    opts.onProgress({ processed: result.succeeded + result.failed, total: result.total, succeeded: result.succeeded, failed: result.failed });
  }
  return result;
}
