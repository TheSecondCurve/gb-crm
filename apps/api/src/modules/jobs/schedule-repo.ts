// job_schedules 表 Drizzle 查询（K52，§3：repo 层）。
// 调度定义（cron + type + params + enabled + last/next run）。仅 admin 维护。
import { and, asc, count, desc, eq, isNotNull, lte, type SQL } from "drizzle-orm";

import type { JobScheduleListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { jobSchedules } from "../../db/schema.js";
import { toOffset } from "../../lib/pagination.js";

export type JobScheduleRow = typeof jobSchedules.$inferSelect;

export function insertJobSchedule(
  db: Db,
  values: typeof jobSchedules.$inferInsert,
): number {
  return Number(db.insert(jobSchedules).values(values).run().lastInsertRowid);
}

export function listJobSchedules(
  db: Db,
  query: JobScheduleListQuery,
): { rows: JobScheduleRow[]; total: number } {
  const conditions: SQL[] = [];
  if (query.enabled !== undefined) conditions.push(eq(jobSchedules.enabled, query.enabled ? 1 : 0));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = db
    .select()
    .from(jobSchedules)
    .where(where)
    .orderBy(desc(jobSchedules.updatedAt), desc(jobSchedules.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(jobSchedules).where(where).get()?.value ?? 0;
  return { rows, total };
}

export function getJobScheduleById(db: Db, id: number): JobScheduleRow | undefined {
  return db.select().from(jobSchedules).where(eq(jobSchedules.id, id)).get();
}

/** 更新指定字段；返回受影响行数（不存在/未变 → 0，调用方处理 404） */
export function updateJobScheduleRow(
  db: Db,
  id: number,
  set: Partial<typeof jobSchedules.$inferInsert>,
): number {
  return db.update(jobSchedules).set(set).where(eq(jobSchedules.id, id)).run().changes;
}

export function deleteJobScheduleRow(db: Db, id: number): number {
  return db.delete(jobSchedules).where(eq(jobSchedules.id, id)).run().changes;
}

/** 调度器：取到期的启用调度（next_run_at 非空且 ≤ now），按触发时间升序 */
export function listDueJobSchedules(db: Db, now: number): JobScheduleRow[] {
  return db
    .select()
    .from(jobSchedules)
    .where(
      and(eq(jobSchedules.enabled, 1), isNotNull(jobSchedules.nextRunAt), lte(jobSchedules.nextRunAt, now)),
    )
    .orderBy(asc(jobSchedules.nextRunAt))
    .all();
}

/**
 * 调度器推进 next_run_at（CAS：仅当 next_run_at 仍等于 fireAt 时落下一档，防并发重复触发）。
 * next 为 null（cron 不可达，理论上创建时已拦）→ 停用并置空 next_run_at。
 * 返回受影响行数；0 = 已被并发推进/结束，本次应跳过（不得再用旧 fireAt 插行）。
 */
export function advanceJobScheduleRun(
  db: Db,
  id: number,
  fireAt: number,
  next: number | null,
  now: number,
): number {
  const set =
    next === null
      ? { lastRunAt: fireAt, nextRunAt: null, enabled: 0, updatedAt: now }
      : { lastRunAt: fireAt, nextRunAt: next, updatedAt: now };
  return db
    .update(jobSchedules)
    .set(set)
    .where(and(eq(jobSchedules.id, id), eq(jobSchedules.nextRunAt, fireAt)))
    .run().changes;
}
