// deliveries 域序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// 按设计「列表组装（避免 N+1）」批量拉取：类型、客户、用户各一次 IN 查询，内存拼装。
// K9：软删的 type/customer/用户不展开（null）；交付项行与任务行保留。
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { customers, deliveryTypes, users } from "../../db/schema.js";
import type { UserRef } from "../users/assemble.js";
import {
  listDeliveryCustomerRows,
  listTasksByDeliverableIds,
  type DeliverableRow,
  type DeliveryRow,
  type DeliveryTaskRow,
  type DeliveryTypeRow,
} from "./repo.js";

export interface CustomerRef {
  id: number;
  nickname: string;
}

function loadUserRefs(db: Db, ids: Set<number>): Map<number, UserRef> {
  const refs = new Map<number, UserRef>();
  if (ids.size === 0) return refs;
  const found = db
    .select({ id: users.id, nickname: users.nickname })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
    .all();
  for (const u of found) refs.set(u.id, { id: u.id, nickname: u.nickname });
  return refs;
}

// ---- delivery_types ----

export interface DeliveryTypeDto {
  id: number;
  name: string;
  kind: string;
  status: string;
  description: string | null;
  defaultTasks: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export function assembleDeliveryType(db: Db, row: DeliveryTypeRow): DeliveryTypeDto {
  const userIds = new Set<number>();
  if (row.createdBy !== null) userIds.add(row.createdBy);
  if (row.updatedBy !== null) userIds.add(row.updatedBy);
  const refs = loadUserRefs(db, userIds);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    description: row.description,
    defaultTasks: row.defaultTasks,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy === null ? null : (refs.get(row.createdBy) ?? null),
    updatedBy: row.updatedBy === null ? null : (refs.get(row.updatedBy) ?? null),
  };
}

// ---- deliveries ----

export interface DeliveryDto {
  id: number;
  deliveryTypeId: number;
  /** kind 供前端判断圈子类交付（圈子工作台入口） */
  deliveryType: { id: number; name: string; kind: string } | null;
  /** 交付名，可空；前端展示回退类型名 */
  name: string | null;
  customers: CustomerRef[];
  startsAt: number | null;
  endsAt: number | null;
  remark: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export function assembleDeliveries(db: Db, rows: readonly DeliveryRow[]): DeliveryDto[] {
  const ids = rows.map((r) => r.id);

  // 类型 refs
  const typeIds = new Set<number>();
  for (const row of rows) typeIds.add(row.deliveryTypeId);
  const typeRefs = new Map<number, { id: number; name: string; kind: string }>();
  if (typeIds.size > 0) {
    const found = db
      .select({ id: deliveryTypes.id, name: deliveryTypes.name, kind: deliveryTypes.kind })
      .from(deliveryTypes)
      .where(and(inArray(deliveryTypes.id, [...typeIds]), isNull(deliveryTypes.deletedAt)))
      .all();
    for (const t of found) typeRefs.set(t.id, { id: t.id, name: t.name, kind: t.kind });
  }

  // 客户 join + refs
  const customerRows = listDeliveryCustomerRows(db, ids);
  const customerIds = new Set<number>();
  for (const r of customerRows) customerIds.add(r.customerId);
  const customerRefs = new Map<number, CustomerRef>();
  if (customerIds.size > 0) {
    const found = db
      .select({ id: customers.id, nickname: customers.nickname })
      .from(customers)
      .where(and(inArray(customers.id, [...customerIds]), isNull(customers.deletedAt)))
      .all();
    for (const c of found) customerRefs.set(c.id, { id: c.id, nickname: c.nickname });
  }
  const customersByDelivery = new Map<number, CustomerRef[]>();
  for (const r of customerRows) {
    const ref = customerRefs.get(r.customerId);
    if (!ref) continue; // 软删客户不展开（K9）
    const list = customersByDelivery.get(r.deliveryId) ?? [];
    list.push(ref);
    customersByDelivery.set(r.deliveryId, list);
  }

  // 审计用户
  const userIds = new Set<number>();
  for (const row of rows) {
    if (row.createdBy !== null) userIds.add(row.createdBy);
    if (row.updatedBy !== null) userIds.add(row.updatedBy);
  }
  const userRefs = loadUserRefs(db, userIds);
  const userRef = (id: number | null): UserRef | null => (id === null ? null : (userRefs.get(id) ?? null));

  return rows.map((row) => ({
    id: row.id,
    deliveryTypeId: row.deliveryTypeId,
    deliveryType: typeRefs.get(row.deliveryTypeId) ?? null,
    name: row.name,
    customers: customersByDelivery.get(row.id) ?? [],
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: userRef(row.createdBy),
    updatedBy: userRef(row.updatedBy),
  }));
}

export function assembleDelivery(db: Db, row: DeliveryRow): DeliveryDto {
  return assembleDeliveries(db, [row])[0]!;
}

// ---- 交付项 + 任务 ----

export interface DeliveryTaskDto {
  id: number;
  /** 客户维度任务携带客户 ref；项目维度为 null */
  customer: CustomerRef | null;
  content: string;
  done: boolean;
  doneAt: number | null;
  doneBy: UserRef | null;
  remark: string | null;
  updatedAt: number;
}

export interface DeliverableDto {
  id: number;
  deliveryId: number;
  content: string;
  dimension: string;
  description: string | null;
  deliveryUrl: string | null;
  startsAt: number | null;
  endsAt: number | null;
  tasks: DeliveryTaskDto[];
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export function assembleDeliverables(db: Db, rows: readonly DeliverableRow[]): DeliverableDto[] {
  const deliverableIds = rows.map((r) => r.id);

  // 任务（含 customer_id）
  const taskRows = listTasksByDeliverableIds(db, deliverableIds);
  const customerIds = new Set<number>();
  for (const t of taskRows) if (t.customerId !== null) customerIds.add(t.customerId);
  const customerRefs = new Map<number, CustomerRef>();
  if (customerIds.size > 0) {
    const found = db
      .select({ id: customers.id, nickname: customers.nickname })
      .from(customers)
      .where(and(inArray(customers.id, [...customerIds]), isNull(customers.deletedAt)))
      .all();
    for (const c of found) customerRefs.set(c.id, { id: c.id, nickname: c.nickname });
  }

  // doneBy / createdBy / updatedBy
  const userIds = new Set<number>();
  for (const t of taskRows) if (t.doneBy !== null) userIds.add(t.doneBy);
  for (const row of rows) {
    if (row.createdBy !== null) userIds.add(row.createdBy);
    if (row.updatedBy !== null) userIds.add(row.updatedBy);
  }
  const userRefs = loadUserRefs(db, userIds);
  const userRef = (id: number | null): UserRef | null => (id === null ? null : (userRefs.get(id) ?? null));

  const tasksByDeliverable = new Map<number, DeliveryTaskDto[]>();
  for (const t of taskRows) {
    const dto: DeliveryTaskDto = {
      id: t.id,
      customer: t.customerId === null ? null : (customerRefs.get(t.customerId) ?? null),
      content: t.content,
      done: t.done === 1,
      doneAt: t.doneAt,
      doneBy: userRef(t.doneBy),
      remark: t.remark,
      updatedAt: t.updatedAt,
    };
    const list = tasksByDeliverable.get(t.deliverableId) ?? [];
    list.push(dto);
    tasksByDeliverable.set(t.deliverableId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    deliveryId: row.deliveryId,
    content: row.content,
    dimension: row.dimension,
    description: row.description,
    deliveryUrl: row.deliveryUrl,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    tasks: tasksByDeliverable.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: userRef(row.createdBy),
    updatedBy: userRef(row.updatedBy),
  }));
}

export function assembleDeliverable(db: Db, row: DeliverableRow): DeliverableDto {
  return assembleDeliverables(db, [row])[0]!;
}

/** 单条任务 DTO（任务 PATCH/新增响应） */
export function assembleTask(db: Db, row: DeliveryTaskRow): DeliveryTaskDto {
  const customerId = row.customerId;
  const customerRef: CustomerRef | null =
    customerId === null
      ? null
      : (db
          .select({ id: customers.id, nickname: customers.nickname })
          .from(customers)
          .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
          .get() ?? null);
  const doneBy = row.doneBy === null ? null : loadUserRefs(db, new Set([row.doneBy])).get(row.doneBy) ?? null;
  return {
    id: row.id,
    customer: customerRef,
    content: row.content,
    done: row.done === 1,
    doneAt: row.doneAt,
    doneBy,
    remark: row.remark,
    updatedAt: row.updatedAt,
  };
}
