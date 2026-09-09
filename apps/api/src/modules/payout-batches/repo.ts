// payout-batches 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// K59：payout_batches（状态机 draft→locked→paid）+ payout_batch_items（按 (deal_id, seq) 引用
// deal_payouts；锁定时快照 amount_cents/payout_date/rate）+ payout_batch_item_shares（锁定时物化的人均分摊）。
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { PayoutBatchCandidatesQuery, PayoutBatchListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import {
  customers,
  dealCommissions,
  dealPayouts,
  deals,
  payoutBatchItemShares,
  payoutBatchItems,
  payoutBatches,
  products,
  users,
} from "../../db/schema.js";
import { toOffset } from "../../lib/pagination.js";

export interface PayoutBatchRow {
  id: number;
  name: string;
  rangeStart: number;
  rangeEnd: number;
  status: string;
  lockedAt: number | null;
  paidAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: number | null;
  /** 创建人昵称（软删/不存在 → null） */
  createdByNickname: string | null;
}

const BATCH_SELECT = {
  id: payoutBatches.id,
  name: payoutBatches.name,
  rangeStart: payoutBatches.rangeStart,
  rangeEnd: payoutBatches.rangeEnd,
  status: payoutBatches.status,
  lockedAt: payoutBatches.lockedAt,
  paidAt: payoutBatches.paidAt,
  createdAt: payoutBatches.createdAt,
  updatedAt: payoutBatches.updatedAt,
  createdBy: payoutBatches.createdBy,
  createdByNickname: users.nickname,
} as const;

const liveCreatedByJoin = and(
  eq(users.id, payoutBatches.createdBy),
  isNull(users.deletedAt),
);

export function listBatchRows(
  db: Db,
  query: PayoutBatchListQuery,
): { rows: PayoutBatchRow[]; total: number } {
  const conditions: SQL[] = [];
  if (query.status !== undefined) conditions.push(eq(payoutBatches.status, query.status));
  const where = conditions.length === 0 ? undefined : and(...conditions);

  const rows = db
    .select(BATCH_SELECT)
    .from(payoutBatches)
    .leftJoin(users, liveCreatedByJoin)
    .where(where)
    .orderBy(desc(payoutBatches.createdAt), desc(payoutBatches.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(payoutBatches).where(where).get()?.value ?? 0;
  return { rows, total };
}

export function getBatchRow(db: Db, id: number): PayoutBatchRow | undefined {
  return db
    .select(BATCH_SELECT)
    .from(payoutBatches)
    .leftJoin(users, liveCreatedByJoin)
    .where(eq(payoutBatches.id, id))
    .get();
}

/** 批次的明细数与金额合计（liveTotal=底层 deal_payouts 实时 sum；snapshotTotal=锁定快照 sum） */
export interface BatchItemStats {
  batchId: number;
  itemCount: number;
  liveTotalCents: number;
  snapshotTotalCents: number;
}

export function itemStatsByBatchIds(db: Db, batchIds: readonly number[]): BatchItemStats[] {
  if (batchIds.length === 0) return [];
  return db
    .select({
      batchId: payoutBatchItems.batchId,
      itemCount: count(),
      liveTotalCents: sql<number>`coalesce(sum(${dealPayouts.amountCents}), 0)`.mapWith(Number),
      snapshotTotalCents: sql<number>`coalesce(sum(${payoutBatchItems.amountCents}), 0)`.mapWith(
        Number,
      ),
    })
    .from(payoutBatchItems)
    .leftJoin(
      dealPayouts,
      and(
        eq(dealPayouts.dealId, payoutBatchItems.dealId),
        eq(dealPayouts.seq, payoutBatchItems.seq),
      ),
    )
    .where(inArray(payoutBatchItems.batchId, [...batchIds]))
    .groupBy(payoutBatchItems.batchId)
    .all();
}

/** 待发 payout 候选行（join 成交/客户/产品/负责人 + 活跃批次占用标注） */
export interface PayoutCandidateRow {
  dealId: number;
  seq: number;
  payoutDate: number;
  rate: number;
  amountCents: number;
  dealDate: number;
  dealAmountCents: number | null;
  customerId: number;
  customerNickname: string | null;
  customerDeletedAt: number | null;
  customerOwnerId: number | null;
  productId: number | null;
  productName: string | null;
  productDeletedAt: number | null;
  ownerId: number | null;
  ownerNickname: string | null;
  ownerDeletedAt: number | null;
  commissionId: number | null;
  /** 已在 draft/locked 批次 → 该批次 id/name（原子性防重付，K59） */
  activeBatchId: number | null;
  activeBatchName: string | null;
}

const ACTIVE_BATCH_SUBQUERY = (column: "id" | "name") => sql`
  (SELECT b.${sql.raw(column)} FROM payout_batch_items i
   JOIN payout_batches b ON b.id = i.batch_id
   WHERE i.deal_id = ${dealPayouts.dealId} AND i.seq = ${dealPayouts.seq}
     AND b.status IN ('draft','locked')
   LIMIT 1)`;

export function listCandidateRows(
  db: Db,
  query: PayoutBatchCandidatesQuery,
): PayoutCandidateRow[] {
  const conditions: SQL[] = [isNull(deals.deletedAt), eq(dealPayouts.status, "pending")];
  if (query.startDate !== undefined)
    conditions.push(sql`${dealPayouts.payoutDate} >= ${query.startDate}`);
  if (query.endDate !== undefined)
    conditions.push(sql`${dealPayouts.payoutDate} <= ${query.endDate}`);
  return db
    .select({
      dealId: dealPayouts.dealId,
      seq: dealPayouts.seq,
      payoutDate: dealPayouts.payoutDate,
      rate: dealPayouts.rate,
      amountCents: dealPayouts.amountCents,
      dealDate: deals.dealDate,
      dealAmountCents: deals.amountCents,
      customerId: deals.customerId,
      customerNickname: customers.nickname,
      customerDeletedAt: customers.deletedAt,
      customerOwnerId: customers.ownerId,
      productId: deals.productId,
      productName: products.name,
      productDeletedAt: products.deletedAt,
      ownerId: deals.ownerId,
      ownerNickname: users.nickname,
      ownerDeletedAt: users.deletedAt,
      commissionId: dealCommissions.id,
      activeBatchId: sql<number | null>`${ACTIVE_BATCH_SUBQUERY("id")}`.mapWith(
        (v) => (v === null ? null : Number(v)),
      ),
      activeBatchName: sql<string | null>`${ACTIVE_BATCH_SUBQUERY("name")}`,
    })
    .from(dealPayouts)
    .innerJoin(deals, eq(deals.id, dealPayouts.dealId))
    .leftJoin(customers, eq(customers.id, deals.customerId))
    .leftJoin(users, eq(users.id, deals.ownerId))
    .leftJoin(products, eq(products.id, deals.productId))
    .leftJoin(dealCommissions, eq(dealCommissions.dealId, deals.id))
    .where(and(...conditions))
    .orderBy(asc(dealPayouts.payoutDate), asc(dealPayouts.dealId), asc(dealPayouts.seq))
    .all();
}

/** 批次明细行（item + 成交/客户/产品/负责人展开 + 快照列） */
export interface BatchItemRow {
  id: number;
  batchId: number;
  dealId: number;
  seq: number;
  snapshotAmountCents: number | null;
  snapshotPayoutDate: number | null;
  snapshotRate: number | null;
  dealDate: number;
  dealAmountCents: number | null;
  customerId: number;
  customerNickname: string | null;
  customerDeletedAt: number | null;
  customerOwnerId: number | null;
  productId: number | null;
  productName: string | null;
  productDeletedAt: number | null;
  ownerId: number | null;
  ownerNickname: string | null;
  ownerDeletedAt: number | null;
  commissionId: number | null;
}

export function listBatchItemRows(db: Db, batchId: number): BatchItemRow[] {
  return db
    .select({
      id: payoutBatchItems.id,
      batchId: payoutBatchItems.batchId,
      dealId: payoutBatchItems.dealId,
      seq: payoutBatchItems.seq,
      snapshotAmountCents: payoutBatchItems.amountCents,
      snapshotPayoutDate: payoutBatchItems.payoutDate,
      snapshotRate: payoutBatchItems.rate,
      dealDate: deals.dealDate,
      dealAmountCents: deals.amountCents,
      customerId: deals.customerId,
      customerNickname: customers.nickname,
      customerDeletedAt: customers.deletedAt,
      customerOwnerId: customers.ownerId,
      productId: deals.productId,
      productName: products.name,
      productDeletedAt: products.deletedAt,
      ownerId: deals.ownerId,
      ownerNickname: users.nickname,
      ownerDeletedAt: users.deletedAt,
      commissionId: dealCommissions.id,
    })
    .from(payoutBatchItems)
    .innerJoin(deals, eq(deals.id, payoutBatchItems.dealId))
    .leftJoin(customers, eq(customers.id, deals.customerId))
    .leftJoin(users, eq(users.id, deals.ownerId))
    .leftJoin(products, eq(products.id, deals.productId))
    .leftJoin(dealCommissions, eq(dealCommissions.dealId, deals.id))
    .where(eq(payoutBatchItems.batchId, batchId))
    .orderBy(asc(payoutBatchItems.id))
    .all();
}

export interface ShareRow {
  itemId: number;
  userId: number;
  amountCents: number;
}

export function listSharesByItemIds(db: Db, itemIds: readonly number[]): ShareRow[] {
  if (itemIds.length === 0) return [];
  return db
    .select({
      itemId: payoutBatchItemShares.itemId,
      userId: payoutBatchItemShares.userId,
      amountCents: payoutBatchItemShares.amountCents,
    })
    .from(payoutBatchItemShares)
    .where(inArray(payoutBatchItemShares.itemId, [...itemIds]))
    .orderBy(asc(payoutBatchItemShares.id))
    .all();
}

export function getBatchItemRow(db: Db, batchId: number, itemId: number) {
  return db
    .select()
    .from(payoutBatchItems)
    .where(and(eq(payoutBatchItems.id, itemId), eq(payoutBatchItems.batchId, batchId)))
    .get();
}

/** 该 payout 在任一 draft/locked 批次中的占位（含本批次）；paid 批次不算占用 */
export function findActiveBatchItem(
  db: Db,
  dealId: number,
  seq: number,
): { itemId: number; batchId: number; batchName: string } | undefined {
  return db
    .select({
      itemId: payoutBatchItems.id,
      batchId: payoutBatches.id,
      batchName: payoutBatches.name,
    })
    .from(payoutBatchItems)
    .innerJoin(payoutBatches, eq(payoutBatches.id, payoutBatchItems.batchId))
    .where(
      and(
        eq(payoutBatchItems.dealId, dealId),
        eq(payoutBatchItems.seq, seq),
        inArray(payoutBatches.status, ["draft", "locked"]),
      ),
    )
    .get();
}

export function insertBatch(db: Db, values: typeof payoutBatches.$inferInsert): number {
  return Number(db.insert(payoutBatches).values(values).run().lastInsertRowid);
}

export function insertBatchItem(db: Db, values: typeof payoutBatchItems.$inferInsert): number {
  return Number(db.insert(payoutBatchItems).values(values).run().lastInsertRowid);
}

export function updateBatch(
  db: Db,
  id: number,
  set: Partial<{
    name: string;
    status: string;
    lockedAt: number | null;
    paidAt: number | null;
    updatedAt: number;
    updatedBy: number | null;
  }>,
): void {
  db.update(payoutBatches).set(set).where(eq(payoutBatches.id, id)).run();
}

export function deleteBatch(db: Db, id: number): void {
  db.delete(payoutBatches).where(eq(payoutBatches.id, id)).run();
}

export function deleteBatchItem(db: Db, itemId: number): void {
  db.delete(payoutBatchItems).where(eq(payoutBatchItems.id, itemId)).run();
}

/** 锁定时写入快照（amount/payoutDate/rate） */
export function snapshotItem(
  db: Db,
  itemId: number,
  set: {
    amountCents: number;
    payoutDate: number;
    rate: number;
    updatedAt: number;
    updatedBy: number | null;
  },
): void {
  db.update(payoutBatchItems).set(set).where(eq(payoutBatchItems.id, itemId)).run();
}

/** unlock：清空批次全部明细的快照列 */
export function clearItemSnapshots(
  db: Db,
  batchId: number,
  set: { updatedAt: number; updatedBy: number | null },
): void {
  db.update(payoutBatchItems)
    .set({ amountCents: null, payoutDate: null, rate: null, ...set })
    .where(eq(payoutBatchItems.batchId, batchId))
    .run();
}

export function deleteSharesByItemIds(db: Db, itemIds: readonly number[]): void {
  if (itemIds.length === 0) return;
  db.delete(payoutBatchItemShares)
    .where(inArray(payoutBatchItemShares.itemId, [...itemIds]))
    .run();
}

export function insertShare(db: Db, values: typeof payoutBatchItemShares.$inferInsert): void {
  db.insert(payoutBatchItemShares).values(values).run();
}
