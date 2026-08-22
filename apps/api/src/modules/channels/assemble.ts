// channels 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// owners 展开为 { id, nickname }[]，只含 live 用户（K9：软删用户的 join 行保留但不展开）；
// createdBy/updatedBy 同样 live only。deletedAt 不输出。
// K27 密钥字段（accountId 等五个）这里原样输出，是否对 assistant 置 null 由 service 决定。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { UserRef } from "../users/assemble.js";
import { listChannelOwnerRows, type ChannelRow } from "./repo.js";

export interface ChannelDto {
  id: number;
  name: string;
  description: string | null;
  accountId: string | null;
  registerPhone: string | null;
  registrant: string | null;
  realNamePerson: string | null;
  loginDevice: string | null;
  notes: string | null;
  platform: string;
  channelType: string;
  accountType: string;
  status: string;
  followerCount: number | null;
  owners: UserRef[];
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export function assembleChannels(db: Db, rows: readonly ChannelRow[]): ChannelDto[] {
  const channelIds = rows.map((r) => r.id);
  const ownerRows = listChannelOwnerRows(db, channelIds);

  const userIds = new Set<number>();
  for (const row of rows) {
    if (row.createdBy !== null) userIds.add(row.createdBy);
    if (row.updatedBy !== null) userIds.add(row.updatedBy);
  }
  for (const o of ownerRows) userIds.add(o.userId);

  // 只展开 live 用户：软删的 owner / createdBy / updatedBy 不出现（幽灵人不能冒充活人，K9）
  const refs = new Map<number, UserRef>();
  if (userIds.size > 0) {
    const found = db
      .select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(and(inArray(users.id, [...userIds]), isNull(users.deletedAt)))
      .all();
    for (const u of found) refs.set(u.id, u);
  }

  const ownersByChannel = new Map<number, UserRef[]>();
  for (const o of ownerRows) {
    const ref = refs.get(o.userId);
    if (!ref) continue; // join 行保留但该用户已软删 → 不展开
    const list = ownersByChannel.get(o.channelId) ?? [];
    list.push(ref);
    ownersByChannel.set(o.channelId, list);
  }

  const ref = (id: number | null): UserRef | null => (id === null ? null : (refs.get(id) ?? null));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    accountId: row.accountId,
    registerPhone: row.registerPhone,
    registrant: row.registrant,
    realNamePerson: row.realNamePerson,
    loginDevice: row.loginDevice,
    notes: row.notes,
    platform: row.platform,
    channelType: row.channelType,
    accountType: row.accountType,
    status: row.status,
    followerCount: row.followerCount,
    owners: ownersByChannel.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: ref(row.createdBy),
    updatedBy: ref(row.updatedBy),
  }));
}

export function assembleChannel(db: Db, row: ChannelRow): ChannelDto {
  return assembleChannels(db, [row])[0]!;
}
