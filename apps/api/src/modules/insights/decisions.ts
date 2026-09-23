// K62 二期决策台（geo 选址 / ladder 阶梯 / intent 意图 / guard 守护）：
// 全部消费一期事实与信号，纯确定性查询视图 + 规则，无新表无 LLM。口径随 meta.calibre 下发。
import { LADDER, signalTypeLabels, type SignalType } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import * as repo from "./repo.js";
import { assemblePivotFacts, type PivotFacts } from "./service.js";

const DAY = 86_400_000;
const yuan = (cents: number): string => `¥${Math.round(cents / 100).toLocaleString("zh-Hans-CN")}`;

// ── 选址台 ──

export interface GeoCityRow {
  city: string;
  customers: number;
  warm: number;
  hot: number;
  paidTotalCents: number;
  activeNeeds: number;
  renewals: number;
  /** 活动类交付参与人次（历史） */
  eventAttendance: number;
  customerIds: number[];
  sample: string[];
}

export function geoResult(db: Db, now: number) {
  const facts = assemblePivotFacts(db, 90, now);
  const needsByCustomer = new Map<number, number>();
  for (const s of repo.listActiveIntentRows(db, now)) {
    if (s.type === "need") needsByCustomer.set(s.customerId, (needsByCustomer.get(s.customerId) ?? 0) + 1);
  }
  const renewalsByCustomer = new Set(repo.listUpcomingCircleEnds(db, now, 30).map((r) => r.customerId));
  const attendanceByCustomer = new Set(
    repo.listDeliveryRungFacts(db).filter((d) => d.kind === "activity").map((d) => `${d.customerId}`),
  );

  const rows = new Map<string, GeoCityRow>();
  for (const f of facts.values()) {
    const key = f.city ?? "未填";
    let row = rows.get(key);
    if (!row) {
      row = { city: key, customers: 0, warm: 0, hot: 0, paidTotalCents: 0, activeNeeds: 0, renewals: 0, eventAttendance: 0, customerIds: [], sample: [] };
      rows.set(key, row);
    }
    row.customers += 1;
    if (f.temperature >= 25) row.warm += 1;
    if (f.temperature >= 60) row.hot += 1;
    row.paidTotalCents += f.paidTotalCents;
    row.activeNeeds += needsByCustomer.get(f.id) ?? 0;
    if (renewalsByCustomer.has(f.id)) row.renewals += 1;
    if (attendanceByCustomer.has(`${f.id}`)) row.eventAttendance += 1;
    if (row.customerIds.length < 200) row.customerIds.push(f.id);
    if (row.sample.length < 8) row.sample.push(f.nickname);
  }
  const cities = [...rows.values()].sort((a, b) => b.warm - a.warm || b.customers - a.customers);

  // 结论行：从未办过场次里挑「暖客户 + 活跃需求」最多的城市
  const untapped = cities.filter((c) => c.city !== "未填" && c.eventAttendance === 0 && c.warm > 0);
  const best = untapped.sort((a, b) => b.warm + b.activeNeeds * 2 - (a.warm + a.activeNeeds * 2))[0];
  const conclusion = best
    ? `${best.city}：${best.warm} 位暖客户、${best.activeNeeds} 条活跃需求、从未办过场次——建议排期`
    : cities.length > 0
      ? `暂无「从未办过场次」的待开发城市；暖客户最多的城市是 ${cities[0]!.city}（${cities[0]!.warm} 位）`
      : "暂无客户数据";

  return { windowDays: 90, total: facts.size, cities, conclusion };
}

// ── 阶梯台 ──

export function ladderResult(db: Db, now: number) {
  const facts = assemblePivotFacts(db, 90, now);
  const intents = repo.listActiveIntentRows(db, now);
  const intentByCustomer = new Map<number, typeof intents>();
  for (const s of intents) {
    const list = intentByCustomer.get(s.customerId) ?? [];
    list.push(s);
    intentByCustomer.set(s.customerId, list);
  }

  const nextOf: Record<string, string> = { none: "event", event: "consult", consult: "circle", circle: "multi" };
  const rungs = LADDER.rungs.map((r) => {
    const members = [...facts.values()].filter((f) => f.ladder === r.key);
    const upgradeReady = members
      .filter((f) => r.key !== "multi" && intentByCustomer.has(f.id))
      .flatMap((f) =>
        (intentByCustomer.get(f.id) ?? []).map((s) => ({
          customerId: f.id,
          nickname: f.nickname,
          nextLabel: LADDER.rungs.find((x) => x.key === nextOf[r.key])?.label ?? "—",
          evidence: s.content,
          topic: s.topicName,
        })),
      )
      .slice(0, 50);
    return {
      key: r.key,
      label: r.label,
      count: members.length,
      sample: members.slice(0, 8).map((m) => ({ id: m.id, nickname: m.nickname, temperature: m.temperature })),
      customerIds: members.slice(0, 200).map((m) => m.id),
      upgradeReadyCount: upgradeReady.length,
      upgradeReady: upgradeReady.slice(0, 10),
    };
  });

  // 标签过期候选：有阶段标签但行为阶梯 = 未成交（贴了标签没有动作）
  const staleTagCandidates = [...facts.values()]
    .filter((f) => f.ladder === "none" && (f.tagsByScope.get("stage") ?? []).length > 0)
    .slice(0, 50)
    .map((f) => ({ customerId: f.id, nickname: f.nickname, stageTags: f.tagsByScope.get("stage") ?? [] }));

  return {
    windowDays: 90,
    rungs,
    staleTagCount: staleTagCandidates.length,
    staleTagCandidates,
    conclusion:
      rungs.find((r) => r.upgradeReadyCount > 0)
        ? `${rungs.filter((r) => r.upgradeReadyCount > 0).reduce((a, r) => a + r.upgradeReadyCount, 0)} 位客户站在升级门口（有明确意向信号），最高梯级待升级 ${rungs.filter((r) => r.upgradeReadyCount > 0).map((r) => `${r.label}×${r.upgradeReadyCount}`).join("、")}`
        : "暂无升级就绪客户（意向信号落库后会自动出现）",
  };
}

// ── 意图台 ──

export function intentResult(db: Db, now: number) {
  const facts = assemblePivotFacts(db, 90, now);
  const rows = repo
    .listActiveIntentRows(db, now)
    .map((s) => {
      const f = facts.get(s.customerId);
      return {
        customerId: s.customerId,
        nickname: s.nickname,
        type: s.type,
        typeLabel: signalTypeLabels[s.type as SignalType] ?? s.type,
        topic: s.topicName,
        content: s.content,
        sourceAt: s.sourceAt,
        temperature: f?.temperature ?? 0,
        city: f?.city ?? null,
        /** 交叉销售：已有付款成交的客户出现新意向 */
        crossSell: (f?.paidTotalCents ?? 0) > 0,
        mentionCount: s.mentionCount,
      };
    })
    .sort((a, b) => b.temperature - a.temperature || b.sourceAt - a.sourceAt);

  const byTopic = new Map<string, { topic: string; count: number; cities: Set<string> }>();
  for (const r of rows) {
    const key = r.topic ?? "未归一";
    let row = byTopic.get(key);
    if (!row) {
      row = { topic: key, count: 0, cities: new Set() };
      byTopic.set(key, row);
    }
    row.count += 1;
    if (r.city) row.cities.add(r.city);
  }
  const topics = [...byTopic.values()]
    .map((t) => ({ topic: t.topic, count: t.count, cityCount: t.cities.size }))
    .sort((a, b) => b.count - a.count);

  const top = topics[0];
  const crossSellCount = rows.filter((r) => r.crossSell).length;
  return {
    windowDays: 90,
    total: rows.length,
    rows,
    topics,
    crossSellCount,
    conclusion: top
      ? `当前最热的需求主题是「${top.topic}」（${top.count} 条活跃意向、覆盖 ${top.cityCount} 城）；其中 ${crossSellCount} 位已有成交记录——交叉销售窗口`
      : "暂无活跃意向信号（维护记录与线索落库后自动抽取）",
  };
}

// ── 守护台 ──

export interface GuardItem {
  kind: "sleeping_whale" | "broken_lead" | "renewal_window" | "expired_intent";
  kindLabel: string;
  urgency: "high" | "mid";
  customerId: number;
  nickname: string;
  reason: string;
  /** 建议动作 */
  action: string;
  at: number;
}

export function guardResult(db: Db, now: number) {
  const facts = assemblePivotFacts(db, 90, now);
  const items: GuardItem[] = [];

  // 1. 沉睡金主：已付款 ≥1 万 且 温度 <25 且 90 天零触点
  const lastTouch = repo.listLastTouchMap(db);
  for (const f of facts.values()) {
    if (f.paidTotalCents < 1_000_000 || f.temperature >= 25) continue;
    const last = lastTouch.get(f.id);
    if (last !== undefined && last > now - 90 * DAY) continue;
    const days = last === undefined ? null : Math.floor((now - last) / DAY);
    items.push({
      kind: "sleeping_whale",
      kindLabel: "沉睡金主",
      urgency: "high",
      customerId: f.id,
      nickname: f.nickname,
      reason: `累计已付 ${yuan(f.paidTotalCents)}，温度 ${f.temperature}°，${last === undefined ? "无触点记录" : `最近触点 ${days} 天前`}`,
      action: "安排唤醒触达（专属话术）",
      at: last ?? 0,
    });
  }

  // 2. 线索断线：活跃意向/需求超 7 天，之后无任何跟进/线索记录
  const followLike = new Map<number, number[]>();
  for (const e of repo.listFollowLikeEvents(db)) {
    const list = followLike.get(e.customerId) ?? [];
    list.push(e.at);
    followLike.set(e.customerId, list);
  }
  for (const s of repo.listActiveIntentRows(db, now)) {
    if (s.sourceAt >= now - 7 * DAY) continue;
    const hasFollow = (followLike.get(s.customerId) ?? []).some((at) => at > s.sourceAt);
    if (hasFollow) continue;
    items.push({
      kind: "broken_lead",
      kindLabel: "线索断线",
      urgency: "high",
      customerId: s.customerId,
      nickname: s.nickname,
      reason: `${s.topicName ? `「${s.topicName}」` : signalTypeLabels[s.type as SignalType]}意向 ${Math.floor((now - s.sourceAt) / DAY)} 天无人跟进`,
      action: "立即回访",
      at: s.sourceAt,
    });
  }

  // 3. 续费窗口：圈子类交付 30 天内到期
  for (const r of repo.listUpcomingCircleEnds(db, now, 30)) {
    items.push({
      kind: "renewal_window",
      kindLabel: "续费窗口",
      urgency: "mid",
      customerId: r.customerId,
      nickname: r.nickname,
      reason: `《${r.deliveryName}》${Math.ceil((r.endsAt - now) / DAY)} 天后到期`,
      action: "谈续费",
      at: r.endsAt,
    });
  }

  // 4. 意向过期：intent/need 刚过期（30 天内），无人接住
  for (const s of repo.listRecentlyExpiredIntentRows(db, now, 30)) {
    items.push({
      kind: "expired_intent",
      kindLabel: "意向过期",
      urgency: "mid",
      customerId: s.customerId,
      nickname: s.nickname,
      reason: `${s.topicName ? `「${s.topicName}」` : ""}意向 ${Math.floor((now - (s.expiresAt ?? s.sourceAt)) / DAY)} 天前到期，无人接住`,
      action: "复盘或再触达",
      at: s.expiresAt ?? s.sourceAt,
    });
  }

  items.sort((a, b) => (a.urgency === b.urgency ? a.at - b.at : a.urgency === "high" ? -1 : 1));
  const high = items.filter((i) => i.urgency === "high").length;
  const sleepingValue = items
    .filter((i) => i.kind === "sleeping_whale")
    .reduce((a, i) => a + (facts.get(i.customerId)?.paidTotalCents ?? 0), 0);
  return {
    windowDays: 90,
    total: items.length,
    highCount: high,
    sleepingWhaleValueCents: sleepingValue,
    items,
    conclusion:
      items.length === 0
        ? "队列干净：没有待干预的客户信号"
        : `${items.length} 条待干预（紧急 ${high}）${sleepingValue > 0 ? `，其中沉睡金主在册价值 ${yuan(sleepingValue)}` : ""}`,
  };
}

export type { PivotFacts };
