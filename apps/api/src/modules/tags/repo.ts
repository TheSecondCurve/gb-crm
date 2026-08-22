// tags 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// K45：词表 list 排除软删；COUNT 与列表同一 WHERE；name live-unique（软删后释放可复用）。
import { and, asc, count, desc, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";

import type { TagListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { tags } from "../../db/schema.js";
import { fuzzyWhere } from "../../lib/fuzzy.js";
import { toOffset } from "../../lib/pagination.js";

export type TagRow = typeof tags.$inferSelect;

/** q 搜索列（§9，SQL 列名）：name */
const SEARCH_COLUMNS = [tags.name];

// 每资源独立 sort enum（K21）；tags 词表默认按 name asc（下拉/设置页需要稳定顺序）
const SORT_COLUMNS = {
  updatedAt: tags.updatedAt,
  createdAt: tags.createdAt,
  name: tags.name,
} as const;

function listWhere(query: TagListQuery): SQL | undefined {
  const conditions: SQL[] = [isNull(tags.deletedAt)];
  const fuzzy = fuzzyWhere(query.q ?? "", SEARCH_COLUMNS);
  if (fuzzy) conditions.push(fuzzy);
  if (query.scope !== undefined) conditions.push(eq(tags.scope, query.scope));
  return and(...conditions);
}

export function listTags(db: Db, query: TagListQuery): { rows: TagRow[]; total: number } {
  const where = listWhere(query);
  // 词表默认 sort=name&order=asc；并列 id ASC（vocabulary 稳定顺序）
  const sortCol = SORT_COLUMNS[query.sort ?? "name"];
  const dir = query.sort === undefined || query.order === "asc" ? asc : desc;

  const rows = db
    .select()
    .from(tags)
    .where(where)
    .orderBy(dir(sortCol), asc(tags.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(tags).where(where).get()?.value ?? 0;
  return { rows, total };
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getTagByIdAny(db: Db, id: number): TagRow | undefined {
  return db.select().from(tags).where(eq(tags.id, id)).get();
}

/** 仅 live 行；软删视为不存在 */
export function getTagById(db: Db, id: number): TagRow | undefined {
  return db
    .select()
    .from(tags)
    .where(and(eq(tags.id, id), isNull(tags.deletedAt)))
    .get();
}

/** 按 name 找 live 行（name live-unique 冲突预检用）；excludeId 排除自身（PATCH 改名） */
export function getLiveTagByName(db: Db, name: string, excludeId?: number): TagRow | undefined {
  const cond = excludeId !== undefined ? ne(tags.id, excludeId) : undefined;
  const q = db.select().from(tags).where(and(eq(tags.name, name), isNull(tags.deletedAt), cond));
  return q.get();
}

export function insertTag(db: Db, values: typeof tags.$inferInsert): number {
  return Number(db.insert(tags).values(values).run().lastInsertRowid);
}

/**
 * PATCH 内核 + 行级 OCC（K24）：
 * UPDATE 仅 SET 出现的键（调用方拼好，含 updated_at/updated_by bump），
 * WHERE id=? AND updated_at=? AND deleted_at IS NULL。返回受影响行数。
 */
export function occUpdateTag(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof tags.$inferInsert>,
): number {
  return db
    .update(tags)
    .set(set)
    .where(and(eq(tags.id, id), eq(tags.updatedAt, expectedUpdatedAt), isNull(tags.deletedAt)))
    .run().changes;
}

/** 软删：deleted_at=now；返回受影响行数（0 = 不存在或已删） */
export function softDeleteTag(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(tags)
    .set(set)
    .where(and(eq(tags.id, id), isNull(tags.deletedAt)))
    .run().changes;
}

/** 返回 ids 中仍然 live 的标签 id 集合（FK 校验：软删/不存在 → 422） */
export function findLiveTagIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: tags.id })
    .from(tags)
    .where(and(inArray(tags.id, [...ids]), isNull(tags.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** 启用中的 live 标签（K46 AI 打标词表；按 sort,name 稳定排序） */
export function listEnabledLiveTags(
  db: Db,
): { id: number; name: string; scope: string }[] {
  return db
    .select({ id: tags.id, name: tags.name, scope: tags.scope })
    .from(tags)
    .where(and(isNull(tags.deletedAt), eq(tags.enabled, 1)))
    .orderBy(asc(tags.sort), asc(tags.name))
    .all();
}
