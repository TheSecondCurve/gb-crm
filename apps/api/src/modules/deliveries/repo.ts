// deliveries 域 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// K44：交付类型配置表 / 交付单（客户集合 M2M）/ 交付项（双维度）/ 动作任务（客户维度按 customer_id 展开）。
// list 排除软删；COUNT 与列表同一 WHERE（§9）；q 搜客户昵称走 EXISTS delivery_customers→customers。
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { DeliveryListQuery, DeliveryTypeListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import {
  customers,
  deliverables,
  deliveries,
  deliveryCustomers,
  deliveryTasks,
  deliveryTypes,
  users,
} from "../../db/schema.js";
import { escapeLike, fuzzyTokens } from "../../lib/fuzzy.js";
import { toOffset } from "../../lib/pagination.js";
import type { CustomerRow } from "../customers/repo.js";

export type DeliveryTypeRow = typeof deliveryTypes.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type DeliverableRow = typeof deliverables.$inferSelect;
export type DeliveryTaskRow = typeof deliveryTasks.$inferSelect;

// ---- delivery_types ----

const TYPE_SORT_COLUMNS = {
  updatedAt: deliveryTypes.updatedAt,
  createdAt: deliveryTypes.createdAt,
  name: deliveryTypes.name,
} as const;

function typeWhere(query: DeliveryTypeListQuery): SQL | undefined {
  const conditions: SQL[] = [isNull(deliveryTypes.deletedAt)];
  const tokens = fuzzyTokens(query.q ?? "");
  if (tokens.length > 0) {
    conditions.push(
      and(
        ...tokens.map((token) => {
          const pattern = `%${escapeLike(token)}%`;
          return sql`(${deliveryTypes.name} LIKE ${pattern} ESCAPE '\\' OR ${deliveryTypes.description} LIKE ${pattern} ESCAPE '\\')`;
        }),
      )!,
    );
  }
  return and(...conditions);
}

export function listDeliveryTypes(
  db: Db,
  query: DeliveryTypeListQuery,
): { rows: DeliveryTypeRow[]; total: number } {
  const where = typeWhere(query);
  const sortCol = TYPE_SORT_COLUMNS[query.sort ?? "updatedAt"];
  const dir = query.order === "asc" ? asc : desc;
  const rows = db
    .select()
    .from(deliveryTypes)
    .where(where)
    .orderBy(dir(sortCol), desc(deliveryTypes.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(deliveryTypes).where(where).get()?.value ?? 0;
  return { rows, total };
}

export function getDeliveryTypeByIdAny(db: Db, id: number): DeliveryTypeRow | undefined {
  return db.select().from(deliveryTypes).where(eq(deliveryTypes.id, id)).get();
}

export function getDeliveryTypeById(db: Db, id: number): DeliveryTypeRow | undefined {
  return db
    .select()
    .from(deliveryTypes)
    .where(and(eq(deliveryTypes.id, id), isNull(deliveryTypes.deletedAt)))
    .get();
}

export function insertDeliveryType(db: Db, values: typeof deliveryTypes.$inferInsert): number {
  return Number(db.insert(deliveryTypes).values(values).run().lastInsertRowid);
}

export function occUpdateDeliveryType(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof deliveryTypes.$inferInsert>,
): number {
  return db
    .update(deliveryTypes)
    .set(set)
    .where(
      and(
        eq(deliveryTypes.id, id),
        eq(deliveryTypes.updatedAt, expectedUpdatedAt),
        isNull(deliveryTypes.deletedAt),
      ),
    )
    .run().changes;
}

export function softDeleteDeliveryType(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(deliveryTypes)
    .set(set)
    .where(and(eq(deliveryTypes.id, id), isNull(deliveryTypes.deletedAt)))
    .run().changes;
}

/** 类型被 live 交付单引用（删除校验：被引用 → 422） */
export function countLiveDeliveriesByType(db: Db, typeId: number): number {
  return (
    db
      .select({ value: count() })
      .from(deliveries)
      .where(and(eq(deliveries.deliveryTypeId, typeId), isNull(deliveries.deletedAt)))
      .get()?.value ?? 0
  );
}

// ---- deliveries ----

const DELIVERY_SORT_COLUMNS = {
  updatedAt: deliveries.updatedAt,
  createdAt: deliveries.createdAt,
} as const;

/** q → EXISTS 子查询（客户昵称 LIKE，token AND） */
function customerNameExists(tokens: string[]): SQL {
  const perToken = tokens.map((token) => {
    const pattern = `%${escapeLike(token)}%`;
    return sql`EXISTS (
      SELECT 1 FROM delivery_customers dc JOIN customers c ON c.id = dc.customer_id
      WHERE dc.delivery_id = deliveries.id AND c.nickname LIKE ${pattern} ESCAPE '\\'
    )`;
  });
  return and(...perToken)!;
}

function deliveryWhere(query: DeliveryListQuery): SQL | undefined {
  const conditions: SQL[] = [isNull(deliveries.deletedAt)];
  const tokens = fuzzyTokens(query.q ?? "");
  if (tokens.length > 0) conditions.push(customerNameExists(tokens));
  if (query.deliveryTypeId !== undefined) {
    conditions.push(eq(deliveries.deliveryTypeId, query.deliveryTypeId));
  }
  if (query.customerId !== undefined) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM delivery_customers dc WHERE dc.delivery_id = deliveries.id AND dc.customer_id = ${query.customerId}
      )`,
    );
  }
  return and(...conditions);
}

export function listDeliveries(
  db: Db,
  query: DeliveryListQuery,
): { rows: DeliveryRow[]; total: number } {
  const where = deliveryWhere(query);
  const sortCol = DELIVERY_SORT_COLUMNS[query.sort ?? "updatedAt"];
  const dir = query.order === "asc" ? asc : desc;
  const rows = db
    .select()
    .from(deliveries)
    .where(where)
    .orderBy(dir(sortCol), desc(deliveries.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(deliveries).where(where).get()?.value ?? 0;
  return { rows, total };
}

export function getDeliveryByIdAny(db: Db, id: number): DeliveryRow | undefined {
  return db.select().from(deliveries).where(eq(deliveries.id, id)).get();
}

export function getDeliveryById(db: Db, id: number): DeliveryRow | undefined {
  return db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.id, id), isNull(deliveries.deletedAt)))
    .get();
}

export function insertDelivery(db: Db, values: typeof deliveries.$inferInsert): number {
  return Number(db.insert(deliveries).values(values).run().lastInsertRowid);
}

export function occUpdateDelivery(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof deliveries.$inferInsert>,
): number {
  return db
    .update(deliveries)
    .set(set)
    .where(
      and(
        eq(deliveries.id, id),
        eq(deliveries.updatedAt, expectedUpdatedAt),
        isNull(deliveries.deletedAt),
      ),
    )
    .run().changes;
}

export function softDeleteDelivery(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(deliveries)
    .set(set)
    .where(and(eq(deliveries.id, id), isNull(deliveries.deletedAt)))
    .run().changes;
}

/** 交付 × 客户整表替换（调用方负责事务；子表硬删） */
export function replaceDeliveryCustomers(
  db: Db,
  deliveryId: number,
  customerIds: readonly number[],
): void {
  db.delete(deliveryCustomers).where(eq(deliveryCustomers.deliveryId, deliveryId)).run();
  const unique = [...new Set(customerIds)];
  if (unique.length === 0) return;
  db.insert(deliveryCustomers)
    .values(unique.map((customerId) => ({ deliveryId, customerId })))
    .run();
}

/** 批量读交付客户 join 行（避免 N+1） */
export function listDeliveryCustomerRows(db: Db, deliveryIds: readonly number[]) {
  if (deliveryIds.length === 0) return [];
  return db
    .select()
    .from(deliveryCustomers)
    .where(inArray(deliveryCustomers.deliveryId, [...deliveryIds]))
    .all();
}

/** 交付的客户 id 集合（任务加客户时校验属于该交付单） */
export function getDeliveryCustomerIds(db: Db, deliveryId: number): Set<number> {
  const rows = db
    .select({ customerId: deliveryCustomers.customerId })
    .from(deliveryCustomers)
    .where(eq(deliveryCustomers.deliveryId, deliveryId))
    .all();
  return new Set(rows.map((r) => r.customerId));
}

/** 交付单关联客户完整行（JOIN customers，排除软删；供圈子工作台客户表 / Excel 导出） */
export function listDeliveryCustomerRowsById(db: Db, deliveryId: number): CustomerRow[] {
  return db
    .select({ customer: customers })
    .from(deliveryCustomers)
    .innerJoin(customers, eq(customers.id, deliveryCustomers.customerId))
    .where(and(eq(deliveryCustomers.deliveryId, deliveryId), isNull(customers.deletedAt)))
    .all()
    .map((r) => r.customer);
}

// ---- deliverables（交付项）----

export function listDeliverablesByDeliveryIds(db: Db, deliveryIds: readonly number[]) {
  if (deliveryIds.length === 0) return [];
  return db
    .select()
    .from(deliverables)
    .where(
      and(inArray(deliverables.deliveryId, [...deliveryIds]), isNull(deliverables.deletedAt)),
    )
    .orderBy(asc(deliverables.id))
    .all();
}

export function getDeliverableByIdAny(db: Db, id: number): DeliverableRow | undefined {
  return db.select().from(deliverables).where(eq(deliverables.id, id)).get();
}

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

// ---- delivery_tasks（动作清单）----

export function listTasksByDeliverableIds(db: Db, deliverableIds: readonly number[]) {
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

export function deleteTask(db: Db, deliverableId: number, taskId: number): number {
  return db
    .delete(deliveryTasks)
    .where(and(eq(deliveryTasks.id, taskId), eq(deliveryTasks.deliverableId, deliverableId)))
    .run().changes;
}

// ---- 校验辅助 ----

export function findLiveCustomerIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: customers.id })
    .from(customers)
    .where(and(inArray(customers.id, [...ids]), isNull(customers.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

export function findLiveDeliveryTypeIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: deliveryTypes.id })
    .from(deliveryTypes)
    .where(and(inArray(deliveryTypes.id, [...ids]), isNull(deliveryTypes.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** 返回 ids 中仍然 live 的用户 id 集合（审计展开用） */
export function findLiveUserIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}
