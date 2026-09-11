// copywriting 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// 模板 enabled 库存 0/1，对外 boolean；createdBy/updatedBy 展开 { id, nickname } | null（live only，K9）；
// deletedAt 不输出。批量展开避免 N+1。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { UserRef } from "../users/assemble.js";
import type { CopyItemRow, CopyTemplateRow } from "./repo.js";

export interface CopyTemplateDto {
  id: number;
  dimension: string;
  name: string;
  content: string;
  sort: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export interface CopyItemDto {
  id: number;
  title: string;
  background: string | null;
  audience: string | null;
  topic: string | null;
  goal: string | null;
  outputType: string | null;
  polish: string | null;
  content: string;
  auditReport: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

/** 批量取 live 用户引用（K9：软删用户不展开 → null） */
function loadUserRefs(db: Db, rows: readonly { createdBy: number | null; updatedBy: number | null }[]) {
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.createdBy !== null) ids.add(row.createdBy);
    if (row.updatedBy !== null) ids.add(row.updatedBy);
  }
  const refs = new Map<number, UserRef>();
  if (ids.size > 0) {
    const found = db
      .select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
      .all();
    for (const u of found) refs.set(u.id, u);
  }
  return (id: number | null): UserRef | null => (id === null ? null : (refs.get(id) ?? null));
}

export function assembleCopyTemplates(db: Db, rows: readonly CopyTemplateRow[]): CopyTemplateDto[] {
  const ref = loadUserRefs(db, rows);
  return rows.map((row) => ({
    id: row.id,
    dimension: row.dimension,
    name: row.name,
    content: row.content,
    sort: row.sort,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: ref(row.createdBy),
    updatedBy: ref(row.updatedBy),
  }));
}

export function assembleCopyTemplate(db: Db, row: CopyTemplateRow): CopyTemplateDto {
  return assembleCopyTemplates(db, [row])[0]!;
}

export function assembleCopyItems(db: Db, rows: readonly CopyItemRow[]): CopyItemDto[] {
  const ref = loadUserRefs(db, rows);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    background: row.background,
    audience: row.audience,
    topic: row.topic,
    goal: row.goal,
    outputType: row.outputType,
    polish: row.polish,
    content: row.content,
    auditReport: row.auditReport,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: ref(row.createdBy),
    updatedBy: ref(row.updatedBy),
  }));
}

export function assembleCopyItem(db: Db, row: CopyItemRow): CopyItemDto {
  return assembleCopyItems(db, [row])[0]!;
}
