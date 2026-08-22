// deliverables 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// 按设计「列表组装（避免 N+1）」批量拉取：deal（JOIN customer 拿昵称）、product、tasks、
// users（doneBy/createdBy/updatedBy）各一次 IN 查询，内存拼装。
// K9：软删的 deal/product/customer/用户不展开（null），交付项行与任务行保留。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { customers, deals, products, users } from "../../db/schema.js";
import type { UserRef } from "../users/assemble.js";
import {
  listTasksByDeliverableIds,
  type DeliverableRow,
  type DeliveryTaskRow,
} from "./repo.js";

export interface DealRef {
  id: number;
  orderNo: string | null;
  customer: { id: number; nickname: string } | null;
}

export interface ProductRef {
  id: number;
  name: string;
}

export interface DeliveryTaskDto {
  id: number;
  content: string;
  done: boolean;
  /** done 翻转时服务端写入；done:false 时为 null */
  doneAt: number | null;
  doneBy: UserRef | null;
  updatedAt: number;
}

export interface DeliverableDto {
  id: number;
  dealId: number;
  productId: number | null;
  status: string;
  planDeliverDate: number | null;
  actualDeliverDate: number | null;
  expiryDate: number | null;
  description: string | null;
  deliveryUrl: string | null;
  deal: DealRef | null;
  product: ProductRef | null;
  tasks: DeliveryTaskDto[];
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

/** 任务列表展开（doneBy 为 live 用户；软删不展开 → null） */
export function assembleTasks(db: Db, rows: readonly DeliveryTaskRow[]): DeliveryTaskDto[] {
  const userIds = new Set<number>();
  for (const row of rows) if (row.doneBy !== null) userIds.add(row.doneBy);
  const userRefs = new Map<number, UserRef>();
  if (userIds.size > 0) {
    const found = db
      .select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(and(inArray(users.id, [...userIds]), isNull(users.deletedAt)))
      .all();
    for (const u of found) userRefs.set(u.id, u);
  }
  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    done: row.done === 1,
    doneAt: row.doneAt,
    doneBy: row.doneBy === null ? null : (userRefs.get(row.doneBy) ?? null),
    updatedAt: row.updatedAt,
  }));
}

export function assembleDeliverables(db: Db, rows: readonly DeliverableRow[]): DeliverableDto[] {
  const deliverableIds = rows.map((r) => r.id);

  // live deals（deal ref 带 customer nickname；soft-deleted deal/customer 不展开）
  const dealIds = new Set<number>();
  for (const row of rows) dealIds.add(row.dealId);
  const dealRows = new Map<
    number,
    { id: number; orderNo: string | null; customerId: number }
  >();
  if (dealIds.size > 0) {
    const found = db
      .select({ id: deals.id, orderNo: deals.orderNo, customerId: deals.customerId })
      .from(deals)
      .where(and(inArray(deals.id, [...dealIds]), isNull(deals.deletedAt)))
      .all();
    for (const d of found) dealRows.set(d.id, d);
  }
  const customerIds = new Set<number>();
  for (const d of dealRows.values()) customerIds.add(d.customerId);
  const customerNames = new Map<number, string>();
  if (customerIds.size > 0) {
    const found = db
      .select({ id: customers.id, nickname: customers.nickname })
      .from(customers)
      .where(and(inArray(customers.id, [...customerIds]), isNull(customers.deletedAt)))
      .all();
    for (const c of found) customerNames.set(c.id, c.nickname);
  }

  // live products
  const productIds = new Set<number>();
  for (const row of rows) if (row.productId !== null) productIds.add(row.productId);
  const productRefs = new Map<number, ProductRef>();
  if (productIds.size > 0) {
    const found = db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(and(inArray(products.id, [...productIds]), isNull(products.deletedAt)))
      .all();
    for (const p of found) productRefs.set(p.id, { id: p.id, name: p.name });
  }

  // tasks（批量读一次，按 deliverableId 分组）
  const taskRows = listTasksByDeliverableIds(db, deliverableIds);
  const tasksByDeliverable = new Map<number, DeliveryTaskRow[]>();
  for (const t of taskRows) {
    const list = tasksByDeliverable.get(t.deliverableId) ?? [];
    list.push(t);
    tasksByDeliverable.set(t.deliverableId, list);
  }
  const tasksDtoByDeliverable = new Map<number, DeliveryTaskDto[]>();
  for (const [id, list] of tasksByDeliverable) {
    tasksDtoByDeliverable.set(id, assembleTasks(db, list));
  }

  // users（createdBy/updatedBy）
  const userIds = new Set<number>();
  for (const row of rows) {
    if (row.createdBy !== null) userIds.add(row.createdBy);
    if (row.updatedBy !== null) userIds.add(row.updatedBy);
  }
  const userRefs = new Map<number, UserRef>();
  if (userIds.size > 0) {
    const found = db
      .select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(and(inArray(users.id, [...userIds]), isNull(users.deletedAt)))
      .all();
    for (const u of found) userRefs.set(u.id, u);
  }
  const userRef = (id: number | null): UserRef | null => (id === null ? null : (userRefs.get(id) ?? null));

  return rows.map((row) => {
    const deal = dealRows.get(row.dealId);
    const customer = deal === undefined ? undefined : customerNames.get(deal.customerId);
    return {
      id: row.id,
      dealId: row.dealId,
      productId: row.productId,
      status: row.status,
      planDeliverDate: row.planDeliverDate,
      actualDeliverDate: row.actualDeliverDate,
      expiryDate: row.expiryDate,
      description: row.description,
      deliveryUrl: row.deliveryUrl,
      deal:
        deal === undefined
          ? null
          : {
              id: deal.id,
              orderNo: deal.orderNo,
              customer: customer === undefined ? null : { id: deal.customerId, nickname: customer },
            },
      product: row.productId === null ? null : (productRefs.get(row.productId) ?? null),
      tasks: tasksDtoByDeliverable.get(row.id) ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: userRef(row.createdBy),
      updatedBy: userRef(row.updatedBy),
    };
  });
}

export function assembleDeliverable(db: Db, row: DeliverableRow): DeliverableDto {
  return assembleDeliverables(db, [row])[0]!;
}
