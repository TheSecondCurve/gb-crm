// deal-commissions 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// K56：以「成交」为粒度，deal_commissions（deal_id 唯一、懒生成）+ deal_commission_items（每行一人）。
// 列表 = deals LEFT JOIN deal_commissions（未配置 → commission_id NULL，读取时套默认方案）。
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";

import type { DealCommissionListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import {
  customers,
  dealCommissionItems,
  dealCommissions,
  deals,
  products,
  users,
} from "../../db/schema.js";
import { fuzzyWhere } from "../../lib/fuzzy.js";
import { toOffset } from "../../lib/pagination.js";

/** 列表/单条查询的 joined 行（deal + live 客户/负责人 ref + 是否存在 commission 行） */
export interface CommissionJoinRow {
  dealId: number;
  dealDeletedAt: number | null;
  customerId: number;
  customerNickname: string | null;
  customerCity: string | null;
  customerOwnerId: number | null;
  customerDeletedAt: number | null;
  ownerId: number | null;
  ownerNickname: string | null;
  ownerDeletedAt: number | null;
  stage: string;
  orderNo: string | null;
  paymentRemark: string | null;
  dealDate: number;
  deliveryDate: number | null;
  amountCents: number | null;
  afterTaxRatio: number | null;
  productId: number | null;
  productName: string | null;
  productDeletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  commissionId: number | null;
  commissionConfiguredAt: number | null;
}

export interface CommissionItemRow {
  commissionId: number;
  userId: number;
  percentage: number;
}

/** 成交日期列：deal_date 非空，直接取成交日期（K24/K56 语义） */
const DEAL_DATE = deals.dealDate;

function commissionListWhere(query: DealCommissionListQuery): SQL | undefined {
  const conditions: SQL[] = [isNull(deals.deletedAt)];
  const fuzzy = fuzzyWhere(query.q ?? "", [deals.orderNo, deals.paymentRemark]);
  if (fuzzy) conditions.push(fuzzy);
  if (query.startDate !== undefined) conditions.push(sql`${DEAL_DATE} >= ${query.startDate}`);
  if (query.endDate !== undefined) conditions.push(sql`${DEAL_DATE} <= ${query.endDate}`);
  if (query.status === "custom") {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM deal_commissions dc WHERE dc.deal_id = ${deals.id})`,
    );
  } else if (query.status === "default") {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM deal_commissions dc WHERE dc.deal_id = ${deals.id})`,
    );
  }
  return and(...conditions);
}

const JOIN_SELECT = {
  dealId: deals.id,
  dealDeletedAt: deals.deletedAt,
  customerId: deals.customerId,
  customerNickname: customers.nickname,
  customerCity: customers.city,
  customerOwnerId: customers.ownerId,
  customerDeletedAt: customers.deletedAt,
  ownerId: deals.ownerId,
  ownerNickname: users.nickname,
  ownerDeletedAt: users.deletedAt,
  stage: deals.stage,
  orderNo: deals.orderNo,
  paymentRemark: deals.paymentRemark,
  dealDate: deals.dealDate,
  deliveryDate: deals.deliveryDate,
  amountCents: deals.amountCents,
  afterTaxRatio: deals.afterTaxRatio,
  productId: deals.productId,
  productName: products.name,
  productDeletedAt: products.deletedAt,
  createdAt: deals.createdAt,
  updatedAt: deals.updatedAt,
  commissionId: dealCommissions.id,
  commissionConfiguredAt: dealCommissions.configuredAt,
};

export function listCommissionRows(
  db: Db,
  query: DealCommissionListQuery,
): { rows: CommissionJoinRow[]; total: number } {
  const where = commissionListWhere(query);
  const dir = query.order === "asc" ? asc : desc;

  const rows = db
    .select(JOIN_SELECT)
    .from(deals)
    .leftJoin(customers, eq(customers.id, deals.customerId))
    .leftJoin(users, eq(users.id, deals.ownerId))
    .leftJoin(products, eq(products.id, deals.productId))
    .leftJoin(dealCommissions, eq(dealCommissions.dealId, deals.id))
    .where(where)
    .orderBy(dir(deals.updatedAt), desc(deals.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(deals).where(where).get()?.value ?? 0;
  return { rows, total };
}

/** 导出：同列表 WHERE，不分页取全部匹配行（复用同一 join 与排序） */
export function listAllCommissionRows(
  db: Db,
  query: DealCommissionListQuery,
): CommissionJoinRow[] {
  const where = commissionListWhere(query);
  const dir = query.order === "asc" ? asc : desc;
  return db
    .select(JOIN_SELECT)
    .from(deals)
    .leftJoin(customers, eq(customers.id, deals.customerId))
    .leftJoin(users, eq(users.id, deals.ownerId))
    .leftJoin(products, eq(products.id, deals.productId))
    .leftJoin(dealCommissions, eq(dealCommissions.dealId, deals.id))
    .where(where)
    .orderBy(dir(deals.updatedAt), desc(deals.id))
    .all();
}

/** 单条成交的 joined 行（含不存在/软删成交 → undefined 由 service 判 404） */
export function getCommissionJoinRow(db: Db, dealId: number): CommissionJoinRow | undefined {
  return db
    .select(JOIN_SELECT)
    .from(deals)
    .leftJoin(customers, eq(customers.id, deals.customerId))
    .leftJoin(users, eq(users.id, deals.ownerId))
    .leftJoin(products, eq(products.id, deals.productId))
    .leftJoin(dealCommissions, eq(dealCommissions.dealId, deals.id))
    .where(eq(deals.id, dealId))
    .get();
}

/** 批量拉取指定 commission 的明细（一成交人一行） */
export function listItemsByCommissionIds(
  db: Db,
  commissionIds: readonly number[],
): CommissionItemRow[] {
  if (commissionIds.length === 0) return [];
  return db
    .select({
      commissionId: dealCommissionItems.dealCommissionId,
      userId: dealCommissionItems.userId,
      percentage: dealCommissionItems.percentage,
    })
    .from(dealCommissionItems)
    .where(inArray(dealCommissionItems.dealCommissionId, [...commissionIds]))
    .all();
}

/** 是否存在自定义配置行 */
export function getCommissionRowByDealId(db: Db, dealId: number) {
  return db.select().from(dealCommissions).where(eq(dealCommissions.dealId, dealId)).get();
}

/** 插入一条自定义配置，返回 id */
export function insertCommissionRow(
  db: Db,
  values: typeof dealCommissions.$inferInsert,
): number {
  return Number(db.insert(dealCommissions).values(values).run().lastInsertRowid);
}

/** 追加审计列（配置时间/更新人）——行级 OCC 不做（低频财务配置，单资源单写） */
export function updateCommissionConfig(
  db: Db,
  id: number,
  set: { configuredAt: number; configuredBy: number | null; updatedAt: number; updatedBy: number | null },
): void {
  db.update(dealCommissions).set(set).where(eq(dealCommissions.id, id)).run();
}

export function deleteCommissionItems(db: Db, commissionId: number): void {
  db.delete(dealCommissionItems).where(eq(dealCommissionItems.dealCommissionId, commissionId)).run();
}

export function deleteCommissionRowByDealId(db: Db, dealId: number): void {
  db.delete(dealCommissions).where(eq(dealCommissions.dealId, dealId)).run();
}

export function insertCommissionItem(
  db: Db,
  values: typeof dealCommissionItems.$inferInsert,
): void {
  db.insert(dealCommissionItems).values(values).run();
}

/** 返回 ids 中仍然 live 的用户 id 集合（明细/默认方案 user 规则的 FK 校验用） */
export function findLiveUserIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** 批量拉取 live 用户 ref（昵称；软删/不存在跳过 → null） */
export function listLiveUserRefs(db: Db, ids: readonly number[]): Map<number, { id: number; nickname: string }> {
  const map = new Map<number, { id: number; nickname: string }>();
  if (ids.length === 0) return map;
  const rows = db
    .select({ id: users.id, nickname: users.nickname })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
    .all();
  for (const u of rows) map.set(u.id, { id: u.id, nickname: u.nickname });
  return map;
}
