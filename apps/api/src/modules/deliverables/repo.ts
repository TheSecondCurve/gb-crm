// deliverables / delivery_tasks 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// list 排除软删；COUNT 与列表同一 WHERE（§9）。K43：交付项挂成交（deal），客户在成交上，
// 故 customerId 过滤与 q（客户昵称）都走 EXISTS 子查询 JOIN deals→customers。
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { DeliverableListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { customers, deals, deliverables, deliveryTasks, products, users } from "../../db/schema.js";
import { escapeLike, fuzzyTokens } from "../../lib/fuzzy.js";
import { toOffset } from "../../lib/pagination.js";

export type DeliverableRow = typeof deliverables.$inferSelect;
export type DeliveryTaskRow = typeof deliveryTasks.$inferSelect;

// 每资源独立 sort enum（K21）；deliverables: updatedAt | createdAt | planDeliverDate
const SORT_COLUMNS = {
  updatedAt: deliverables.updatedAt,
  createdAt: deliverables.createdAt,
  planDeliverDate: deliverables.planDeliverDate,
} as const;

/** q → EXISTS 子查询（客户昵称 LIKE，token AND，转义与 fuzzy.ts 一致） */
function customerNameExists(tokens: string[]): SQL {
  const perToken = tokens.map((token) => {
    const pattern = `%${escapeLike(token)}%`;
    return sql`EXISTS (
      SELECT 1 FROM deals d JOIN customers c ON c.id = d.customer_id
      WHERE d.id = deliverables.deal_id AND c.nickname LIKE ${pattern} ESCAPE '\\'
    )`;
  });
  return and(...perToken)!;
}

function listWhere(query: DeliverableListQuery): SQL | undefined {
  const conditions: SQL[] = [isNull(deliverables.deletedAt)];
  const tokens = fuzzyTokens(query.q ?? "");
  if (tokens.length > 0) conditions.push(customerNameExists(tokens));
  if (query.status !== undefined) conditions.push(eq(deliverables.status, query.status));
  if (query.dealId !== undefined) conditions.push(eq(deliverables.dealId, query.dealId));
  if (query.productId !== undefined) conditions.push(eq(deliverables.productId, query.productId));
  if (query.customerId !== undefined) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM deals d WHERE d.id = deliverables.deal_id AND d.customer_id = ${query.customerId}
      )`,
    );
  }
  return and(...conditions);
}

export function listDeliverables(
  db: Db,
  query: DeliverableListQuery,
): { rows: DeliverableRow[]; total: number } {
  const where = listWhere(query);
  // 默认 sort=updatedAt&order=desc，并列 id DESC（§9）
  const sortCol = SORT_COLUMNS[query.sort ?? "updatedAt"];
  const dir = query.order === "asc" ? asc : desc;

  const rows = db
    .select()
    .from(deliverables)
    .where(where)
    .orderBy(dir(sortCol), desc(deliverables.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db
    .select({ value: count() })
    .from(deliverables)
    .where(where)
    .get()?.value ?? 0;
  return { rows, total };
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getDeliverableByIdAny(db: Db, id: number): DeliverableRow | undefined {
  return db.select().from(deliverables).where(eq(deliverables.id, id)).get();
}

/** 仅 live 行；软删视为不存在 */
export function getDeliverableById(db: Db, id: number): DeliverableRow | undefined {
  return db
    .select()
    .from(deliverables)
    .where(and(eq(deliverables.id, id), isNull(deliverables.deletedAt)))
    .get();
}

export function insertDeliverable(db: Db, values: typeof deliverables.$inferInsert): number {
  return Number(db.insert(deliverables).values(values).run().lastInsertRowid);
}

/**
 * PATCH 内核 + 行级 OCC（K24）：
 * UPDATE 仅 SET 出现的键（调用方拼好，含 updated_at/updated_by bump），
 * WHERE id=? AND updated_at=? AND deleted_at IS NULL。返回受影响行数。
 */
export function occUpdateDeliverable(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof deliverables.$inferInsert>,
): number {
  return db
    .update(deliverables)
    .set(set)
    .where(
      and(
        eq(deliverables.id, id),
        eq(deliverables.updatedAt, expectedUpdatedAt),
        isNull(deliverables.deletedAt),
      ),
    )
    .run().changes;
}

/** 软删：deleted_at=now；返回受影响行数（0 = 不存在或已删）。任务行保留（K9） */
export function softDeleteDeliverable(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(deliverables)
    .set(set)
    .where(and(eq(deliverables.id, id), isNull(deliverables.deletedAt)))
    .run().changes;
}

/** 返回 ids 中「live 且其客户也 live」的成交 id 集合（K43：交付项来源必须是有效成交） */
export function findLiveDealIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: deals.id })
    .from(deals)
    .innerJoin(customers, eq(deals.customerId, customers.id))
    .where(and(inArray(deals.id, [...ids]), isNull(deals.deletedAt), isNull(customers.deletedAt)))
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

/** live 产品的 defaultTasks（模板预填用）；软删/不存在 → undefined */
export function getLiveProductDefaultTasks(db: Db, id: number): string | null | undefined {
  const row = db
    .select({ defaultTasks: products.defaultTasks })
    .from(products)
    .where(and(eq(products.id, id), isNull(products.deletedAt)))
    .get();
  return row?.defaultTasks;
}

// ---- delivery_tasks 子表 ----

/** 按交付项批量读任务（避免 N+1），按 id 升序 = 追加顺序 */
export function listTasksByDeliverableIds(db: Db, deliverableIds: readonly number[]): DeliveryTaskRow[] {
  if (deliverableIds.length === 0) return [];
  return db
    .select()
    .from(deliveryTasks)
    .where(inArray(deliveryTasks.deliverableId, [...deliverableIds]))
    .orderBy(asc(deliveryTasks.id))
    .all();
}

export function insertTask(db: Db, values: typeof deliveryTasks.$inferInsert): number {
  return Number(db.insert(deliveryTasks).values(values).run().lastInsertRowid);
}

export function getTaskByIdAny(db: Db, deliverableId: number, taskId: number): DeliveryTaskRow | undefined {
  return db
    .select()
    .from(deliveryTasks)
    .where(and(eq(deliveryTasks.id, taskId), eq(deliveryTasks.deliverableId, deliverableId)))
    .get();
}

/** 任务行级 OCC UPDATE；返回受影响行数 */
export function occUpdateTask(
  db: Db,
  deliverableId: number,
  taskId: number,
  expectedUpdatedAt: number,
  set: Partial<typeof deliveryTasks.$inferInsert>,
): number {
  return db
    .update(deliveryTasks)
    .set(set)
    .where(
      and(
        eq(deliveryTasks.id, taskId),
        eq(deliveryTasks.deliverableId, deliverableId),
        eq(deliveryTasks.updatedAt, expectedUpdatedAt),
      ),
    )
    .run().changes;
}

/** 硬删任务；返回受影响行数（0 = 不存在） */
export function deleteTask(db: Db, deliverableId: number, taskId: number): number {
  return db
    .delete(deliveryTasks)
    .where(and(eq(deliveryTasks.id, taskId), eq(deliveryTasks.deliverableId, deliverableId)))
    .run().changes;
}

/** 返回 ids 中仍然 live 的用户 id 集合（done_by 校验；此处仅用于审计展开，无需校验） */
export function findLiveUserIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}
