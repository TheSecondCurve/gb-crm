// K64 小程序客户同步的专用写入/查询（customers/repo 之外的增量）：
// 同步场景的纪律与通用 PATCH 内核不同——无 OCC（任务单写者）、只填空、软删不复活、
// join 行只追加不整表替换，故单列本文件，不复用客户 CRUD 的替换式写法。
import { and, asc, eq, isNull, or, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { customerSourceChannels, customerTags, customers } from "../../db/schema.js";
import type { CustomerRow } from "../customers/repo.js";

/** 按 openid 查任意行（含软删）：软删命中 → 调用方跳过（不复活、不新建） */
export function findAnyByWechatOpenid(db: Db, openid: string): CustomerRow | undefined {
  return db.select().from(customers).where(eq(customers.wechatOpenid, openid)).get();
}

/** phone 精确匹配最老的 live 且未链接 openid 的客户（链接候选；无则 undefined） */
export function findLiveByPhoneWithoutOpenid(db: Db, phone: string): CustomerRow | undefined {
  return db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.phone, phone),
        isNull(customers.wechatOpenid),
        isNull(customers.deletedAt),
      ),
    )
    .orderBy(asc(customers.id))
    .limit(1)
    .get();
}

/**
 * 链接：给老客户回填 wechat_openid（带防并发守卫——行须仍 live 且 openid 仍未被占）。
 * 返回受影响行数；0 = 期间被并发链接/删除，调用方按失败收集待下轮重试。
 */
export function linkCustomerOpenid(
  db: Db,
  id: number,
  openid: string,
  set: { updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(customers)
    .set({ wechatOpenid: openid, ...set })
    .where(
      and(eq(customers.id, id), isNull(customers.deletedAt), isNull(customers.wechatOpenid)),
    )
    .run().changes;
}

/** 只填空回填手机号（人工已填的一概不动）；返回受影响行数 */
export function fillCustomerPhoneIfEmpty(
  db: Db,
  id: number,
  phone: string,
  set: { updatedAt: number; updatedBy: number | null },
): number {
  const empty: SQL[] = [isNull(customers.phone), eq(customers.phone, "")];
  return db
    .update(customers)
    .set({ phone, ...set })
    .where(and(eq(customers.id, id), isNull(customers.deletedAt), or(...empty)))
    .run().changes;
}

/** 追加来源渠道（已存在则不动；join 行无审计列） */
export function ensureCustomerSourceChannel(db: Db, customerId: number, channelId: number): void {
  db.insert(customerSourceChannels)
    .values({ customerId, channelId })
    .onConflictDoNothing()
    .run();
}

/** 追加客户标签（已存在则不动；join 行审计只含 created_*） */
export function ensureCustomerTag(
  db: Db,
  customerId: number,
  tagId: number,
  audit: { createdAt: number; createdBy: number | null },
): void {
  db.insert(customerTags)
    .values({ customerId, tagId, ...audit })
    .onConflictDoNothing()
    .run();
}
