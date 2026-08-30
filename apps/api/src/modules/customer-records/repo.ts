// customer_maintenance_records 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// 按 customer_id 分页读（默认 happened_at DESC, id DESC）；kind 等值过滤；软删排除。
// K55：FK 校验（findLiveCustomerIds）；总览用 count/listRecent；lastFollowedAt 联动（bump）。
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { MaintenanceRecordListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { customerMaintenanceRecords, customers, users } from "../../db/schema.js";
import { toOffset } from "../../lib/pagination.js";

export type CustomerMaintenanceRecordRow = typeof customerMaintenanceRecords.$inferSelect;

// 每资源独立 sort enum（K21）；customerRecords: happenedAt | createdAt | updatedAt
const SORT_COLUMNS = {
  happenedAt: customerMaintenanceRecords.happenedAt,
  createdAt: customerMaintenanceRecords.createdAt,
  updatedAt: customerMaintenanceRecords.updatedAt,
} as const;

function listWhere(query: MaintenanceRecordListQuery, customerId: number): SQL | undefined {
  const conditions: SQL[] = [
    eq(customerMaintenanceRecords.customerId, customerId),
    isNull(customerMaintenanceRecords.deletedAt),
  ];
  if (query.kind !== undefined) conditions.push(eq(customerMaintenanceRecords.kind, query.kind));
  return and(...conditions);
}

export function listRecordsByCustomer(
  db: Db,
  customerId: number,
  query: MaintenanceRecordListQuery,
): { rows: CustomerMaintenanceRecordRow[]; total: number } {
  const where = listWhere(query, customerId);
  // 默认 sort=happenedAt&order=desc（时序时间线，最新在前），并列 id DESC
  const sortCol = SORT_COLUMNS[query.sort ?? "happenedAt"];
  const dir = query.order === "asc" ? asc : desc;

  const rows = db
    .select()
    .from(customerMaintenanceRecords)
    .where(where)
    .orderBy(dir(sortCol), desc(customerMaintenanceRecords.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total =
    db
      .select({ value: count() })
      .from(customerMaintenanceRecords)
      .where(where)
      .get()?.value ?? 0;
  return { rows, total };
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getRecordByIdAny(db: Db, id: number): CustomerMaintenanceRecordRow | undefined {
  return db.select().from(customerMaintenanceRecords).where(eq(customerMaintenanceRecords.id, id)).get();
}

export function insertRecord(
  db: Db,
  values: typeof customerMaintenanceRecords.$inferInsert,
): number {
  return Number(db.insert(customerMaintenanceRecords).values(values).run().lastInsertRowid);
}

/**
 * PATCH 内核 + 行级 OCC（K24）：
 * UPDATE 仅 SET 出现的键（调用方拼好，含 updated_at/updated_by bump），
 * WHERE id=? AND updated_at=? AND deleted_at IS NULL。返回受影响行数。
 */
export function occUpdateRecord(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof customerMaintenanceRecords.$inferInsert>,
): number {
  return db
    .update(customerMaintenanceRecords)
    .set(set)
    .where(
      and(
        eq(customerMaintenanceRecords.id, id),
        eq(customerMaintenanceRecords.updatedAt, expectedUpdatedAt),
        isNull(customerMaintenanceRecords.deletedAt),
      ),
    )
    .run().changes;
}

/** 软删：deleted_at=now；返回受影响行数（0 = 不存在或已删） */
export function softDeleteRecord(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(customerMaintenanceRecords)
    .set(set)
    .where(and(eq(customerMaintenanceRecords.id, id), isNull(customerMaintenanceRecords.deletedAt)))
    .run().changes;
}

/** 返回 ids 中仍然 live 的客户 id 集合（FK 校验：软删/不存在 → 404） */
export function findLiveCustomerIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: customers.id })
    .from(customers)
    .where(and(inArray(customers.id, [...ids]), isNull(customers.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** 返回 ids 中仍然 live 的用户 id 集合（createdBy/updatedBy 展开） */
export function findLiveUserIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

// ---- K47 总览统计（K55 扩展） ----

/** 该客户 live 维护记录数 */
export function countRecordsByCustomer(db: Db, customerId: number): number {
  return (
    db
      .select({ value: count() })
      .from(customerMaintenanceRecords)
      .where(and(eq(customerMaintenanceRecords.customerId, customerId), isNull(customerMaintenanceRecords.deletedAt)))
      .get()?.value ?? 0
  );
}

/** 该客户 live 维护记录，最新在前（happened_at DESC, id DESC），上限 limit */
export function listRecentRecordsByCustomer(db: Db, customerId: number, limit = 20): CustomerMaintenanceRecordRow[] {
  return db
    .select()
    .from(customerMaintenanceRecords)
    .where(and(eq(customerMaintenanceRecords.customerId, customerId), isNull(customerMaintenanceRecords.deletedAt)))
    .orderBy(desc(customerMaintenanceRecords.happenedAt), desc(customerMaintenanceRecords.id))
    .limit(limit)
    .all();
}

/** K55 联动：新跟进/线索记录时 bump customers.last_followed_at = max(当前, happenedAt) */
export function bumpCustomerLastFollowedAt(
  db: Db,
  customerId: number,
  happenedAt: number,
  audit: { updatedAt: number; updatedBy: number | null },
): void {
  db.update(customers)
    .set({
      lastFollowedAt: sql`MAX(COALESCE(${customers.lastFollowedAt}, 0), ${happenedAt})`,
      ...audit,
    })
    .where(eq(customers.id, customerId))
    .run();
}
