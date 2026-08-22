// tags 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// enabled 库存 0/1，对外 boolean；createdBy/updatedBy 展开 { id, nickname } | null（live only，K9）；
// deletedAt 不输出。批量展开避免 N+1。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { UserRef } from "../users/assemble.js";
import type { TagRow } from "./repo.js";

export interface TagDto {
  id: number;
  name: string;
  scope: string;
  sort: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

function toDto(row: TagRow, refs: Map<number, UserRef>): TagDto {
  const ref = (id: number | null): UserRef | null => (id === null ? null : (refs.get(id) ?? null));
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    sort: row.sort,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: ref(row.createdBy),
    updatedBy: ref(row.updatedBy),
  };
}

export function assembleTags(db: Db, rows: readonly TagRow[]): TagDto[] {
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.createdBy !== null) ids.add(row.createdBy);
    if (row.updatedBy !== null) ids.add(row.updatedBy);
  }
  // 只展开 live 用户（K9）
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

export function assembleTag(db: Db, row: TagRow): TagDto {
  return assembleTags(db, [row])[0]!;
}
