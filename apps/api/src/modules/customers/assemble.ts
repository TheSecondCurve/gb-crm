// customers 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// 按设计「列表组装（避免 N+1）」批量拉取：主行之外，五张 join 各一次 IN 查询，
// live 用户 / live 渠道 / live 父客户各一次 IN 查询，内存拼装，禁止 N+1。
// K9：join 行不剥，展开只含 live 行——软删的 owner/createdBy/父客户不展开
// （owners 里不出现、parent 为 null），但 parentId 保留原始 FK。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { channels, customers, users } from "../../db/schema.js";
import type { UserRef } from "../users/assemble.js";
import {
  listCustomerCommunityChannelRows,
  listCustomerOwnerRows,
  listCustomerSourceChannelRows,
  listCustomerTagRows,
  listCustomerUpsellOwnerRows,
  type CustomerRow,
} from "./repo.js";

export interface ChannelRef {
  id: number;
  name: string;
}

export interface CustomerRef {
  id: number;
  nickname: string;
}

export interface CustomerDto {
  id: number;
  feishuRecordId: string | null;
  nickname: string;
  realName: string | null;
  title: string | null;
  phone: string | null;
  wechat: string | null;
  otherSocial: string | null;
  wechatChannelsAccount: string | null;
  xiaoyuzhouAccount: string | null;
  xiaohongshuAccount: string | null;
  weiboAccount: string | null;
  douyinAccount: string | null;
  country: string | null;
  city: string | null;
  originStory: string | null;
  notes: string | null;
  profileUrl: string | null;
  customerType: string;
  /** 原始 FK，即使父已软删也保留 */
  parentId: number | null;
  wechatOpenid: string | null;
  lastFollowedAt: number | null;
  feishuCreatedDate: number | null;
  tagCodes: string[];
  owners: UserRef[];
  upsellOwners: UserRef[];
  sourceChannels: ChannelRef[];
  communityChannels: ChannelRef[];
  /** 父客户展开（live only）；父已软删则为 null */
  parent: CustomerRef | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export function assembleCustomers(db: Db, rows: readonly CustomerRow[]): CustomerDto[] {
  const customerIds = rows.map((r) => r.id);

  // 第 2/3 步：五张 join 各一次批量查
  const tagRows = listCustomerTagRows(db, customerIds);
  const ownerRows = listCustomerOwnerRows(db, customerIds);
  const upsellRows = listCustomerUpsellOwnerRows(db, customerIds);
  const sourceRows = listCustomerSourceChannelRows(db, customerIds);
  const communityRows = listCustomerCommunityChannelRows(db, customerIds);

  // 第 4 步：live 用户（owners/upsellOwners/createdBy/updatedBy 展开，软删不展开）
  const userIds = new Set<number>();
  for (const row of rows) {
    if (row.createdBy !== null) userIds.add(row.createdBy);
    if (row.updatedBy !== null) userIds.add(row.updatedBy);
  }
  for (const o of ownerRows) userIds.add(o.userId);
  for (const o of upsellRows) userIds.add(o.userId);
  const userRefs = new Map<number, UserRef>();
  if (userIds.size > 0) {
    const found = db
      .select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(and(inArray(users.id, [...userIds]), isNull(users.deletedAt)))
      .all();
    for (const u of found) userRefs.set(u.id, u);
  }

  // 第 5 步：live 渠道（sourceChannels/communityChannels 展开）
  const channelIds = new Set<number>();
  for (const r of sourceRows) channelIds.add(r.channelId);
  for (const r of communityRows) channelIds.add(r.channelId);
  const channelRefs = new Map<number, ChannelRef>();
  if (channelIds.size > 0) {
    const found = db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(and(inArray(channels.id, [...channelIds]), isNull(channels.deletedAt)))
      .all();
    for (const c of found) channelRefs.set(c.id, c);
  }

  // 第 6 步：live 父客户（parent 展开；parentId 原始 FK 无论如何都输出）
  const parentIds = new Set<number>();
  for (const row of rows) {
    if (row.parentId !== null) parentIds.add(row.parentId);
  }
  const parentRefs = new Map<number, CustomerRef>();
  if (parentIds.size > 0) {
    const found = db
      .select({ id: customers.id, nickname: customers.nickname })
      .from(customers)
      .where(and(inArray(customers.id, [...parentIds]), isNull(customers.deletedAt)))
      .all();
    for (const c of found) parentRefs.set(c.id, c);
  }

  const tagsByCustomer = new Map<number, string[]>();
  for (const t of tagRows) {
    const list = tagsByCustomer.get(t.customerId) ?? [];
    list.push(t.tag);
    tagsByCustomer.set(t.customerId, list);
  }

  // join 行保留但目标已软删 → 不展开（幽灵归属人不能冒充活人，K9）
  const usersByCustomer = (rows: readonly { customerId: number; userId: number }[]) => {
    const map = new Map<number, UserRef[]>();
    for (const r of rows) {
      const ref = userRefs.get(r.userId);
      if (!ref) continue;
      const list = map.get(r.customerId) ?? [];
      list.push(ref);
      map.set(r.customerId, list);
    }
    return map;
  };
  const channelsByCustomer = (rows: readonly { customerId: number; channelId: number }[]) => {
    const map = new Map<number, ChannelRef[]>();
    for (const r of rows) {
      const ref = channelRefs.get(r.channelId);
      if (!ref) continue;
      const list = map.get(r.customerId) ?? [];
      list.push(ref);
      map.set(r.customerId, list);
    }
    return map;
  };
  const ownersByCustomer = usersByCustomer(ownerRows);
  const upsellByCustomer = usersByCustomer(upsellRows);
  const sourceByCustomer = channelsByCustomer(sourceRows);
  const communityByCustomer = channelsByCustomer(communityRows);

  const userRef = (id: number | null): UserRef | null =>
    id === null ? null : (userRefs.get(id) ?? null);

  return rows.map((row) => ({
    id: row.id,
    feishuRecordId: row.feishuRecordId,
    nickname: row.nickname,
    realName: row.realName,
    title: row.title,
    phone: row.phone,
    wechat: row.wechat,
    otherSocial: row.otherSocial,
    wechatChannelsAccount: row.wechatChannelsAccount,
    xiaoyuzhouAccount: row.xiaoyuzhouAccount,
    xiaohongshuAccount: row.xiaohongshuAccount,
    weiboAccount: row.weiboAccount,
    douyinAccount: row.douyinAccount,
    country: row.country,
    city: row.city,
    originStory: row.originStory,
    notes: row.notes,
    profileUrl: row.profileUrl,
    customerType: row.customerType,
    parentId: row.parentId,
    wechatOpenid: row.wechatOpenid,
    lastFollowedAt: row.lastFollowedAt,
    feishuCreatedDate: row.feishuCreatedDate,
    tagCodes: tagsByCustomer.get(row.id) ?? [],
    owners: ownersByCustomer.get(row.id) ?? [],
    upsellOwners: upsellByCustomer.get(row.id) ?? [],
    sourceChannels: sourceByCustomer.get(row.id) ?? [],
    communityChannels: communityByCustomer.get(row.id) ?? [],
    parent: row.parentId === null ? null : (parentRefs.get(row.parentId) ?? null),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: userRef(row.createdBy),
    updatedBy: userRef(row.updatedBy),
  }));
}

export function assembleCustomer(db: Db, row: CustomerRow): CustomerDto {
  return assembleCustomers(db, [row])[0]!;
}
