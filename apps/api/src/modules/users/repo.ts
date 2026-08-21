// users 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// list 排除软删；COUNT 与列表同一 WHERE（§9）。
import { and, asc, count, desc, eq, isNull, type SQL } from "drizzle-orm";

import type { UserListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { fuzzyWhere } from "../../lib/fuzzy.js";
import { toOffset } from "../../lib/pagination.js";

export type UserRow = typeof users.$inferSelect;

/** q 搜索列（§9，SQL 列名）：username,nickname,real_name,phone,wechat */
const SEARCH_COLUMNS = [users.username, users.nickname, users.realName, users.phone, users.wechat];

// 每资源独立 sort enum（K21）；users: updatedAt | createdAt | nickname | username
const SORT_COLUMNS = {
  updatedAt: users.updatedAt,
  createdAt: users.createdAt,
  nickname: users.nickname,
  username: users.username,
} as const;

function listWhere(query: UserListQuery): SQL | undefined {
  const conditions: SQL[] = [isNull(users.deletedAt)];
  const fuzzy = fuzzyWhere(query.q ?? "", SEARCH_COLUMNS);
  if (fuzzy) conditions.push(fuzzy);
  if (query.systemRole !== undefined) conditions.push(eq(users.systemRole, query.systemRole));
  if (query.accountStatus !== undefined)
    conditions.push(eq(users.accountStatus, query.accountStatus));
  if (query.employmentStatus !== undefined)
    conditions.push(eq(users.employmentStatus, query.employmentStatus));
  if (query.jobTitle !== undefined) conditions.push(eq(users.jobTitle, query.jobTitle));
  return and(...conditions);
}

export function listUsers(
  db: Db,
  query: UserListQuery,
): { rows: UserRow[]; total: number } {
  const where = listWhere(query);
  // 默认 sort=updatedAt&order=desc，并列 id DESC（§9）
  const sortCol = SORT_COLUMNS[query.sort ?? "updatedAt"];
  const dir = query.order === "asc" ? asc : desc;

  const rows = db
    .select()
    .from(users)
    .where(where)
    .orderBy(dir(sortCol), desc(users.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(users).where(where).get()?.value ?? 0;
  return { rows, total };
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getUserByIdAny(db: Db, id: number): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

/** 仅 live 行；软删视为不存在 */
export function getUserById(db: Db, id: number): UserRow | undefined {
  return db
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .get();
}

/** live 用户名占用检查（users_username_live_uq 是软删释放的 partial unique） */
export function findLiveByUsername(db: Db, username: string): UserRow | undefined {
  return db
    .select()
    .from(users)
    .where(and(eq(users.username, username), isNull(users.deletedAt)))
    .get();
}

export function insertUser(db: Db, values: typeof users.$inferInsert): number {
  return Number(db.insert(users).values(values).run().lastInsertRowid);
}

/**
 * PATCH 内核 + 行级 OCC（K24）：
 * UPDATE 仅 SET 出现的键（调用方拼好，含 updated_at/updated_by bump），
 * WHERE id=? AND updated_at=? AND deleted_at IS NULL。返回受影响行数。
 */
export function occUpdateUser(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof users.$inferInsert>,
): number {
  return db
    .update(users)
    .set(set)
    .where(and(eq(users.id, id), eq(users.updatedAt, expectedUpdatedAt), isNull(users.deletedAt)))
    .run().changes;
}

/** 软删：deleted_at=now；返回受影响行数（0 = 不存在或已删） */
export function softDeleteUser(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(users)
    .set(set)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .run().changes;
}

/** 设密码：按 id 直接更新 hash 并 bump 审计列（不走 OCC） */
export function updatePasswordHash(
  db: Db,
  id: number,
  passwordHash: string,
  audit: { updatedAt: number; updatedBy: number | null },
): void {
  db.update(users)
    .set({ passwordHash, ...audit })
    .where(eq(users.id, id))
    .run();
}
