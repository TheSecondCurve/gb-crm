// K62 四期 AI 经营备忘：把守护/选址/意图/撮合四台的确定性结论喂给 LLM，
// 生成 2-3 句行动导向的「本周客户经营备忘」。LLM 未配置或失败 → 回退规则版拼接（不报错）。
import type { Db } from "../../db/client.js";
import { LlmError, chatJson } from "../../lib/llm.js";
import { getAiConfig } from "../system/repo.js";
import { geoResult, guardResult, intentResult } from "./decisions.js";
import { matchResult } from "./match.js";

export interface InsightsSummary {
  source: "llm" | "rule";
  summary: string;
  generatedAt: number;
}

const SYSTEM_PROMPT = `你是「女商 私域运营管理端」的客户经营教练。输入是系统各决策台的确定性结论与数字（口径已由系统算好，你不做任何计算）。
写 2-3 句中文「本周客户经营备忘」：
- 结论先行、行动导向（先做什么、再做什么），点名最值得关注的 1-2 个信号；
- 只用输入里出现的数字与事实，禁止编造或外推；
- 语气干练，不用列表、不用客套。
输出 JSON：{"summary":"…"}`;

export async function insightsSummaryResult(
  db: Db,
  now: number,
  fetchFn?: typeof fetch,
): Promise<InsightsSummary> {
  const guard = guardResult(db, now);
  const geo = geoResult(db, now);
  const intent = intentResult(db, now);
  const match = matchResult(db, now);

  const ruleSummary = [
    `守护台：${guard.conclusion}`,
    `选址台：${geo.conclusion}`,
    `意图台：${intent.conclusion}`,
    `缘分清单：${match.conclusion}`,
  ].join("；") + "。";

  const cfg = getAiConfig(db);
  if (!cfg?.apiKey || !cfg?.baseUrl || !cfg?.model) {
    return { source: "rule", summary: ruleSummary, generatedAt: now };
  }

  const facts = [
    `守护台（待干预）：${guard.conclusion}`,
    `选址台（活动）：${geo.conclusion}`,
    `意图台（回访）：${intent.conclusion}`,
    `缘分清单（撮合）：${match.conclusion}`,
  ].join("\n");

  try {
    const parsed = await chatJson<{ summary?: string }>({
      settings: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `今天是 ${new Date(now).toISOString().slice(0, 10)}。各决策台结论：\n${facts}` },
      ],
      temperature: 0.3,
      fetchFn,
    });
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) throw new LlmError("LLM 返回内容为空");
    return { source: "llm", summary, generatedAt: now };
  } catch {
    // LLM 失败不阻断：回退规则版
    return { source: "rule", summary: ruleSummary, generatedAt: now };
  }
}
