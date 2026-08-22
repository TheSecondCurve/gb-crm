// customers 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// 按设计「列表组装（避免 N+1）」批量拉取：主行之外，社交账号/来源渠道子表各一次 IN 查询，
// live 用户 / live 渠道各一次 IN 查询，内存拼装，禁止 N+1。
// K9：软删的 owner/createdBy 不展开（owner 为 null），子表行保留。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { channels, users } from "../../db/schema.js";
import type { DealDto } from "../deals/assemble.js";
import type { DeliveryDto } from "../deliveries/assemble.js";
import type { UserRef } from "../users/assemble.js";
import {
  listCustomerSocialAccountRows,
  listCustomerSourceChannelRows,
  listCustomerTagRows,
  type CustomerRow,
} from "./repo.js";

export interface ChannelRef {
  id: number;
  name: string;
}

export interface SocialAccountRef {
  platform: string;
  account: string;
}

/** K45 客户标签 ref（scope 供前端按分类上色） */
export interface TagRef {
  id: number;
  name: string;
  scope: string;
}

export interface CustomerDto {
  id: number;
  nickname: string;
  realName: string | null;
  title: string | null;
  phone: string | null;
  wechat: string | null;
  country: string | null;
  city: string | null;
  industry: string | null;
  originStory: string | null;
  notes: string | null;
  customerType: string;
  wechatOpenid: string | null;
  lastFollowedAt: number | null;
  socialAccounts: SocialAccountRef[];
  tags: TagRef[];
  owner: UserRef | null;
  sourceChannels: ChannelRef[];
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export function assembleCustomers(db: Db, rows: readonly CustomerRow[]): CustomerDto[] {
  const customerIds = rows.map((r) => r.id);

  // 第 2 步：社交账号 / 来源渠道 / 标签 子表各一次批量查
  const socialRows = listCustomerSocialAccountRows(db, customerIds);
  const sourceRows = listCustomerSourceChannelRows(db, customerIds);
  const tagRows = listCustomerTagRows(db, customerIds);

  // 第 3 步：live 用户（owner/createdBy/updatedBy 展开，软删不展开 → null）
  const userIds = new Set<number>();
  for (const row of rows) {
    if (row.ownerId !== null) userIds.add(row.ownerId);
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

  // 第 4 步：live 渠道（sourceChannels 展开）
  const channelIds = new Set<number>();
  for (const r of sourceRows) channelIds.add(r.channelId);
  const channelRefs = new Map<number, ChannelRef>();
  if (channelIds.size > 0) {
    const found = db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(and(inArray(channels.id, [...channelIds]), isNull(channels.deletedAt)))
      .all();
    for (const c of found) channelRefs.set(c.id, c);
  }

  const socialByCustomer = new Map<number, SocialAccountRef[]>();
  for (const s of socialRows) {
    const list = socialByCustomer.get(s.customerId) ?? [];
    list.push({ platform: s.platform, account: s.account });
    socialByCustomer.set(s.customerId, list);
  }

  // 标签按 sort,name 已排序（repo），直接按 customerId 分组
  const tagsByCustomer = new Map<number, TagRef[]>();
  for (const t of tagRows) {
    const list = tagsByCustomer.get(t.customerId) ?? [];
    list.push({ id: t.tagId, name: t.name, scope: t.scope });
    tagsByCustomer.set(t.customerId, list);
  }

  // join 行保留但目标已软删 → 不展开（幽灵归属人不能冒充活人，K9）
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
  const sourceByCustomer = channelsByCustomer(sourceRows);

  const userRef = (id: number | null): UserRef | null =>
    id === null ? null : (userRefs.get(id) ?? null);

  return rows.map((row) => ({
    id: row.id,
    nickname: row.nickname,
    realName: row.realName,
    title: row.title,
    phone: row.phone,
    wechat: row.wechat,
    country: row.country,
    city: row.city,
    industry: row.industry,
    originStory: row.originStory,
    notes: row.notes,
    customerType: row.customerType,
    wechatOpenid: row.wechatOpenid,
    lastFollowedAt: row.lastFollowedAt,
    socialAccounts: socialByCustomer.get(row.id) ?? [],
    tags: tagsByCustomer.get(row.id) ?? [],
    owner: userRef(row.ownerId),
    sourceChannels: sourceByCustomer.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: userRef(row.createdBy),
    updatedBy: userRef(row.updatedBy),
  }));
}

export function assembleCustomer(db: Db, row: CustomerRow): CustomerDto {
  return assembleCustomers(db, [row])[0]!;
}

// K47 客户总览 DTO（customer + 统计 + 消费记录 + 当前有效圈子）
export interface CustomerStatsDto {
  dealCount: number;
  paidTotalCents: number;
  lastDealAt: number | null;
}

export interface CustomerOverviewDto {
  customer: CustomerDto;
  stats: CustomerStatsDto;
  deals: DealDto[];
  circles: DeliveryDto[];
}
