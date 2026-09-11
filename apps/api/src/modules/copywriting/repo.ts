// copywriting 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// K60：模板词表 live 唯一 (dimension,name)（软删后释放可复用）；文案 q 命中 title/content；
// COUNT 与列表同一 WHERE；OCC UPDATE 带 updated_at 条件。
import { and, asc, count, desc, eq, isNull, ne, type SQL } from "drizzle-orm";

import type { CopyItemListQuery, CopyTemplateListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { copyItems, copyTemplates } from "../../db/schema.js";
import { fuzzyWhere } from "../../lib/fuzzy.js";
import { toOffset } from "../../lib/pagination.js";

export type CopyTemplateRow = typeof copyTemplates.$inferSelect;
export type CopyItemRow = typeof copyItems.$inferSelect;

/** 文案 q 搜索列（§9，SQL 列名）：title / content */
const ITEM_SEARCH_COLUMNS = [copyItems.title, copyItems.content];

const ITEM_SORT_COLUMNS = {
  updatedAt: copyItems.updatedAt,
  createdAt: copyItems.createdAt,
  title: copyItems.title,
} as const;

// ---------------------------------------------------------------------------
// 模板词表
// ---------------------------------------------------------------------------

export function listTemplates(db: Db, query: CopyTemplateListQuery): CopyTemplateRow[] {
  const conditions: SQL[] = [isNull(copyTemplates.deletedAt)];
  if (query.dimension !== undefined) conditions.push(eq(copyTemplates.dimension, query.dimension));
  if (query.enabled !== undefined) conditions.push(eq(copyTemplates.enabled, query.enabled ? 1 : 0));
  return db
    .select()
    .from(copyTemplates)
    .where(and(...conditions))
    .orderBy(asc(copyTemplates.sort), asc(copyTemplates.id))
    .all();
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getTemplateRowAny(db: Db, id: number): CopyTemplateRow | undefined {
  return db.select().from(copyTemplates).where(eq(copyTemplates.id, id)).get();
}

/** 按 dimension+name 找 live 行（live-unique 冲突预检用）；excludeId 排除自身（PATCH 改名） */
export function getLiveTemplateByName(
  db: Db,
  dimension: string,
  name: string,
  excludeId?: number,
): CopyTemplateRow | undefined {
  const cond = excludeId !== undefined ? ne(copyTemplates.id, excludeId) : undefined;
  return db
    .select()
    .from(copyTemplates)
    .where(
      and(
        eq(copyTemplates.dimension, dimension),
        eq(copyTemplates.name, name),
        isNull(copyTemplates.deletedAt),
        cond,
      ),
    )
    .get();
}

export function insertTemplate(db: Db, values: typeof copyTemplates.$inferInsert): number {
  return Number(db.insert(copyTemplates).values(values).run().lastInsertRowid);
}

/** PATCH 内核 + 行级 OCC（K24）：仅 SET 出现的键；返回受影响行数 */
export function occUpdateTemplate(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof copyTemplates.$inferInsert>,
): number {
  return db
    .update(copyTemplates)
    .set(set)
    .where(
      and(
        eq(copyTemplates.id, id),
        eq(copyTemplates.updatedAt, expectedUpdatedAt),
        isNull(copyTemplates.deletedAt),
      ),
    )
    .run().changes;
}

/** 软删：deleted_at=now；返回受影响行数（0 = 不存在或已删） */
export function softDeleteTemplate(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(copyTemplates)
    .set(set)
    .where(and(eq(copyTemplates.id, id), isNull(copyTemplates.deletedAt)))
    .run().changes;
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

export function listItems(
  db: Db,
  query: CopyItemListQuery,
): { rows: CopyItemRow[]; total: number } {
  const conditions: SQL[] = [isNull(copyItems.deletedAt)];
  const fuzzy = fuzzyWhere(query.q ?? "", ITEM_SEARCH_COLUMNS);
  if (fuzzy) conditions.push(fuzzy);
  const where = and(...conditions);

  const sortCol = ITEM_SORT_COLUMNS[query.sort ?? "updatedAt"];
  const dir = query.order === "asc" ? asc : desc; // 缺省 updatedAt desc

  const rows = db
    .select()
    .from(copyItems)
    .where(where)
    .orderBy(dir(sortCol), asc(copyItems.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(copyItems).where(where).get()?.value ?? 0;
  return { rows, total };
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getItemRowAny(db: Db, id: number): CopyItemRow | undefined {
  return db.select().from(copyItems).where(eq(copyItems.id, id)).get();
}

export function insertItem(db: Db, values: typeof copyItems.$inferInsert): number {
  return Number(db.insert(copyItems).values(values).run().lastInsertRowid);
}

/** PATCH 内核 + 行级 OCC（K24）：仅 SET 出现的键；返回受影响行数 */
export function occUpdateItem(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof copyItems.$inferInsert>,
): number {
  return db
    .update(copyItems)
    .set(set)
    .where(
      and(
        eq(copyItems.id, id),
        eq(copyItems.updatedAt, expectedUpdatedAt),
        isNull(copyItems.deletedAt),
      ),
    )
    .run().changes;
}

/** 软删：deleted_at=now；返回受影响行数（0 = 不存在或已删） */
export function softDeleteItem(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(copyItems)
    .set(set)
    .where(and(eq(copyItems.id, id), isNull(copyItems.deletedAt)))
    .run().changes;
}
