// customer_records 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// 按设计「列表组装（避免 N+1）」批量拉取：live 用户各一次 IN 查询，内存拼装。
// K9：软删的 createdBy/updatedBy 不展开（null），记录行本身保留。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { UserRef } from "../users/assemble.js";
import type { CustomerMaintenanceRecordRow } from "./repo.js";

export interface CustomerMaintenanceRecordDto {
  id: number;
  customerId: number;
  kind: string;
  /** epoch ms UTC；记录对应的时间点（可回补） */
  happenedAt: number;
  content: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export function assembleCustomerMaintenanceRecords(
  db: Db,
  rows: readonly CustomerMaintenanceRecordRow[],
): CustomerMaintenanceRecordDto[] {
  const userIds = new Set<number>();
  for (const row of rows) {
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
  const userRef = (id: number | null): UserRef | null =>
    id === null ? null : (userRefs.get(id) ?? null);

  return rows.map((row) => ({
    id: row.id,
    customerId: row.customerId,
    kind: row.kind,
    happenedAt: row.happenedAt,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: userRef(row.createdBy),
    updatedBy: userRef(row.updatedBy),
  }));
}

export function assembleCustomerMaintenanceRecord(
  db: Db,
  row: CustomerMaintenanceRecordRow,
): CustomerMaintenanceRecordDto {
  return assembleCustomerMaintenanceRecords(db, [row])[0]!;
}
