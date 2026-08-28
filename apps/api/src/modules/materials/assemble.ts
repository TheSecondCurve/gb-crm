// materials 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// K54：列表版 DTO 不含 content（大文本不进列表），携带 contentLength（字符数，null→0）
// 与 excerpt（前 100 字符，null→null）；DetailDto = MaterialDto + content。
// 展开：delivery { id, deliveryType: { id, name, kind }, startsAt, endsAt } | null（软删交付 → null，K9）；
// customers [{ id, nickname }]（INNER 未删除）；createdBy/updatedBy { id, nickname } | null。
// 批量展开避免 N+1（交付/客户/用户各一次 IN 查询，内存拼装）。
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { customers, deliveries, deliveryTypes, users } from "../../db/schema.js";
import type { CustomerRef } from "../deliveries/assemble.js";
import type { UserRef } from "../users/assemble.js";
import { listMaterialCustomerRows, type MaterialRow } from "./repo.js";

export interface MaterialDeliveryRef {
  id: number;
  /** 类型已软删 → null（K9，不展开已删引用） */
  deliveryType: { id: number; name: string; kind: string } | null;
  startsAt: number | null;
  endsAt: number | null;
}

export interface MaterialDto {
  id: number;
  kind: string;
  title: string;
  url: string | null;
  /** content 字符数（content 为 null → 0） */
  contentLength: number;
  /** content 前 100 字符（content 为 null → null） */
  excerpt: string | null;
  deliveryId: number | null;
  delivery: MaterialDeliveryRef | null;
  customers: CustomerRef[];
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export interface MaterialDetailDto extends MaterialDto {
  content: string | null;
}

const EXCERPT_LEN = 100;

function assembleInternal(db: Db, rows: readonly MaterialRow[]): MaterialDto[] {
  const materialIds = rows.map((r) => r.id);

  // 交付展开（live only；类型 INNER 未删除）
  const deliveryIds = new Set<number>();
  for (const row of rows) if (row.deliveryId !== null) deliveryIds.add(row.deliveryId);
  const deliveryRefs = new Map<number, MaterialDeliveryRef>();
  if (deliveryIds.size > 0) {
    const found = db
      .select({
        id: deliveries.id,
        startsAt: deliveries.startsAt,
        endsAt: deliveries.endsAt,
        typeId: deliveryTypes.id,
        typeName: deliveryTypes.name,
        typeKind: deliveryTypes.kind,
      })
      .from(deliveries)
      .innerJoin(
        deliveryTypes,
        and(eq(deliveries.deliveryTypeId, deliveryTypes.id), isNull(deliveryTypes.deletedAt)),
      )
      .where(and(inArray(deliveries.id, [...deliveryIds]), isNull(deliveries.deletedAt)))
      .all();
    for (const d of found) {
      deliveryRefs.set(d.id, {
        id: d.id,
        deliveryType: { id: d.typeId, name: d.typeName, kind: d.typeKind },
        startsAt: d.startsAt,
        endsAt: d.endsAt,
      });
    }
  }

  // 客户 join 行 + live 客户 refs
  const customerRows = listMaterialCustomerRows(db, materialIds);
  const customerIds = new Set<number>();
  for (const r of customerRows) customerIds.add(r.customerId);
  const customerRefs = new Map<number, CustomerRef>();
  if (customerIds.size > 0) {
    const found = db
      .select({ id: customers.id, nickname: customers.nickname })
      .from(customers)
      .where(and(inArray(customers.id, [...customerIds]), isNull(customers.deletedAt)))
      .all();
    for (const c of found) customerRefs.set(c.id, c);
  }
  const customersByMaterial = new Map<number, CustomerRef[]>();
  for (const r of customerRows) {
    const ref = customerRefs.get(r.customerId);
    if (!ref) continue; // 软删客户不展开（K9）
    const list = customersByMaterial.get(r.materialId) ?? [];
    list.push(ref);
    customersByMaterial.set(r.materialId, list);
  }

  // 审计用户
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
  const userRef = (id: number | null): UserRef | null =>
    id === null ? null : (userRefs.get(id) ?? null);

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    contentLength: row.content?.length ?? 0,
    excerpt: row.content === null ? null : row.content.slice(0, EXCERPT_LEN),
    deliveryId: row.deliveryId,
    delivery: row.deliveryId === null ? null : (deliveryRefs.get(row.deliveryId) ?? null),
    customers: customersByMaterial.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: userRef(row.createdBy),
    updatedBy: userRef(row.updatedBy),
  }));
}

/** 列表版：不含 content */
export function assembleMaterials(db: Db, rows: readonly MaterialRow[]): MaterialDto[] {
  return assembleInternal(db, rows);
}

/** 详情版：含完整 content */
export function assembleMaterialDetails(
  db: Db,
  rows: readonly MaterialRow[],
): MaterialDetailDto[] {
  const base = assembleInternal(db, rows);
  return base.map((dto, i) => ({ ...dto, content: rows[i]!.content }));
}

export function assembleMaterialDetail(db: Db, row: MaterialRow): MaterialDetailDto {
  return assembleMaterialDetails(db, [row])[0]!;
}
