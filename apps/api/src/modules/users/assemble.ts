// users 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// 永不输出 passwordHash / deletedAt（deletedAt 在输出里只会是 null，无客户端用途）；
// createdBy/updatedBy 展开为 { id, nickname } | null（live only，
// 软删用户为 null，K9）；批量展开避免 N+1（一页 ≤100 行）。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { UserRow } from "./repo.js";

export interface UserRef {
  id: number;
  nickname: string;
}

export interface UserDto {
  id: number;
  username: string | null;
  nickname: string;
  realName: string | null;
  phone: string | null;
  wechat: string | null;
  jobTitle: string;
  systemRole: string | null;
  employmentStatus: string;
  accountStatus: string;
  duties: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

function toDto(row: UserRow, refs: Map<number, UserRef>): UserDto {
  const ref = (id: number | null): UserRef | null => (id === null ? null : (refs.get(id) ?? null));
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    realName: row.realName,
    phone: row.phone,
    wechat: row.wechat,
    jobTitle: row.jobTitle,
    systemRole: row.systemRole,
    employmentStatus: row.employmentStatus,
    accountStatus: row.accountStatus,
    duties: row.duties,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: ref(row.createdBy),
    updatedBy: ref(row.updatedBy),
  };
}

export function assembleUsers(db: Db, rows: readonly UserRow[]): UserDto[] {
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.createdBy !== null) ids.add(row.createdBy);
    if (row.updatedBy !== null) ids.add(row.updatedBy);
  }
  // 只展开 live 用户：软删的 createdBy/updatedBy → null（幽灵人不能冒充活人，K9）
  const refs = new Map<number, UserRef>();
  if (ids.size > 0) {
    const found = db
      .select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
      .all();
    for (const u of found) refs.set(u.id, u);
  }
  return rows.map((row) => toDto(row, refs));
}

export function assembleUser(db: Db, row: UserRow): UserDto {
  return assembleUsers(db, [row])[0]!;
}
