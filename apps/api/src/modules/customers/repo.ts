// customers 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// list 排除软删；COUNT 与列表同一 WHERE（§9）。join 表的批量读与整表替换也在本层。
// 过滤：tag → join customer_tags；ownerId → customers.owner_id 等值；
// channelId → 来源渠道（customer_source_channels）包含该渠道即命中。
import { and, asc, count, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";

import type { CustomerListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import {
  channels,
  customers,
  customerSourceChannels,
  customerTags,
  users,
} from "../../db/schema.js";
import { fuzzyWhere } from "../../lib/fuzzy.js";
import { toOffset } from "../../lib/pagination.js";

export type CustomerRow = typeof customers.$inferSelect;

/** q 搜索列（§9，SQL 列名）：nickname,real_name,phone,wechat,city,origin_story,notes */
const SEARCH_COLUMNS = [
  customers.nickname,
  customers.realName,
  customers.phone,
  customers.wechat,
  customers.city,
  customers.originStory,
  customers.notes,
];

// 每资源独立 sort enum（K21）；customers: updatedAt | createdAt | nickname
const SORT_COLUMNS = {
  updatedAt: customers.updatedAt,
  createdAt: customers.createdAt,
  nickname: customers.nickname,
} as const;

function listWhere(query: CustomerListQuery): SQL | undefined {
  const conditions: SQL[] = [isNull(customers.deletedAt)];
  const fuzzy = fuzzyWhere(query.q ?? "", SEARCH_COLUMNS);
  if (fuzzy) conditions.push(fuzzy);
  if (query.customerType !== undefined) {
    conditions.push(eq(customers.customerType, query.customerType));
  }
  if (query.tag !== undefined) {
    conditions.push(
      sql`${customers.id} IN (SELECT customer_id FROM customer_tags WHERE tag = ${query.tag})`,
    );
  }
  if (query.ownerId !== undefined) {
    conditions.push(eq(customers.ownerId, query.ownerId));
  }
  if (query.channelId !== undefined) {
    conditions.push(
      sql`${customers.id} IN (
        SELECT customer_id FROM customer_source_channels WHERE channel_id = ${query.channelId}
      )`,
    );
  }
  return and(...conditions);
}

export function listCustomers(
  db: Db,
  query: CustomerListQuery,
): { rows: CustomerRow[]; total: number } {
  const where = listWhere(query);
  // 默认 sort=updatedAt&order=desc，并列 id DESC（§9）
  const sortCol = SORT_COLUMNS[query.sort ?? "updatedAt"];
  const dir = query.order === "asc" ? asc : desc;

  const rows = db
    .select()
    .from(customers)
    .where(where)
    .orderBy(dir(sortCol), desc(customers.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(customers).where(where).get()?.value ?? 0;
  return { rows, total };
}

/** 导出用：与列表同一 WHERE（listWhere），不分页，取全部 live 行 */
export function listAllCustomers(db: Db, query: CustomerListQuery): CustomerRow[] {
  const sortCol = SORT_COLUMNS[query.sort ?? "updatedAt"];
  const dir = query.order === "asc" ? asc : desc;
  return db
    .select()
    .from(customers)
    .where(listWhere(query))
    .orderBy(dir(sortCol), desc(customers.id))
    .all();
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getCustomerByIdAny(db: Db, id: number): CustomerRow | undefined {
  return db.select().from(customers).where(eq(customers.id, id)).get();
}

export function insertCustomer(db: Db, values: typeof customers.$inferInsert): number {
  return Number(db.insert(customers).values(values).run().lastInsertRowid);
}

/**
 * PATCH 内核 + 行级 OCC（K24）：
 * UPDATE 仅 SET 出现的键（调用方拼好，含 updated_at/updated_by bump），
 * WHERE id=? AND updated_at=? AND deleted_at IS NULL。返回受影响行数。
 */
export function occUpdateCustomer(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof customers.$inferInsert>,
): number {
  return db
    .update(customers)
    .set(set)
    .where(
      and(
        eq(customers.id, id),
        eq(customers.updatedAt, expectedUpdatedAt),
        isNull(customers.deletedAt),
      ),
    )
    .run().changes;
}

/** 软删：deleted_at=now；返回受影响行数（0 = 不存在或已删）。join 行不剥（K9） */
export function softDeleteCustomer(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(customers)
    .set(set)
    .where(and(eq(customers.id, id), isNull(customers.deletedAt)))
    .run().changes;
}

/** live 行中 wechat_openid 已被占用则返回该行（excludeId 用于 PATCH 排除自己；K24/可空唯一） */
export function findLiveByWechatOpenid(
  db: Db,
  openid: string,
  excludeId?: number,
): CustomerRow | undefined {
  const conditions = [
    eq(customers.wechatOpenid, openid),
    isNull(customers.deletedAt),
    ...(excludeId !== undefined ? [ne(customers.id, excludeId)] : []),
  ];
  return db
    .select()
    .from(customers)
    .where(and(...conditions))
    .get();
}

/** 返回 ids 中仍然 live 的用户 id 集合（ownerId 校验：软删/不存在 → 422） */
export function findLiveUserIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** 返回 ids 中仍然 live 的渠道 id 集合（sourceChannelIds 校验用） */
export function findLiveChannelIds(db: Db, ids: readonly number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: channels.id })
    .from(channels)
    .where(and(inArray(channels.id, [...ids]), isNull(channels.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

// ---- join 表：按页批量读（避免 N+1）与整表替换 ----

export function listCustomerTagRows(db: Db, customerIds: readonly number[]) {
  if (customerIds.length === 0) return [];
  return db
    .select()
    .from(customerTags)
    .where(inArray(customerTags.customerId, [...customerIds]))
    .all();
}

export function listCustomerSourceChannelRows(db: Db, customerIds: readonly number[]) {
  if (customerIds.length === 0) return [];
  return db
    .select()
    .from(customerSourceChannels)
    .where(inArray(customerSourceChannels.customerId, [...customerIds]))
    .all();
}

/** 整表替换某客户标签（delete + insert，自动去重；调用方负责事务与枚举校验） */
export function replaceCustomerTags(db: Db, customerId: number, tags: readonly string[]): void {
  db.delete(customerTags).where(eq(customerTags.customerId, customerId)).run();
  const unique = [...new Set(tags)];
  if (unique.length === 0) return;
  db.insert(customerTags)
    .values(unique.map((tag) => ({ customerId, tag })))
    .run();
}

/** 整表替换来源渠道 */
export function replaceCustomerSourceChannels(
  db: Db,
  customerId: number,
  channelIds: readonly number[],
): void {
  db.delete(customerSourceChannels).where(eq(customerSourceChannels.customerId, customerId)).run();
  const unique = [...new Set(channelIds)];
  if (unique.length === 0) return;
  db.insert(customerSourceChannels)
    .values(unique.map((channelId) => ({ customerId, channelId })))
    .run();
}
