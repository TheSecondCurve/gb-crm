// deals 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// list 排除软删；COUNT 与列表同一 WHERE（§9）。K42：customer/product/owner 单值 FK，
// 过滤按等值匹配；校验用 findLive*Ids（FK 存在且未软删）。
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { DealListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { customers, deals, products, users } from "../../db/schema.js";
import { fuzzyWhere } from "../../lib/fuzzy.js";
import { toOffset } from "../../lib/pagination.js";

export type DealRow = typeof deals.$inferSelect;

/** q 搜索列（§9，SQL 列名）：order_no,payment_remark */
const SEARCH_COLUMNS = [deals.orderNo, deals.paymentRemark];

// 每资源独立 sort enum（K21）；deals: updatedAt | createdAt | dealDate | deliveryDate
const SORT_COLUMNS = {
  updatedAt: deals.updatedAt,
  createdAt: deals.createdAt,
  dealDate: deals.dealDate,
  deliveryDate: deals.deliveryDate,
} as const;

function listWhere(query: DealListQuery): SQL | undefined {
  const conditions: SQL[] = [isNull(deals.deletedAt)];
  const fuzzy = fuzzyWhere(query.q ?? "", SEARCH_COLUMNS);
  if (fuzzy) conditions.push(fuzzy);
  if (query.stage !== undefined) conditions.push(eq(deals.stage, query.stage));
  // K44：按意向产品（productId 等值）过滤成交（前端「按意向产品 merge 客户」依赖）
  if (query.productType !== undefined) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM products p WHERE p.id = deals.product_id AND p.product_type = ${query.productType}
      )`,
    );
  }
  if (query.customerId !== undefined) conditions.push(eq(deals.customerId, query.customerId));
  if (query.productId !== undefined) conditions.push(eq(deals.productId, query.productId));
  if (query.ownerId !== undefined) conditions.push(eq(deals.ownerId, query.ownerId));
  return and(...conditions);
}

export function listDeals(db: Db, query: DealListQuery): { rows: DealRow[]; total: number } {
  const where = listWhere(query);
  // 默认 sort=updatedAt&order=desc，并列 id DESC（§9）
  const sortCol = SORT_COLUMNS[query.sort ?? "updatedAt"];
  const dir = query.order === "asc" ? asc : desc;

  const rows = db
    .select()
    .from(deals)
    .where(where)
    .orderBy(dir(sortCol), desc(deals.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(deals).where(where).get()?.value ?? 0;
  return { rows, total };
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getDealByIdAny(db: Db, id: number): DealRow | undefined {
  return db.select().from(deals).where(eq(deals.id, id)).get();
}

export function insertDeal(db: Db, values: typeof deals.$inferInsert): number {
  return Number(db.insert(deals).values(values).run().lastInsertRowid);
}

/**
 * PATCH 内核 + 行级 OCC（K24）：
 * UPDATE 仅 SET 出现的键（调用方拼好，含 updated_at/updated_by bump），
 * WHERE id=? AND updated_at=? AND deleted_at IS NULL。返回受影响行数。
 */
export function occUpdateDeal(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof deals.$inferInsert>,
): number {
  return db
    .update(deals)
    .set(set)
    .where(
      and(eq(deals.id, id), eq(deals.updatedAt, expectedUpdatedAt), isNull(deals.deletedAt)),
    )
    .run().changes;
}

/** 软删：deleted_at=now；返回受影响行数（0 = 不存在或已删） */
export function softDeleteDeal(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(deals)
    .set(set)
    .where(and(eq(deals.id, id), isNull(deals.deletedAt)))
    .run().changes;
}

/** 返回 ids 中仍然 live 的客户 id 集合（FK 校验：软删/不存在 → 422） */
export function findLiveCustomerIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: customers.id })
    .from(customers)
    .where(and(inArray(customers.id, [...ids]), isNull(customers.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** 返回 ids 中仍然 live 的产品 id 集合（FK 校验用） */
export function findLiveProductIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: products.id })
    .from(products)
    .where(and(inArray(products.id, [...ids]), isNull(products.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** 返回 ids 中仍然 live 的用户 id 集合（负责人 FK 校验用） */
export function findLiveUserIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

// ---- K47 客户总览统计 ----

/** 该客户 live 成交，最新在前（dealDate DESC，并列 id DESC），上限 limit */
export function listLiveDealsByCustomer(
  db: Db,
  customerId: number,
  limit = 100,
): DealRow[] {
  return db
    .select()
    .from(deals)
    .where(and(eq(deals.customerId, customerId), isNull(deals.deletedAt)))
    .orderBy(desc(deals.dealDate), desc(deals.id))
    .limit(limit)
    .all();
}

export function countLiveDealsByCustomer(db: Db, customerId: number): number {
  return (
    db
      .select({ value: count() })
      .from(deals)
      .where(and(eq(deals.customerId, customerId), isNull(deals.deletedAt)))
      .get()?.value ?? 0
  );
}

/** stage=paid 的 amountCents 合计（null 金额计 0）；无成交 0 */
export function paidTotalCentsByCustomer(db: Db, customerId: number): number {
  const row = db
    .select({ value: sql<number>`COALESCE(SUM(${deals.amountCents}), 0)` })
    .from(deals)
    .where(and(eq(deals.customerId, customerId), eq(deals.stage, "paid"), isNull(deals.deletedAt)))
    .get();
  return Number(row?.value ?? 0);
}

/** 最近成交时间：MAX(deal_date)；无成交 null */
export function lastDealAtByCustomer(db: Db, customerId: number): number | null {
  const row = db
    .select({ value: sql<number>`MAX(${deals.dealDate})` })
    .from(deals)
    .where(and(eq(deals.customerId, customerId), isNull(deals.deletedAt)))
    .get();
  return row?.value === null || row?.value === undefined ? null : Number(row.value);
}
