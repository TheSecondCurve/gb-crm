// job_schedules 序列化 assembler（K52，K21：JSON 一概 camelCase；GET list 项 = GET one = 响应）。
// params 解析补全；enabled 转 boolean；createdBy/updatedBy 只展开 live 用户（K9）。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { UserRef } from "../users/assemble.js";
import { JOB_TYPES } from "./registry.js";
import type { JobScheduleRow } from "./schedule-repo.js";

export interface JobScheduleDto {
  id: number;
  type: string;
  /** 注册表里的中文名；未注册类型为 null */
  typeLabel: string | null;
  params: Record<string, unknown>;
  cron: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

function parseJsonObject(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toDto(row: JobScheduleRow, refs: Map<number, UserRef>): JobScheduleDto {
  const ref = (id: number | null): UserRef | null => (id === null ? null : (refs.get(id) ?? null));
  return {
    id: row.id,
    type: row.type,
    typeLabel: JOB_TYPES[row.type]?.label ?? null,
    params: parseJsonObject(row.params),
    cron: row.cron,
    enabled: row.enabled === 1,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: ref(row.createdBy),
    updatedBy: ref(row.updatedBy),
  };
}

export function assembleJobSchedules(db: Db, rows: readonly JobScheduleRow[]): JobScheduleDto[] {
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
  return rows.map((row) => toDto(row, refs));
}

export function assembleJobSchedule(db: Db, row: JobScheduleRow): JobScheduleDto {
  return assembleJobSchedules(db, [row])[0]!;
}
