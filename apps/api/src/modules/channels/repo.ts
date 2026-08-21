// channels 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// list 排除软删；COUNT 与列表同一 WHERE（§9）。channel_owners 的读取与整表替换也在本层。
import { and, asc, count, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";

import type { ChannelListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { channelOwners, channels, users } from "../../db/schema.js";
import { fuzzyWhere } from "../../lib/fuzzy.js";
import { toOffset } from "../../lib/pagination.js";

export type ChannelRow = typeof channels.$inferSelect;

/** q 搜索列（§9，SQL 列名）：name,account_id,register_phone,notes */
const SEARCH_COLUMNS = [
  channels.name,
  channels.accountId,
  channels.registerPhone,
  channels.notes,
];

// 每资源独立 sort enum（K21）；channels: updatedAt | createdAt | name
const SORT_COLUMNS = {
  updatedAt: channels.updatedAt,
  createdAt: channels.createdAt,
  name: channels.name,
} as const;

function listWhere(query: ChannelListQuery): SQL | undefined {
  const conditions: SQL[] = [isNull(channels.deletedAt)];
  const fuzzy = fuzzyWhere(query.q ?? "", SEARCH_COLUMNS);
  if (fuzzy) conditions.push(fuzzy);
  if (query.platform !== undefined) conditions.push(eq(channels.platform, query.platform));
  if (query.channelType !== undefined) conditions.push(eq(channels.channelType, query.channelType));
  if (query.accountType !== undefined) conditions.push(eq(channels.accountType, query.accountType));
  if (query.status !== undefined) conditions.push(eq(channels.status, query.status));
  return and(...conditions);
}

export function listChannels(
  db: Db,
  query: ChannelListQuery,
): { rows: ChannelRow[]; total: number } {
  const where = listWhere(query);
  // 默认 sort=updatedAt&order=desc，并列 id DESC（§9）
  const sortCol = SORT_COLUMNS[query.sort ?? "updatedAt"];
  const dir = query.order === "asc" ? asc : desc;

  const rows = db
    .select()
    .from(channels)
    .where(where)
    .orderBy(dir(sortCol), desc(channels.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(channels).where(where).get()?.value ?? 0;
  return { rows, total };
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getChannelByIdAny(db: Db, id: number): ChannelRow | undefined {
  return db.select().from(channels).where(eq(channels.id, id)).get();
}

/** 仅 live 行；软删视为不存在 */
export function getChannelById(db: Db, id: number): ChannelRow | undefined {
  return db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), isNull(channels.deletedAt)))
    .get();
}

export function insertChannel(db: Db, values: typeof channels.$inferInsert): number {
  return Number(db.insert(channels).values(values).run().lastInsertRowid);
}

/**
 * PATCH 内核 + 行级 OCC（K24）：
 * UPDATE 仅 SET 出现的键（调用方拼好，含 updated_at/updated_by bump），
 * WHERE id=? AND updated_at=? AND deleted_at IS NULL。返回受影响行数。
 */
export function occUpdateChannel(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof channels.$inferInsert>,
): number {
  return db
    .update(channels)
    .set(set)
    .where(
      and(eq(channels.id, id), eq(channels.updatedAt, expectedUpdatedAt), isNull(channels.deletedAt)),
    )
    .run().changes;
}

/** 软删：deleted_at=now；返回受影响行数（0 = 不存在或已删）。join 行不剥（K9） */
export function softDeleteChannel(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(channels)
    .set(set)
    .where(and(eq(channels.id, id), isNull(channels.deletedAt)))
    .run().changes;
}

/** channel_owners 按渠道批量读取（一页 join 一次查，避免 N+1） */
export function listChannelOwnerRows(
  db: Db,
  channelIds: readonly number[],
): (typeof channelOwners.$inferSelect)[] {
  if (channelIds.length === 0) return [];
  return db
    .select()
    .from(channelOwners)
    .where(inArray(channelOwners.channelId, [...channelIds]))
    .all();
}

/** 整表替换某渠道负责人（delete + insert，自动去重；调用方负责事务与 id 校验） */
export function replaceChannelOwners(
  db: Db,
  channelId: number,
  userIds: readonly number[],
): void {
  db.delete(channelOwners).where(eq(channelOwners.channelId, channelId)).run();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  db.insert(channelOwners)
    .values(unique.map((userId) => ({ channelId, userId })))
    .run();
}

/** 返回 ids 中仍然 live 的用户 id 集合（ownerIds 校验用：软删/不存在的 id → 422） */
export function findLiveUserIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}
