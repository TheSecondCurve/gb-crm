// K62 insights repo 层：温度事件装配、透视事实、信号与词表 CRUD、抽取入队。
// 全部只读聚合走本文件；写操作（信号 ingest/否决、词表合并）也在此，service 编排规则。
import { and, count, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { TEMPERATURE } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import {
  backgroundJobs,
  channels,
  customerMaintenanceRecords,
  customerSignals,
  customerSourceChannels,
  customerTags,
  customers,
  deals,
  deliveries,
  deliveryCustomers,
  deliveryMaterialCustomers,
  deliveryMaterials,
  deliveryTypes,
  products,
  signalTopicRelations,
  signalTopics,
  tags,
  users,
} from "../../db/schema.js";
import { getAiConfig } from "../system/repo.js";
import type { TemperatureEvent } from "./temperature.js";
import { activeDeliveryWeight } from "./temperature.js";

export type CustomerSignalRow = typeof customerSignals.$inferSelect;
export type SignalTopicRow = typeof signalTopics.$inferSelect;

// ---- 温度事件装配 ----

/** 维护记录事件（kind → 权重在 service/engine 侧按 shared 口径映射） */
export function listMaintenanceEvents(db: Db): { customerId: number; at: number; kind: string }[] {
  return db
    .select({
      customerId: customerMaintenanceRecords.customerId,
      at: customerMaintenanceRecords.happenedAt,
      kind: customerMaintenanceRecords.kind,
    })
    .from(customerMaintenanceRecords)
    .where(isNull(customerMaintenanceRecords.deletedAt))
    .all();
}

/** 成交事件（stage → 权重；at = deal_date） */
export function listDealEvents(db: Db): { customerId: number; at: number; stage: string }[] {
  return db
    .select({ customerId: deals.customerId, at: deals.dealDate, stage: deals.stage })
    .from(deals)
    .where(isNull(deals.deletedAt))
    .all();
}

/** 场次资料事件（transcript/text 关联到客户，at = created_at） */
export function listMaterialSessionEvents(db: Db): { customerId: number; at: number }[] {
  return db
    .select({ customerId: deliveryMaterialCustomers.customerId, at: deliveryMaterials.createdAt })
    .from(deliveryMaterialCustomers)
    .innerJoin(
      deliveryMaterials,
      and(eq(deliveryMaterials.id, deliveryMaterialCustomers.materialId), isNull(deliveryMaterials.deletedAt)),
    )
    .where(inArray(deliveryMaterials.kind, ["transcript", "text"]))
    .all();
}

/** 进行中交付 → 持续接触事件（at = now；权重按活跃周数，见 temperature.activeDeliveryWeight） */
export function listActiveDeliveryEvents(db: Db, now: number): TemperatureEvent[] {
  const rows = db
    .select({
      customerId: deliveryCustomers.customerId,
      anchor: sql<number>`COALESCE(${deliveries.startsAt}, ${deliveries.createdAt})`,
    })
    .from(deliveryCustomers)
    .innerJoin(
      deliveries,
      and(
        eq(deliveries.id, deliveryCustomers.deliveryId),
        isNull(deliveries.deletedAt),
        or(sql`${deliveries.startsAt} IS NULL`, sql`${deliveries.startsAt} <= ${now}`),
        or(sql`${deliveries.endsAt} IS NULL`, sql`${deliveries.endsAt} >= ${now}`),
      ),
    )
    .all();
  return rows.map((r) => ({
    customerId: r.customerId,
    at: now,
    weight: activeDeliveryWeight(r.anchor, now),
  }));
}

/** 全量温度事件（live 客户维度；一次性拉取，内存聚合；权重按 shared 口径映射） */
export function listAllTemperatureEvents(db: Db, now: number): TemperatureEvent[] {
  const w = TEMPERATURE.eventWeights;
  const events: TemperatureEvent[] = [];
  for (const r of listMaintenanceEvents(db)) {
    const weight = w.maintenance[r.kind] ?? 0.5;
    events.push({ customerId: r.customerId, at: r.at, weight });
  }
  for (const r of listDealEvents(db)) {
    const weight = w.deal[r.stage] ?? 0;
    events.push({ customerId: r.customerId, at: r.at, weight });
  }
  for (const r of listMaterialSessionEvents(db)) {
    events.push({ customerId: r.customerId, at: r.at, weight: w.materialSession });
  }
  events.push(...listActiveDeliveryEvents(db, now));
  return events;
}

// ---- 透视事实 ----

export interface PivotCustomerRow {
  id: number;
  nickname: string;
  city: string | null;
  customerType: string;
  ownerId: number | null;
  ownerName: string | null;
}

export function listPivotCustomers(db: Db): PivotCustomerRow[] {
  return db
    .select({
      id: customers.id,
      nickname: customers.nickname,
      city: customers.city,
      customerType: customers.customerType,
      ownerId: customers.ownerId,
      ownerName: users.nickname,
    })
    .from(customers)
    .leftJoin(users, and(eq(users.id, customers.ownerId), isNull(users.deletedAt)))
    .where(isNull(customers.deletedAt))
    .all();
}

export function listCustomerTagRefs(db: Db): { customerId: number; name: string; scope: string }[] {
  return db
    .select({ customerId: customerTags.customerId, name: tags.name, scope: tags.scope })
    .from(customerTags)
    .innerJoin(tags, and(eq(tags.id, customerTags.tagId), isNull(tags.deletedAt)))
    .all();
}

export function listCustomerChannelRefs(db: Db): { customerId: number; name: string }[] {
  return db
    .select({ customerId: customerSourceChannels.customerId, name: channels.name })
    .from(customerSourceChannels)
    .innerJoin(channels, and(eq(channels.id, customerSourceChannels.channelId), isNull(channels.deletedAt)))
    .all();
}

/** live 成交行（价值与阶梯推导用） */
export function listDealFacts(db: Db): {
  customerId: number;
  productId: number | null;
  stage: string;
  amountCents: number | null;
}[] {
  return db
    .select({
      customerId: deals.customerId,
      productId: deals.productId,
      stage: deals.stage,
      amountCents: deals.amountCents,
    })
    .from(deals)
    .where(isNull(deals.deletedAt))
    .all();
}

export function listProductTypes(db: Db): Map<number, string> {
  const rows = db
    .select({ id: products.id, productType: products.productType })
    .from(products)
    .where(isNull(products.deletedAt))
    .all();
  return new Map(rows.map((r) => [r.id, r.productType]));
}

export function listDeliveryRungFacts(db: Db): { customerId: number; kind: string }[] {
  return db
    .select({ customerId: deliveryCustomers.customerId, kind: deliveryTypes.kind })
    .from(deliveryCustomers)
    .innerJoin(
      deliveries,
      and(eq(deliveries.id, deliveryCustomers.deliveryId), isNull(deliveries.deletedAt)),
    )
    .innerJoin(
      deliveryTypes,
      and(eq(deliveryTypes.id, deliveries.deliveryTypeId), isNull(deliveryTypes.deletedAt)),
    )
    .all();
}

/** 有效信号类型集合（有效谓词：未软删 ∧ 未否决 ∧ 未取代 ∧ 未过期） */
export function listActiveSignalTypeRefs(db: Db, now: number): { customerId: number; type: string }[] {
  return db
    .selectDistinct({ customerId: customerSignals.customerId, type: customerSignals.type })
    .from(customerSignals)
    .where(activeSignalWhere(now))
    .all();
}

// ---- 信号 ----

/** 有效信号谓词（K62：状态是推导值，无 status 列） */
export function activeSignalWhere(now: number): SQL {
  return and(
    isNull(customerSignals.deletedAt),
    isNull(customerSignals.rejectedBy),
    isNull(customerSignals.supersededBy),
    or(isNull(customerSignals.expiresAt), gt(customerSignals.expiresAt, now)),
  )!;
}

export interface SignalListFilter {
  customerId?: number;
  type?: string;
  activeOnly: boolean;
  now: number;
  page: number;
  pageSize: number;
}

export function listSignalRows(
  db: Db,
  filter: SignalListFilter,
): { rows: (CustomerSignalRow & { topicName: string | null })[]; total: number } {
  const conditions: SQL[] = [isNull(customerSignals.deletedAt)];
  if (filter.customerId !== undefined) conditions.push(eq(customerSignals.customerId, filter.customerId));
  if (filter.type !== undefined) conditions.push(eq(customerSignals.type, filter.type));
  if (filter.activeOnly) conditions.push(activeSignalWhere(filter.now));
  const where = and(...conditions);

  const rows = db
    .select({ signal: customerSignals, topicName: signalTopics.name })
    .from(customerSignals)
    .leftJoin(signalTopics, eq(signalTopics.id, customerSignals.topicId))
    .where(where)
    .orderBy(desc(customerSignals.sourceAt), desc(customerSignals.id))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize)
    .all();
  const total =
    db.select({ value: count() }).from(customerSignals).where(where).get()?.value ?? 0;
  return { rows: rows.map((r) => ({ ...r.signal, topicName: r.topicName })), total };
}

export function getSignalByIdAny(db: Db, id: number): CustomerSignalRow | undefined {
  return db.select().from(customerSignals).where(eq(customerSignals.id, id)).get();
}

/** 同一出处（source_type + source_id）的有效信号行（重抽时确定要取代的旧行） */
export function listActiveRowsBySource(
  db: Db,
  sourceType: string,
  sourceId: number,
): CustomerSignalRow[] {
  return db
    .select()
    .from(customerSignals)
    .where(
      and(
        isNull(customerSignals.deletedAt),
        isNull(customerSignals.supersededBy),
        isNull(customerSignals.rejectedBy),
        eq(customerSignals.sourceType, sourceType),
        eq(customerSignals.sourceId, sourceId),
      ),
    )
    .all();
}

/** 该客户某出处类型的全部有效信号行（bundle 外来源的清理用，如已删记录） */
export function listActiveRowsByCustomerSourceType(
  db: Db,
  customerId: number,
  sourceType: string,
): CustomerSignalRow[] {
  return db
    .select()
    .from(customerSignals)
    .where(
      and(
        eq(customerSignals.customerId, customerId),
        eq(customerSignals.sourceType, sourceType),
        isNull(customerSignals.deletedAt),
        isNull(customerSignals.supersededBy),
        isNull(customerSignals.rejectedBy),
      ),
    )
    .all();
}

/** 该客户全部 live 维护记录 id（信号清理判活用，与 bundle 条数上限无关） */
export function listLiveRecordIdsByCustomer(db: Db, customerId: number): Set<number> {
  const rows = db
    .select({ id: customerMaintenanceRecords.id })
    .from(customerMaintenanceRecords)
    .where(
      and(
        eq(customerMaintenanceRecords.customerId, customerId),
        isNull(customerMaintenanceRecords.deletedAt),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.id));
}

// ---- 二期决策台查询 ----

/** 每客户最近触点（live 记录 max happened_at，任意 kind） */
export function listLastTouchMap(db: Db): Map<number, number> {
  const rows = db
    .select({
      customerId: customerMaintenanceRecords.customerId,
      lastAt: sql<number>`MAX(${customerMaintenanceRecords.happenedAt})`,
    })
    .from(customerMaintenanceRecords)
    .where(isNull(customerMaintenanceRecords.deletedAt))
    .groupBy(customerMaintenanceRecords.customerId)
    .all();
  return new Map(rows.map((r) => [r.customerId, r.lastAt]));
}

/** 活跃意向/需求信号（带客户昵称），守护台/意图台共用 */
export function listActiveIntentRows(
  db: Db,
  now: number,
): (CustomerSignalRow & { nickname: string; topicName: string | null })[] {
  const rows = db
    .select({ signal: customerSignals, nickname: customers.nickname, topicName: signalTopics.name })
    .from(customerSignals)
    .innerJoin(customers, and(eq(customers.id, customerSignals.customerId), isNull(customers.deletedAt)))
    .leftJoin(signalTopics, eq(signalTopics.id, customerSignals.topicId))
    .where(and(inArray(customerSignals.type, ["intent", "need"]), activeSignalWhere(now)))
    .all();
  return rows.map((r) => ({ ...r.signal, nickname: r.nickname, topicName: r.topicName }));
}

/** 刚过期的意向/需求信号（expires_at 在 (now-withinDays, now]，未否决未取代）——断线哨兵 */
export function listRecentlyExpiredIntentRows(
  db: Db,
  now: number,
  withinDays: number,
): (CustomerSignalRow & { nickname: string; topicName: string | null })[] {
  const rows = db
    .select({ signal: customerSignals, nickname: customers.nickname, topicName: signalTopics.name })
    .from(customerSignals)
    .innerJoin(customers, and(eq(customers.id, customerSignals.customerId), isNull(customers.deletedAt)))
    .leftJoin(signalTopics, eq(signalTopics.id, customerSignals.topicId))
    .where(
      and(
        inArray(customerSignals.type, ["intent", "need"]),
        isNull(customerSignals.deletedAt),
        isNull(customerSignals.rejectedBy),
        isNull(customerSignals.supersededBy),
        sql`${customerSignals.expiresAt} IS NOT NULL AND ${customerSignals.expiresAt} <= ${now} AND ${customerSignals.expiresAt} > ${now - withinDays * 86400000}`,
      ),
    )
    .all();
  return rows.map((r) => ({ ...r.signal, nickname: r.nickname, topicName: r.topicName }));
}

/** 跟进类事件（follow_up/lead 的 happened_at）——断线判定用 */
export function listFollowLikeEvents(db: Db): { customerId: number; at: number }[] {
  return db
    .select({ customerId: customerMaintenanceRecords.customerId, at: customerMaintenanceRecords.happenedAt })
    .from(customerMaintenanceRecords)
    .where(
      and(
        inArray(customerMaintenanceRecords.kind, ["follow_up", "lead"]),
        isNull(customerMaintenanceRecords.deletedAt),
      ),
    )
    .all();
}

/** 圈子/订阅类交付 30 天内到期（续费窗口）：交付名 + 客户 */
export function listUpcomingCircleEnds(
  db: Db,
  now: number,
  withinDays: number,
): { customerId: number; nickname: string; deliveryId: number; deliveryName: string; endsAt: number }[] {
  const rows = db
    .select({
      customerId: deliveryCustomers.customerId,
      nickname: customers.nickname,
      deliveryId: deliveries.id,
      deliveryName: deliveries.name,
      typeName: deliveryTypes.name,
      endsAt: deliveries.endsAt,
    })
    .from(deliveryCustomers)
    .innerJoin(
      deliveries,
      and(
        eq(deliveries.id, deliveryCustomers.deliveryId),
        isNull(deliveries.deletedAt),
        sql`${deliveries.endsAt} IS NOT NULL AND ${deliveries.endsAt} > ${now} AND ${deliveries.endsAt} <= ${now + withinDays * 86400000}`,
      ),
    )
    .innerJoin(
      deliveryTypes,
      and(eq(deliveryTypes.id, deliveries.deliveryTypeId), isNull(deliveryTypes.deletedAt), eq(deliveryTypes.kind, "circle")),
    )
    .innerJoin(customers, and(eq(customers.id, deliveryCustomers.customerId), isNull(customers.deletedAt)))
    .all();
  return rows.map((r) => ({
    customerId: r.customerId,
    nickname: r.nickname,
    deliveryId: r.deliveryId,
    deliveryName: r.deliveryName ?? r.typeName,
    endsAt: r.endsAt as number,
  }));
}

/** 活跃 need/supply 信号（撮合引擎与意图台 topic 聚合用） */
export function listActiveNeedSupplyRows(
  db: Db,
  now: number,
): (CustomerSignalRow & { nickname: string; city: string | null; topicName: string | null })[] {
  const rows = db
    .select({
      signal: customerSignals,
      nickname: customers.nickname,
      city: customers.city,
      topicName: signalTopics.name,
    })
    .from(customerSignals)
    .innerJoin(customers, and(eq(customers.id, customerSignals.customerId), isNull(customers.deletedAt)))
    .leftJoin(signalTopics, eq(signalTopics.id, customerSignals.topicId))
    .where(and(inArray(customerSignals.type, ["need", "supply"]), activeSignalWhere(now)))
    .all();
  return rows.map((r) => ({ ...r.signal, nickname: r.nickname, city: r.city, topicName: r.topicName }));
}

/** 未过期 risk 信号的客户集合（撮合护栏：正在收缩的人不进名单） */
export function listActiveRiskCustomerIds(db: Db, now: number): number[] {
  return db
    .selectDistinct({ customerId: customerSignals.customerId })
    .from(customerSignals)
    .where(and(eq(customerSignals.type, "risk"), activeSignalWhere(now)))
    .all()
    .map((r) => r.customerId);
}

/** 交付归属（customerId → 参与 deliveryId 集合；撮合共同交付加成用） */
export function listDeliveryMembership(db: Db): { customerId: number; deliveryId: number }[] {
  return db
    .select({ customerId: deliveryCustomers.customerId, deliveryId: deliveryCustomers.deliveryId })
    .from(deliveryCustomers)
    .innerJoin(deliveries, and(eq(deliveries.id, deliveryCustomers.deliveryId), isNull(deliveries.deletedAt)))
    .all();
}

/** 跨来源合并候选：同客户同 type 同 topic 的有效行 */
export function listActiveRowsByTypeTopic(
  db: Db,
  customerId: number,
  type: string,
  topicId: number | null,
  now: number,
): CustomerSignalRow[] {
  const conditions: SQL[] = [
    eq(customerSignals.customerId, customerId),
    eq(customerSignals.type, type),
    activeSignalWhere(now),
  ];
  if (topicId === null) conditions.push(isNull(customerSignals.topicId));
  else conditions.push(eq(customerSignals.topicId, topicId));
  return db.select().from(customerSignals).where(and(...conditions)).all();
}

export function insertSignalRow(db: Db, values: typeof customerSignals.$inferInsert): number {
  return Number(db.insert(customerSignals).values(values).run().lastInsertRowid);
}

export function updateSignalRow(
  db: Db,
  id: number,
  set: Partial<typeof customerSignals.$inferInsert>,
): number {
  return db.update(customerSignals).set(set).where(eq(customerSignals.id, id)).run().changes;
}

/** 客户深潜：全部信号（含已取代/已否决历史），最新在前 */
export function listSignalRowsByCustomer(
  db: Db,
  customerId: number,
  limit = 50,
): (CustomerSignalRow & { topicName: string | null })[] {
  const rows = db
    .select({ signal: customerSignals, topicName: signalTopics.name })
    .from(customerSignals)
    .leftJoin(signalTopics, eq(signalTopics.id, customerSignals.topicId))
    .where(and(eq(customerSignals.customerId, customerId), isNull(customerSignals.deletedAt)))
    .orderBy(desc(customerSignals.sourceAt), desc(customerSignals.id))
    .limit(limit)
    .all();
  return rows.map((r) => ({ ...r.signal, topicName: r.topicName }));
}

/** 客户单事件流（温度曲线原料：记录 + 成交 + 场次 + 进行中交付） */
export function listCustomerTemperatureEvents(db: Db, customerId: number, now: number): TemperatureEvent[] {
  const w = TEMPERATURE.eventWeights;
  const events: TemperatureEvent[] = [];
  for (const r of db
    .select({ at: customerMaintenanceRecords.happenedAt, kind: customerMaintenanceRecords.kind })
    .from(customerMaintenanceRecords)
    .where(
      and(
        eq(customerMaintenanceRecords.customerId, customerId),
        isNull(customerMaintenanceRecords.deletedAt),
      ),
    )
    .all()) {
    events.push({ customerId, at: r.at, weight: w.maintenance[r.kind] ?? 0.5 });
  }
  for (const r of db
    .select({ at: deals.dealDate, stage: deals.stage })
    .from(deals)
    .where(and(eq(deals.customerId, customerId), isNull(deals.deletedAt)))
    .all()) {
    events.push({ customerId, at: r.at, weight: w.deal[r.stage] ?? 0 });
  }
  for (const r of db
    .select({ at: deliveryMaterials.createdAt })
    .from(deliveryMaterialCustomers)
    .innerJoin(
      deliveryMaterials,
      and(eq(deliveryMaterials.id, deliveryMaterialCustomers.materialId), isNull(deliveryMaterials.deletedAt)),
    )
    .where(eq(deliveryMaterialCustomers.customerId, customerId))
    .all()) {
    events.push({ customerId, at: r.at, weight: w.materialSession });
  }
  events.push(...listActiveDeliveryEvents(db, now).filter((e) => e.customerId === customerId));
  return events;
}

// ---- 词表 ----

export function findLiveTopicByName(db: Db, name: string): SignalTopicRow | undefined {
  return db
    .select()
    .from(signalTopics)
    .where(and(eq(signalTopics.name, name), isNull(signalTopics.deletedAt)))
    .get();
}

export function insertTopicRow(db: Db, values: typeof signalTopics.$inferInsert): number {
  return Number(db.insert(signalTopics).values(values).run().lastInsertRowid);
}

export function countLiveTopics(db: Db): number {
  return db.select({ value: count() }).from(signalTopics).where(isNull(signalTopics.deletedAt)).get()?.value ?? 0;
}

export function listLiveTopicRows(db: Db): SignalTopicRow[] {
  return db.select().from(signalTopics).where(isNull(signalTopics.deletedAt)).all();
}

export function getTopicByIdAny(db: Db, id: number): SignalTopicRow | undefined {
  return db.select().from(signalTopics).where(eq(signalTopics.id, id)).get();
}

export function updateTopicRow(db: Db, id: number, set: Partial<typeof signalTopics.$inferInsert>): number {
  return db.update(signalTopics).set(set).where(eq(signalTopics.id, id)).run().changes;
}

/** related 边（双向查询用：含正向与反向） */
export function listRelationRows(db: Db): { topicId: number; relatedTopicId: number; source: string }[] {
  return db.select().from(signalTopicRelations).all();
}

export function insertRelationRow(db: Db, values: typeof signalTopicRelations.$inferInsert): void {
  db.insert(signalTopicRelations).values(values).onConflictDoNothing().run();
}

export function deleteRelationRow(db: Db, topicId: number, relatedTopicId: number): void {
  db.delete(signalTopicRelations)
    .where(and(eq(signalTopicRelations.topicId, topicId), eq(signalTopicRelations.relatedTopicId, relatedTopicId)))
    .run();
}

/** 词表统计（健康度 + 列表页）：每词有效信号数 / 需求数 / 供给数 / related 词名 */
export interface TopicStatsRow {
  id: number;
  name: string;
  enabled: number;
  signalCount: number;
  needCount: number;
  supplyCount: number;
  relatedNames: string[];
}

export function listTopicStats(db: Db, now: number): TopicStatsRow[] {
  const topics = listLiveTopicRows(db);
  const byTopic = new Map<number, TopicStatsRow>(
    topics.map((t) => [t.id, { id: t.id, name: t.name, enabled: t.enabled, signalCount: 0, needCount: 0, supplyCount: 0, relatedNames: [] }]),
  );
  const active = db.select().from(customerSignals).where(activeSignalWhere(now)).all();
  for (const s of active) {
    if (s.topicId === null) continue;
    const row = byTopic.get(s.topicId);
    if (!row) continue;
    row.signalCount += 1;
    if (s.type === "need") row.needCount += 1;
    if (s.type === "supply") row.supplyCount += 1;
  }
  const nameById = new Map(topics.map((t) => [t.id, t.name]));
  for (const r of listRelationRows(db)) {
    byTopic.get(r.topicId)?.relatedNames.push(nameById.get(r.relatedTopicId) ?? `#${r.relatedTopicId}`);
    byTopic.get(r.relatedTopicId)?.relatedNames.push(nameById.get(r.topicId) ?? `#${r.topicId}`);
  }
  return [...byTopic.values()];
}

/** 合并词：历史信号（含已取代/已否决）topic_id 全部改指 intoId */
export function reassignSignalTopics(db: Db, fromId: number, toId: number): void {
  db.update(customerSignals).set({ topicId: toId }).where(eq(customerSignals.topicId, fromId)).run();
}

// ---- 抽取入队（事件通道；agent SQL 直写记录不经 routes → 夜间扫尾兜底） ----

/** LLM 三要素齐备才入队（未配置时静默跳过，绝不影响记录落库） */
export function isLlmReady(db: Db): boolean {
  const cfg = getAiConfig(db);
  return Boolean(cfg?.apiKey && cfg?.baseUrl && cfg?.model);
}

export function enqueueSignalExtract(
  db: Db,
  customerId: number,
  audit: { now: number; userId: number | null },
): void {
  if (!isLlmReady(db)) return;
  db.insert(backgroundJobs)
    .values({
      type: "insights-signal-extract",
      params: JSON.stringify({ customerId }),
      status: "queued",
      progress: JSON.stringify({ processed: 0, total: 0, succeeded: 0, failed: 0 }),
      trigger: "manual",
      createdAt: audit.now,
      createdBy: audit.userId,
    })
    .run();
}

// ---- 词表种子原料 ----

/** 兴趣域 live 标签名（domain=customer ∧ scope=interest ∧ enabled） */
export function listInterestTagNames(db: Db): string[] {
  return db
    .select({ name: tags.name })
    .from(tags)
    .where(
      and(
        eq(tags.domain, "customer"),
        eq(tags.scope, "interest"),
        eq(tags.enabled, 1),
        isNull(tags.deletedAt),
      ),
    )
    .all()
    .map((r) => r.name);
}

/** live 产品名 */
export function listLiveProductNames(db: Db): string[] {
  return db
    .select({ name: products.name })
    .from(products)
    .where(isNull(products.deletedAt))
    .all()
    .map((r) => r.name);
}

/** 高频行业值（≥ minCount 的 live 客户 industry，按频次降序取 topN） */
export function listFrequentIndustries(db: Db, minCount: number, topN: number): string[] {
  return db
    .select({ industry: customers.industry, value: count() })
    .from(customers)
    .where(and(isNull(customers.deletedAt), sql`${customers.industry} IS NOT NULL AND ${customers.industry} <> ''`))
    .groupBy(customers.industry)
    .having(sql`count(*) >= ${minCount}`)
    .orderBy(desc(count()))
    .limit(topN)
    .all()
    .map((r) => r.industry!)
    .filter((v): v is string => v !== null);
}

// ---- 抽取目标 ----

/** 抽取文本 bundle：客户档案文本 + live 维护记录（最新在前，条数/单条长度封顶控成本） */
export interface CustomerTextBundle {
  customerId: number;
  nickname: string;
  texts: { sourceType: "maintenance_record" | "origin_story" | "note"; sourceId: number | null; sourceAt: number; content: string }[];
}

export function listCustomerTextBundle(db: Db, customerId: number, maxRecords = 50, maxChars = 2000): CustomerTextBundle | undefined {
  const customer = db
    .select({ id: customers.id, nickname: customers.nickname, originStory: customers.originStory, notes: customers.notes, createdAt: customers.createdAt })
    .from(customers)
    .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
    .get();
  if (!customer) return undefined;

  const texts: CustomerTextBundle["texts"] = [];
  if (customer.originStory && customer.originStory.trim()) {
    texts.push({ sourceType: "origin_story", sourceId: null, sourceAt: customer.createdAt, content: customer.originStory.slice(0, maxChars) });
  }
  if (customer.notes && customer.notes.trim()) {
    texts.push({ sourceType: "note", sourceId: null, sourceAt: customer.createdAt, content: customer.notes.slice(0, maxChars) });
  }
  for (const r of db
    .select({ id: customerMaintenanceRecords.id, kind: customerMaintenanceRecords.kind, happenedAt: customerMaintenanceRecords.happenedAt, content: customerMaintenanceRecords.content })
    .from(customerMaintenanceRecords)
    .where(and(eq(customerMaintenanceRecords.customerId, customerId), isNull(customerMaintenanceRecords.deletedAt)))
    .orderBy(desc(customerMaintenanceRecords.happenedAt), desc(customerMaintenanceRecords.id))
    .limit(maxRecords)
    .all()) {
    if (!r.content || !r.content.trim()) continue;
    texts.push({
      sourceType: "maintenance_record",
      sourceId: r.id,
      sourceAt: r.happenedAt,
      content: `[${r.kind}] ${r.content}`.slice(0, maxChars),
    });
  }
  return { customerId, nickname: customer.nickname, texts };
}

/** 扫尾目标：有记录比该客户最近一次抽取更新（agent SQL 直写路径的兜底） */
export function listStaleCustomerIds(db: Db): number[] {
  return db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        isNull(customers.deletedAt),
        sql`EXISTS (
          SELECT 1 FROM customer_maintenance_records r
          WHERE r.customer_id = ${customers.id} AND r.deleted_at IS NULL
            AND r.updated_at > COALESCE((
              SELECT MAX(s.extracted_at) FROM customer_signals s
              WHERE s.customer_id = ${customers.id} AND s.deleted_at IS NULL
            ), 0)
        )`,
      ),
    )
    .all()
    .map((r) => r.id);
}
