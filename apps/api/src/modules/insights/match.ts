// K62 三期 缘分清单匹配引擎：need × supply 确定性 join + 词表图谱两级召回。
// 口径（@gb-crm/shared MATCH）：exact 满分；1-hop related ×0.7；加成同城 2/共同交付 2/反复提及 1；
// 护栏：同客户排除、confidence < minConfidence 不参与、未过期 risk 信号客户不进名单。
// 只建议不自动牵线；v1 不存边（查询时推导），真引荐记维护记录。
import { MATCH } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import * as repo from "./repo.js";

export interface MatchSignalRow {
  id: number;
  customerId: number;
  nickname: string;
  city: string | null;
  topicId: number | null;
  topicName: string | null;
  content: string;
  mentionCount: number;
  confidence: number;
  sourceAt: number;
}

export interface MatchPair {
  needCustomerId: number;
  needNickname: string;
  supplyCustomerId: number;
  supplyNickname: string;
  topic: string;
  /** false = topic 精确相等（满基础分）；true = 经词表 1-hop related 命中（×0.7 折扣） */
  viaRelated: boolean;
  score: number;
  sameCity: boolean;
  sharedDeliveries: number;
  needEvidence: string;
  supplyEvidence: string;
}

/** 纯函数核心（可单测）：need/supply 信号行 → 配对列表 */
export function buildMatchPairs(
  needs: readonly MatchSignalRow[],
  supplies: readonly MatchSignalRow[],
  relations: readonly { topicId: number; relatedTopicId: number }[],
  deliveryMembership: ReadonlyMap<number, Set<number>>,
  riskCustomerIds: ReadonlySet<number>,
): MatchPair[] {
  const related = new Set<string>();
  for (const r of relations) {
    related.add(`${r.topicId}->${r.relatedTopicId}`);
    related.add(`${r.relatedTopicId}->${r.topicId}`); // related 边双向可用
  }

  const eligibleSupplies = supplies.filter(
    (s) => s.confidence >= MATCH.minConfidence && s.topicId !== null && !riskCustomerIds.has(s.customerId),
  );
  const pairs: MatchPair[] = [];
  for (const n of needs) {
    if (n.confidence < MATCH.minConfidence || n.topicId === null || riskCustomerIds.has(n.customerId)) continue;
    for (const s of eligibleSupplies) {
      if (s.customerId === n.customerId) continue; // 自匹配排除
      const exact = s.topicId === n.topicId;
      const viaRelated = !exact && related.has(`${n.topicId}->${s.topicId}`);
      if (!exact && !viaRelated) continue;

      let score = MATCH.base * (viaRelated ? MATCH.relatedDiscount : 1);
      const sameCity = Boolean(n.city && s.city && n.city === s.city);
      if (sameCity) score += MATCH.boosts.sameCity;
      const shared =
        deliveryMembership.get(n.customerId) && deliveryMembership.get(s.customerId)
          ? [...(deliveryMembership.get(n.customerId) ?? [])].filter((d) =>
              (deliveryMembership.get(s.customerId) ?? new Set<number>()).has(d),
            ).length
          : 0;
      if (shared > 0) score += MATCH.boosts.sameDelivery;
      if (s.mentionCount > 1) score += MATCH.boosts.mention;

      pairs.push({
        needCustomerId: n.customerId,
        needNickname: n.nickname,
        supplyCustomerId: s.customerId,
        supplyNickname: s.nickname,
        topic: n.topicName ?? s.topicName ?? "未归一",
        viaRelated,
        score: Math.round(score * 100) / 100,
        sameCity,
        sharedDeliveries: shared,
        needEvidence: n.content,
        supplyEvidence: s.content,
      });
    }
  }
  return pairs.sort((a, b) => b.score - a.score);
}

export function matchResult(db: Db, now: number) {
  const rows = repo.listActiveNeedSupplyRows(db, now);
  const needs: MatchSignalRow[] = rows.filter((r) => r.type === "need").map(toMatchRow);
  const supplies: MatchSignalRow[] = rows.filter((r) => r.type === "supply").map(toMatchRow);
  const relations = repo.listRelationRows(db);
  const membership = new Map<number, Set<number>>();
  for (const m of repo.listDeliveryMembership(db)) {
    const set = membership.get(m.customerId) ?? new Set<number>();
    set.add(m.deliveryId);
    membership.set(m.customerId, set);
  }
  const riskCustomerIds = new Set(repo.listActiveRiskCustomerIds(db, now));

  const pairs = buildMatchPairs(needs, supplies, relations, membership, riskCustomerIds).slice(0, 100);

  // 按主题聚合 → 活动策划视图（凑一桌条件）
  const byTopic = new Map<string, { topic: string; needCount: number; supplyCount: number; cities: Set<string>; topCity: string | null }>();
  for (const r of rows) {
    if (r.topicId === null) continue;
    const key = r.topicName ?? "未归一";
    let row = byTopic.get(key);
    if (!row) {
      row = { topic: key, needCount: 0, supplyCount: 0, cities: new Set(), topCity: null };
      byTopic.set(key, row);
    }
    if (r.type === "need") row.needCount += 1;
    else row.supplyCount += 1;
    if (r.city) row.cities.add(r.city);
  }
  const topics = [...byTopic.values()]
    .filter((t) => t.needCount > 0)
    .map((t) => ({ topic: t.topic, needCount: t.needCount, supplyCount: t.supplyCount, cityCount: t.cities.size }))
    .sort((a, b) => b.needCount - a.needCount);

  const ready = topics.filter((t) => t.supplyCount > 0);
  // 配对成功的主题（含 related 召回）：凑桌结论以「真连上了」为准
  const pairedCount = new Map<string, number>();
  for (const p of pairs) pairedCount.set(p.topic, (pairedCount.get(p.topic) ?? 0) + 1);
  const topPaired = [...pairedCount.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    windowDays: 90,
    total: pairs.length,
    pairs,
    topics,
    conclusion:
      topPaired
        ? `${pairs.length} 对撮合建议；「${topPaired[0]}」供需两头连上了（${topPaired[1]} 对，含词表关联召回）——凑一桌条件成熟`
        : ready.length > 0
          ? `需求与供给同主题但未成对（置信度/风险护栏拦截），最接近的是「${ready[0]!.topic}」`
          : topics.length > 0
            ? `需求已出现（最热「${topics[0]!.topic}」${topics[0]!.needCount} 条），但供给端暂无同主题信号——从交付/讲者侧补供给画像`
            : "暂无可撮合的 need/supply 信号",
  };
}

function toMatchRow(r: ReturnType<typeof repo.listActiveNeedSupplyRows>[number]): MatchSignalRow {
  return {
    id: r.id,
    customerId: r.customerId,
    nickname: r.nickname,
    city: r.city,
    topicId: r.topicId,
    topicName: r.topicName,
    content: r.content,
    mentionCount: r.mentionCount,
    confidence: r.confidence,
    sourceAt: r.sourceAt,
  };
}
