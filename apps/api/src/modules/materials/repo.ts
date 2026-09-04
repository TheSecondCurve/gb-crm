// delivery_materials 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// K54：list 排除软删；COUNT 与列表同一 WHERE。
// q 搜索（FTS5 trigram 实测：token ≥3 字符才命中）：tokens 按空白切分、AND 组合；
// ≥3 字符 token 走 FTS（delivery_materials_fts，触发器同步、软删自动移出索引），
// <3 字符 token 回退 LIKE（title/content OR，ESCAPE '\' 转义）。
// FTS 虚表不入 Drizzle schema，用 db.$client 原生查询拿 id 集合再 inArray（同 agent 模块先例）。
import { and, asc, count, desc, eq, exists, inArray, isNull, not, or, sql, type SQL } from "drizzle-orm";

import type { MaterialListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import {
  customers,
  deliveries,
  deliveryMaterialCustomers,
  deliveryMaterials,
  deliveryMaterialTags,
  deliveryTypes,
  tags,
} from "../../db/schema.js";
import { escapeLike, fuzzyTokens } from "../../lib/fuzzy.js";
import { toOffset } from "../../lib/pagination.js";

export type MaterialRow = typeof deliveryMaterials.$inferSelect;

// 每资源独立 sort enum（K21）；materials: updatedAt | createdAt | title
const SORT_COLUMNS = {
  updatedAt: deliveryMaterials.updatedAt,
  createdAt: deliveryMaterials.createdAt,
  title: deliveryMaterials.title,
} as const;

/** trigram MATCH 要求 token ≥3 字符（SQLite 3.53 实测） */
const FTS_MIN_TOKEN = 3;

/** FTS 命中 id 集合：token 双引号包裹防注入（内层双引号先剥除） */
function ftsMatchIds(db: Db, token: string): number[] {
  const rows = db.$client
    .prepare(
      "SELECT rowid AS id FROM delivery_materials_fts WHERE delivery_materials_fts MATCH ?",
    )
    .all(`"${token}"`) as { id: number }[];
  return rows.map((r) => r.id);
}

/** q → WHERE 片段：逐 token AND；≥3 字符走 FTS（无命中 → 恒假），<3 字符 LIKE title/content OR */
function searchWhere(db: Db, q: string): SQL | undefined {
  const tokens = fuzzyTokens(q);
  if (tokens.length === 0) return undefined;
  const perToken: SQL[] = tokens.map((token) => {
    const safe = token.replace(/"/g, "");
    const pattern = `%${escapeLike(token)}%`;
    const tagHit = exists(
      db
        .select({ x: sql`1` })
        .from(deliveryMaterialTags)
        .innerJoin(tags, and(eq(deliveryMaterialTags.tagId, tags.id), isNull(tags.deletedAt)))
        .where(
          and(
            eq(deliveryMaterialTags.materialId, deliveryMaterials.id),
            sql`${tags.name} LIKE ${pattern} ESCAPE '\\'`,
          ),
        ),
    );
    if (safe.length >= FTS_MIN_TOKEN) {
      const ids = ftsMatchIds(db, safe);
      const ftsHit = ids.length === 0 ? sql`0` : inArray(deliveryMaterials.id, ids);
      return or(ftsHit, tagHit)!;
    }
    return or(
      sql`${deliveryMaterials.title} LIKE ${pattern} ESCAPE '\\'`,
      sql`${deliveryMaterials.content} LIKE ${pattern} ESCAPE '\\'`,
      tagHit,
    )!;
  });
  return and(...perToken);
}

/**
 * deliveryKind 过滤（资料专区按关联交付类型分 tab）：
 * consulting/activity/circle 只命中对应 kind 的 live 交付（交付与类型均未软删）；
 * other = 未关联（无交付单 / 交付软删 / 类型软删——展开为 null）或类型本身为 other。
 */
function liveDeliveryOfKind(db: Db, kinds: readonly string[]): SQL {
  return exists(
    db
      .select({ id: deliveries.id })
      .from(deliveries)
      .innerJoin(
        deliveryTypes,
        and(eq(deliveries.deliveryTypeId, deliveryTypes.id), isNull(deliveryTypes.deletedAt)),
      )
      .where(
        and(
          eq(deliveries.id, deliveryMaterials.deliveryId),
          isNull(deliveries.deletedAt),
          inArray(deliveryTypes.kind, [...kinds]),
        ),
      ),
  );
}

function listWhere(db: Db, query: MaterialListQuery): SQL | undefined {
  const conditions: SQL[] = [isNull(deliveryMaterials.deletedAt)];
  if (query.q !== undefined) {
    const search = searchWhere(db, query.q);
    if (search) conditions.push(search);
  }
  if (query.kind !== undefined) conditions.push(eq(deliveryMaterials.kind, query.kind));
  if (query.tagId !== undefined) {
    conditions.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(deliveryMaterialTags)
          .where(
            and(
              eq(deliveryMaterialTags.materialId, deliveryMaterials.id),
              eq(deliveryMaterialTags.tagId, query.tagId),
            ),
          ),
      ),
    );
  }
  // other 兜底：未关联或类型为 other（即命中非 consulting/activity/circle 的任何情况）
  if (query.deliveryKind !== undefined) {
    if (query.deliveryKind === "other") {
      conditions.push(not(liveDeliveryOfKind(db, ["consulting", "activity", "circle"])));
    } else {
      conditions.push(liveDeliveryOfKind(db, [query.deliveryKind]));
    }
  }
  if (query.deliveryId !== undefined) {
    conditions.push(eq(deliveryMaterials.deliveryId, query.deliveryId));
  }
  // 客户 M2M 等值过滤（join 行含该客户即命中）
  if (query.customerId !== undefined) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM delivery_material_customers
      WHERE delivery_material_customers.material_id = ${deliveryMaterials.id}
        AND delivery_material_customers.customer_id = ${query.customerId}
    )`);
  }
  // orphan=1：无交付单 或 无任何客户关联（K54 孤儿资料整理入口）
  if (query.orphan === "1") {
    conditions.push(
      or(
        isNull(deliveryMaterials.deliveryId),
        sql`NOT EXISTS (
          SELECT 1 FROM delivery_material_customers
          WHERE delivery_material_customers.material_id = ${deliveryMaterials.id}
        )`,
      )!,
    );
  }
  return and(...conditions);
}

export function listMaterials(
  db: Db,
  query: MaterialListQuery,
): { rows: MaterialRow[]; total: number } {
  const where = listWhere(db, query);
  // 默认 sort=updatedAt&order=desc，并列 id DESC（§9）
  const sortCol = SORT_COLUMNS[query.sort ?? "updatedAt"];
  const dir = query.order === "asc" ? asc : desc;

  const rows = db
    .select()
    .from(deliveryMaterials)
    .where(where)
    .orderBy(dir(sortCol), desc(deliveryMaterials.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total =
    db.select({ value: count() }).from(deliveryMaterials).where(where).get()?.value ?? 0;
  return { rows, total };
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getMaterialByIdAny(db: Db, id: number): MaterialRow | undefined {
  return db.select().from(deliveryMaterials).where(eq(deliveryMaterials.id, id)).get();
}

export function insertMaterial(db: Db, values: typeof deliveryMaterials.$inferInsert): number {
  return Number(db.insert(deliveryMaterials).values(values).run().lastInsertRowid);
}

/**
 * PATCH 内核 + 行级 OCC（K24）：
 * UPDATE 仅 SET 出现的键（调用方拼好，含 updated_at/updated_by bump），
 * WHERE id=? AND updated_at=? AND deleted_at IS NULL。返回受影响行数。
 */
export function occUpdateMaterial(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof deliveryMaterials.$inferInsert>,
): number {
  return db
    .update(deliveryMaterials)
    .set(set)
    .where(
      and(
        eq(deliveryMaterials.id, id),
        eq(deliveryMaterials.updatedAt, expectedUpdatedAt),
        isNull(deliveryMaterials.deletedAt),
      ),
    )
    .run().changes;
}

/** 软删：deleted_at=now；返回受影响行数（0 = 不存在或已删）。join 行不剥（K9） */
export function softDeleteMaterial(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(deliveryMaterials)
    .set(set)
    .where(and(eq(deliveryMaterials.id, id), isNull(deliveryMaterials.deletedAt)))
    .run().changes;
}

/** 资料 × 客户 join 行（按页批量读，避免 N+1） */
export function listMaterialCustomerRows(db: Db, materialIds: readonly number[]) {
  if (materialIds.length === 0) return [];
  return db
    .select()
    .from(deliveryMaterialCustomers)
    .where(inArray(deliveryMaterialCustomers.materialId, [...materialIds]))
    .all();
}

/** 资料标签 join 行（K58：只 join live 标签，软删标签不展开；按 name 稳定排序） */
export function listMaterialTagRows(
  db: Db,
  materialIds: readonly number[],
): { materialId: number; tagId: number; name: string }[] {
  if (materialIds.length === 0) return [];
  return db
    .select({
      materialId: deliveryMaterialTags.materialId,
      tagId: deliveryMaterialTags.tagId,
      name: tags.name,
    })
    .from(deliveryMaterialTags)
    .innerJoin(tags, eq(deliveryMaterialTags.tagId, tags.id))
    .where(and(inArray(deliveryMaterialTags.materialId, [...materialIds]), isNull(tags.deletedAt)))
    .orderBy(asc(tags.name))
    .all();
}

/** 整表替换资料标签（K58；live/domain 校验在 service） */
export function replaceMaterialTags(
  db: Db,
  materialId: number,
  tagIds: readonly number[],
  audit: { createdAt: number; createdBy: number | null },
): void {
  db.delete(deliveryMaterialTags)
    .where(eq(deliveryMaterialTags.materialId, materialId))
    .run();
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return;
  db.insert(deliveryMaterialTags)
    .values(unique.map((tagId) => ({ materialId, tagId, ...audit })))
    .run();
}

/** 整表替换资料客户关联（K24 关系数组：缺席不动、[] 清空；live 校验在 service） */
export function replaceMaterialCustomers(
  db: Db,
  materialId: number,
  customerIds: readonly number[],
): void {
  db.delete(deliveryMaterialCustomers)
    .where(eq(deliveryMaterialCustomers.materialId, materialId))
    .run();
  const unique = [...new Set(customerIds)];
  if (unique.length === 0) return;
  db.insert(deliveryMaterialCustomers)
    .values(unique.map((customerId) => ({ materialId, customerId })))
    .run();
}

/** 返回 ids 中仍然 live 的客户 id 集合（customerIds 校验：软删/不存在 → 422） */
export function findLiveCustomerIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: customers.id })
    .from(customers)
    .where(and(inArray(customers.id, [...ids]), isNull(customers.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

// ---- K54 客户总览用：某客户 M2M 关联的 live 资料 ----

/** 该客户的 live 资料（updatedAt desc，并列 id DESC） */
export function listLiveMaterialsByCustomer(db: Db, customerId: number): MaterialRow[] {
  return db
    .select({ material: deliveryMaterials })
    .from(deliveryMaterials)
    .innerJoin(
      deliveryMaterialCustomers,
      eq(deliveryMaterialCustomers.materialId, deliveryMaterials.id),
    )
    .where(
      and(
        eq(deliveryMaterialCustomers.customerId, customerId),
        isNull(deliveryMaterials.deletedAt),
      ),
    )
    .orderBy(desc(deliveryMaterials.updatedAt), desc(deliveryMaterials.id))
    .all()
    .map((r) => r.material);
}

export function countLiveMaterialsByCustomer(db: Db, customerId: number): number {
  return (
    db
      .select({ value: count() })
      .from(deliveryMaterials)
      .innerJoin(
        deliveryMaterialCustomers,
        eq(deliveryMaterialCustomers.materialId, deliveryMaterials.id),
      )
      .where(
        and(
          eq(deliveryMaterialCustomers.customerId, customerId),
          isNull(deliveryMaterials.deletedAt),
        ),
      )
      .get()?.value ?? 0
  );
}
