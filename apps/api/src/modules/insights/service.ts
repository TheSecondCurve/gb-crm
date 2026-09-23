// K62 insights service：透视台聚合、客户深潜、信号 ingest（幂等：同源取代 + 跨源合并 + TTL）、
// 人工补录/否决、词表种子与合并。口径常量全部来自 @gb-crm/shared（「口径即 API」）。
import {
  LADDER,
  SIGNAL_TTL_DAYS,
  TEMPERATURE_BANDS,
  VALUE_BANDS,
  customerTypeLabels,
  ladderOf,
  pivotAxisLabels,
  regionOfCity,
  signalTypeLabels,
  temperatureBandOf,
  valueBandOf,
  type CustomerType,
  type LadderRunkKey,
  type PivotAxisKey,
  type PivotQuery,
  type SignalExtraction,
  type SignalManualWrite,
  type SignalType,
} from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { notFound, unprocessable } from "../../plugins/error-handler.js";
import { computeTemperature, computeTemperatureSeries, type TemperatureEvent } from "./temperature.js";
import * as repo from "./repo.js";
import type { CustomerSignalRow, SignalTopicRow } from "./repo.js";

export interface AuditContext {
  now: number;
  userId: number | null;
}

// ── 透视台 ──

/** 客户透视事实（内存装配，400 客户量级一次拉取） */
interface PivotFacts {
  id: number;
  nickname: string;
  city: string | null;
  region: string | null;
  customerType: string;
  ownerId: number | null;
  ownerName: string | null;
  tagsByScope: Map<string, string[]>;
  channels: string[];
  temperature: number;
  paidTotalCents: number;
  ladder: LadderRunkKey;
  signalTypes: Set<string>;
}

function assemblePivotFacts(db: Db, windowDays: number, now: number): Map<number, PivotFacts> {
  const facts = new Map<number, PivotFacts>();
  for (const c of repo.listPivotCustomers(db)) {
    facts.set(c.id, {
      id: c.id,
      nickname: c.nickname,
      city: c.city,
      region: regionOfCity(c.city),
      customerType: c.customerType,
      ownerId: c.ownerId,
      ownerName: c.ownerName,
      tagsByScope: new Map(),
      channels: [],
      temperature: 0,
      paidTotalCents: 0,
      ladder: "none",
      signalTypes: new Set(),
    });
  }

  for (const t of repo.listCustomerTagRefs(db)) {
    const f = facts.get(t.customerId);
    if (!f) continue;
    f.tagsByScope.set(t.scope, [...(f.tagsByScope.get(t.scope) ?? []), t.name]);
  }
  for (const c of repo.listCustomerChannelRefs(db)) {
    facts.get(c.customerId)?.channels.push(c.name);
  }

  // 温度（窗口内事件）
  const eventsByCustomer = new Map<number, TemperatureEvent[]>();
  for (const e of repo.listAllTemperatureEvents(db, now)) {
    const list = eventsByCustomer.get(e.customerId) ?? [];
    list.push(e);
    eventsByCustomer.set(e.customerId, list);
  }
  for (const [customerId, events] of eventsByCustomer) {
    const f = facts.get(customerId);
    if (f) f.temperature = computeTemperature(events, now, windowDays);
  }

  // 价值（paid 总额，全时段）与阶梯（成交产品类型 ∪ 交付类型分类）
  const productTypes = repo.listProductTypes(db);
  const productRungsByCustomer = new Map<number, Set<string>>();
  for (const d of repo.listDealFacts(db)) {
    const f = facts.get(d.customerId);
    if (!f) continue;
    if (d.stage === "paid" && d.amountCents !== null) f.paidTotalCents += d.amountCents;
    const rung = d.productId !== null ? LADDER.productRung[productTypes.get(d.productId) ?? ""] : undefined;
    if (rung) {
      const set = productRungsByCustomer.get(d.customerId) ?? new Set<string>();
      set.add(rung);
      productRungsByCustomer.set(d.customerId, set);
    }
  }
  const deliveryRungsByCustomer = new Map<number, Set<string>>();
  for (const d of repo.listDeliveryRungFacts(db)) {
    const rung = LADDER.deliveryRung[d.kind];
    if (!rung) continue;
    const set = deliveryRungsByCustomer.get(d.customerId) ?? new Set<string>();
    set.add(rung);
    deliveryRungsByCustomer.set(d.customerId, set);
  }
  for (const f of facts.values()) {
    f.ladder = ladderOf(
      productRungsByCustomer.get(f.id) ?? [],
      deliveryRungsByCustomer.get(f.id) ?? [],
    );
  }

  for (const s of repo.listActiveSignalTypeRefs(db, now)) {
    facts.get(s.customerId)?.signalTypes.add(s.type);
  }
  return facts;
}

/** 轴 → 该客户的桶 key 列表（标签/渠道/信号类轴可多桶；空 → 占位桶） */
function bucketsOf(axis: PivotAxisKey, f: PivotFacts): string[] {
  const scope =
    axis === "stageTag"
      ? "stage"
      : axis === "identityTag"
        ? "identity"
        : axis === "interestTag"
          ? "interest"
          : null;
  if (scope) {
    const names = f.tagsByScope.get(scope) ?? [];
    return names.length > 0 ? names : ["未打标"];
  }
  switch (axis) {
    case "city":
      return [f.city ?? "未填"];
    case "region":
      return [f.region ?? "未填"];
    case "customerType":
      return [customerTypeLabels[f.customerType as CustomerType] ?? f.customerType];
    case "channel":
      return f.channels.length > 0 ? f.channels : ["无渠道"];
    case "owner":
      return [f.ownerName ?? "未分配"];
    case "temperatureBand":
      return [TEMPERATURE_BANDS.find((b) => b.key === temperatureBandOf(f.temperature))!.label];
    case "valueBand":
      return [VALUE_BANDS.find((b) => b.key === valueBandOf(f.paidTotalCents))!.label];
    case "ladder":
      return [LADDER.rungs.find((r) => r.key === f.ladder)!.label];
    case "signal": {
      const names = [...f.signalTypes].map((t) => signalTypeLabels[t as SignalType] ?? t);
      return names.length > 0 ? names : ["无信号"];
    }
    default:
      return ["—"];
  }
}

/** 桶排序：带口径顺序的轴用固定序，其余按客户数降序 + 名称 */
const BUCKET_ORDER: Partial<Record<PivotAxisKey, string[]>> = {
  temperatureBand: TEMPERATURE_BANDS.map((b) => b.label),
  valueBand: VALUE_BANDS.map((b) => b.label),
  ladder: LADDER.rungs.map((r) => r.label),
  signal: [...Object.values(signalTypeLabels), "无信号"],
};

export interface PivotCell {
  x: string;
  y: string;
  count: number;
  customerIds: number[];
  sample: string[];
}
export interface PivotResult {
  axes: { x: { key: PivotAxisKey; label: string }; y: { key: PivotAxisKey; label: string } };
  windowDays: number;
  total: number;
  rows: { y: string; total: number; cells: PivotCell[] }[];
  columns: { x: string; total: number }[];
}

export function pivotResult(db: Db, query: PivotQuery, now: number): PivotResult {
  const all = assemblePivotFacts(db, query.window, now);
  const facts =
    query.ownerId !== undefined
      ? new Map([...all].filter(([, f]) => f.ownerId === query.ownerId))
      : all;

  const cellMap = new Map<string, PivotCell>();
  const xTotals = new Map<string, number>();
  const yTotals = new Map<string, number>();
  let total = 0;
  for (const f of facts.values()) {
    const xs = bucketsOf(query.x, f);
    const ys = bucketsOf(query.y, f);
    total += 1;
    for (const x of xs) xTotals.set(x, (xTotals.get(x) ?? 0) + 1);
    for (const y of ys) yTotals.set(y, (yTotals.get(y) ?? 0) + 1);
    for (const y of ys) {
      for (const x of xs) {
        const key = `${y}\u0000${x}`;
        let cell = cellMap.get(key);
        if (!cell) {
          cell = { x, y, count: 0, customerIds: [], sample: [] };
          cellMap.set(key, cell);
        }
        cell.count += 1;
        if (cell.customerIds.length < 200) cell.customerIds.push(f.id);
        if (cell.sample.length < 8) cell.sample.push(f.nickname);
      }
    }
  }

  const orderFor = (axis: PivotAxisKey, totals: Map<string, number>): string[] => {
    const preset = BUCKET_ORDER[axis];
    const keys = [...totals.keys()];
    if (preset) {
      const presetSet = new Set(preset);
      return [
        ...preset.filter((p) => totals.has(p)),
        ...keys.filter((k) => !presetSet.has(k)),
      ];
    }
    return keys.sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b, "zh-Hans-CN"));
  };

  const xs = orderFor(query.x, xTotals);
  const ys = orderFor(query.y, yTotals);
  const rows = ys.map((y) => ({
    y,
    total: yTotals.get(y) ?? 0,
    cells: xs.map((x) => cellMap.get(`${y}\u0000${x}`) ?? { x, y, count: 0, customerIds: [], sample: [] }),
  }));

  return {
    axes: {
      x: { key: query.x, label: pivotAxisLabels[query.x] },
      y: { key: query.y, label: pivotAxisLabels[query.y] },
    },
    windowDays: query.window,
    total,
    rows,
    columns: xs.map((x) => ({ x, total: xTotals.get(x) ?? 0 })),
  };
}

// ── 客户深潜 ──

export function depthResult(db: Db, customerId: number, now: number) {
  const customerRow = repo.listPivotCustomers(db).find((c) => c.id === customerId);
  if (!customerRow) throw notFound("客户不存在");

  const facts = assemblePivotFacts(db, 90, now).get(customerId)!;
  const events = repo.listCustomerTemperatureEvents(db, customerId, now);
  const signals = repo.listSignalRowsByCustomer(db, customerId);
  return {
    customer: {
      id: customerRow.id,
      nickname: customerRow.nickname,
      city: customerRow.city,
      customerType: customerRow.customerType,
      ownerName: customerRow.ownerName,
    },
    temperature: facts.temperature,
    temperatureBand: temperatureBandOf(facts.temperature),
    temperatureSeries: computeTemperatureSeries(events, now, 180, 13),
    paidTotalCents: facts.paidTotalCents,
    ladder: LADDER.rungs.find((r) => r.key === facts.ladder)!.label,
    signalTypes: [...facts.signalTypes],
    signals: signals.map(assembleSignal),
  };
}

// ── 信号 DTO ──

function signalStatus(row: CustomerSignalRow, now: number): string {
  if (row.rejectedBy !== null) return "rejected";
  if (row.supersededBy !== null) return "superseded";
  if (row.expiresAt !== null && row.expiresAt <= now) return "expired";
  return "active";
}

export function assembleSignal(row: CustomerSignalRow & { topicName: string | null }, now: number) {
  return {
    id: row.id,
    customerId: row.customerId,
    type: row.type,
    typeLabel: signalTypeLabels[row.type as SignalType] ?? row.type,
    topicId: row.topicId,
    topicName: row.topicName,
    content: row.content,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceAt: row.sourceAt,
    mentionCount: row.mentionCount,
    confidence: row.confidence,
    status: signalStatus(row, now),
    expiresAt: row.expiresAt,
    promptVersion: row.promptVersion,
    extractedAt: row.extractedAt,
  };
}

export function listSignalsResult(
  db: Db,
  query: { customerId?: number; type?: string; activeOnly: boolean; page: number; pageSize: number },
  now: number,
) {
  const { rows, total } = repo.listSignalRows(db, { ...query, now });
  return { data: rows.map((r) => assembleSignal(r, now)), total };
}

// ── 人工补录 / 否决 ──

function withTopicName(db: Db, row: CustomerSignalRow): CustomerSignalRow & { topicName: string | null } {
  return {
    ...row,
    topicName: row.topicId !== null ? (repo.getTopicByIdAny(db, row.topicId)?.name ?? null) : null,
  };
}

export function createManualSignalResult(db: Db, body: SignalManualWrite, audit: AuditContext) {
  const live = repo.listPivotCustomers(db).find((c) => c.id === body.customerId);
  if (!live) throw notFound("客户不存在");
  const topicId =
    body.topic !== undefined ? resolveOrCreateTopic(db, body.topic, audit).id : null;
  const id = repo.insertSignalRow(db, {
    customerId: body.customerId,
    type: body.type,
    topicId,
    content: body.content,
    sourceType: "manual",
    sourceId: null,
    sourceAt: body.sourceAt ?? audit.now,
    mentionCount: 1,
    confidence: 1,
    expiresAt: expiresFor(body.type, body.sourceAt ?? audit.now),
    promptVersion: "manual",
    extractedAt: audit.now,
    createdAt: audit.now,
    updatedAt: audit.now,
    createdBy: audit.userId,
    updatedBy: audit.userId,
  });
  return assembleSignal(withTopicName(db, repo.getSignalByIdAny(db, id)!), audit.now);
}

export function rejectSignalResult(db: Db, id: number, audit: AuditContext) {
  const row = repo.getSignalByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("信号不存在");
  if (row.rejectedBy === null) {
    repo.updateSignalRow(db, id, {
      rejectedBy: audit.userId,
      rejectedAt: audit.now,
      updatedAt: audit.now,
      updatedBy: audit.userId,
    });
  }
  return assembleSignal(withTopicName(db, repo.getSignalByIdAny(db, id)!), audit.now);
}

// ── 抽取 ingest（幂等核心） ──

/** 归一词：精确命中 live 词 → 复用；否则建新词（免审批）+ nearest related 边 */
export function resolveOrCreateTopic(
  db: Db,
  name: string,
  audit: AuditContext,
  nearest?: string,
): SignalTopicRow {
  const existing = repo.findLiveTopicByName(db, name);
  if (existing) return existing;
  const id = repo.insertTopicRow(db, {
    name,
    enabled: 1,
    sort: 0,
    createdAt: audit.now,
    updatedAt: audit.now,
    createdBy: audit.userId,
    updatedBy: audit.userId,
  });
  if (nearest && nearest !== name) {
    const near = repo.findLiveTopicByName(db, nearest);
    if (near) {
      repo.insertRelationRow(db, {
        topicId: id,
        relatedTopicId: near.id,
        source: "llm",
        createdAt: audit.now,
        createdBy: audit.userId,
      });
    }
  }
  return repo.getTopicByIdAny(db, id)!;
}

function expiresFor(type: string, sourceAt: number): number | null {
  const days = SIGNAL_TTL_DAYS[type as SignalType];
  return days === null || days === undefined ? null : sourceAt + days * 86_400_000;
}

/** 同源同信号（type+topic+content 全等）→ 幂等跳过 */
function sameFact(row: CustomerSignalRow, keyed: { type: string; topicId: number | null; content: string }): boolean {
  return row.type === keyed.type && row.topicId === keyed.topicId && row.content === keyed.content;
}

export interface IngestOutcome {
  inserted: number;
  merged: number;
  skipped: number;
  superseded: number;
}

/**
 * 抽取结果落库（无人工确认，生效即用）：
 * 1. 同源（source_type+source_id）有效信号中已存在同事实（type+topic+content 全等）→ 跳过（幂等）；
 * 2. 跨来源合并：同客户同 type 同 topic 的有效信号，新 source_at 与其 source_at 相差 ≤ 90 天
 *    → mention_count+1、内容/置信度/到期刷新（保留最早 created，多源累积可信度）；
 * 3. 否则插入新行（expires_at 按 type TTL 推导）；
 * 4. 同源其余旧行一律 superseded_by 指向新/合并行（重抽替换该记录旧产出）。
 */
export function ingestExtractions(
  db: Db,
  customerId: number,
  extractions: readonly SignalExtraction[],
  promptVersion: string,
  audit: AuditContext,
): IngestOutcome {
  const outcome: IngestOutcome = { inserted: 0, merged: 0, skipped: 0, superseded: 0 };
  for (const ext of extractions) {
    const topicId =
      ext.topic !== undefined ? resolveOrCreateTopic(db, ext.topic, audit, ext.topicNearest).id : null;
    const keyed = { type: ext.type, topicId, content: ext.content };

    const sameSourceRows =
      ext.sourceId !== null && ext.sourceId !== undefined
        ? repo.listActiveRowsBySource(db, ext.sourceType, ext.sourceId)
        : [];

    if (sameSourceRows.some((r) => r.customerId === customerId && sameFact(r, keyed))) {
      outcome.skipped += 1;
      continue;
    }

    let targetId: number;
    const mergeTarget = repo
      .listActiveRowsByTypeTopic(db, customerId, ext.type, topicId, audit.now)
      .filter(
        (r) =>
          !(ext.sourceId !== null && ext.sourceId !== undefined && r.sourceType === ext.sourceType && r.sourceId === ext.sourceId),
      )
      .find((r) => Math.abs(ext.sourceAt - r.sourceAt) <= 90 * 86_400_000);

    if (mergeTarget) {
      repo.updateSignalRow(db, mergeTarget.id, {
        content: ext.content,
        confidence: Math.max(mergeTarget.confidence, ext.confidence),
        expiresAt: expiresFor(ext.type, ext.sourceAt),
        mentionCount: mergeTarget.mentionCount + 1,
        promptVersion,
        extractedAt: audit.now,
        updatedAt: audit.now,
        updatedBy: audit.userId,
      });
      targetId = mergeTarget.id;
      outcome.merged += 1;
    } else {
      targetId = repo.insertSignalRow(db, {
        customerId,
        type: ext.type,
        topicId,
        content: ext.content,
        sourceType: ext.sourceType,
        sourceId: ext.sourceId ?? null,
        sourceAt: ext.sourceAt,
        mentionCount: 1,
        confidence: ext.confidence,
        expiresAt: expiresFor(ext.type, ext.sourceAt),
        promptVersion,
        extractedAt: audit.now,
        createdAt: audit.now,
        updatedAt: audit.now,
        createdBy: audit.userId,
        updatedBy: audit.userId,
      });
      outcome.inserted += 1;
    }

    for (const old of sameSourceRows) {
      if (old.id === targetId || old.customerId !== customerId) continue;
      // 只取代「本事实的旧版本」（同 type+topic）：同记录抽出的其他事实与其共存
      if (old.type !== keyed.type || old.topicId !== keyed.topicId) continue;
      repo.updateSignalRow(db, old.id, { supersededBy: targetId, updatedAt: audit.now, updatedBy: audit.userId });
      outcome.superseded += 1;
    }
  }
  return outcome;
}

// ── 词表 ──

/** 种子词表：兴趣域标签 + 产品名 + 高频行业值（词表空时一次性预热，幂等；返回建词数） */
export function ensureTopicSeeds(db: Db, audit: AuditContext): number {
  if (repo.countLiveTopics(db) > 0) return 0;
  const names = new Set<string>();
  for (const name of repo.listInterestTagNames(db)) names.add(name);
  for (const name of repo.listLiveProductNames(db)) names.add(name);
  for (const industry of repo.listFrequentIndustries(db, 2, 50)) names.add(industry);

  let created = 0;
  for (const name of names) {
    if (name.length === 0 || name.length > 40) continue;
    repo.insertTopicRow(db, {
      name,
      enabled: 1,
      sort: created,
      createdAt: audit.now,
      updatedAt: audit.now,
      createdBy: audit.userId,
      updatedBy: audit.userId,
    });
    created += 1;
  }
  return created;
}

/** 同义词合并：本词（id）并入 intoId；历史信号 topic_id 全部改指；related 边改挂；本词软删。 */
export function mergeTopicResult(db: Db, id: number, intoId: number, audit: AuditContext) {
  if (id === intoId) {
    throw unprocessable("不能合并到自身", [{ path: "intoId", message: "intoId 必须不同于 id" }]);
  }
  const from = repo.getTopicByIdAny(db, id);
  const into = repo.getTopicByIdAny(db, intoId);
  if (!from || from.deletedAt !== null) throw notFound("词不存在");
  if (!into || into.deletedAt !== null) throw notFound("目标词不存在");

  repo.reassignSignalTopics(db, id, intoId);

  for (const r of repo.listRelationRows(db)) {
    if (r.relatedTopicId === id) {
      repo.deleteRelationRow(db, r.topicId, id);
      if (r.topicId !== intoId) {
        repo.insertRelationRow(db, { topicId: r.topicId, relatedTopicId: intoId, source: r.source, createdAt: audit.now, createdBy: audit.userId });
      }
    }
    if (r.topicId === id) {
      repo.deleteRelationRow(db, id, r.relatedTopicId);
      if (r.relatedTopicId !== intoId) {
        repo.insertRelationRow(db, { topicId: intoId, relatedTopicId: r.relatedTopicId, source: r.source, createdAt: audit.now, createdBy: audit.userId });
      }
    }
  }
  repo.deleteRelationRow(db, id, intoId);
  repo.deleteRelationRow(db, intoId, id);

  repo.updateTopicRow(db, id, { deletedAt: audit.now, updatedAt: audit.now, updatedBy: audit.userId });
  return { id, intoId, merged: true };
}

export function listTopicsResult(db: Db, now: number, page: number, pageSize: number) {
  const stats = repo
    .listTopicStats(db, now)
    .sort((a, b) => b.signalCount - a.signalCount || a.name.localeCompare(b.name, "zh-Hans-CN"));
  const total = stats.length;
  const slice = stats.slice((page - 1) * pageSize, page * pageSize);
  return { data: slice, total };
}
