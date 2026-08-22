// background_jobs 表 Drizzle 查询（§3：repo 层）。
// K51 状态机：queued → running → succeeded|partial|failed|cancelled；
// 队列领取用 CAS（UPDATE ... WHERE status='queued'，changes=1 才算领取成功），进程内串行 + 未来多实例安全。
import { and, asc, count, desc, eq, inArray, type SQL } from "drizzle-orm";

import type { JobListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { backgroundJobs } from "../../db/schema.js";
import { toOffset } from "../../lib/pagination.js";

export type JobRow = typeof backgroundJobs.$inferSelect;
export type JobStatus = JobRow["status"];

export function insertJob(db: Db, values: typeof backgroundJobs.$inferInsert): number {
  return Number(db.insert(backgroundJobs).values(values).run().lastInsertRowid);
}

export function listJobs(db: Db, query: JobListQuery): { rows: JobRow[]; total: number } {
  const conditions: SQL[] = [];
  if (query.status !== undefined) conditions.push(eq(backgroundJobs.status, query.status));
  if (query.type !== undefined) conditions.push(eq(backgroundJobs.type, query.type));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = db
    .select()
    .from(backgroundJobs)
    .where(where)
    .orderBy(desc(backgroundJobs.createdAt), desc(backgroundJobs.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(backgroundJobs).where(where).get()?.value ?? 0;
  return { rows, total };
}

export function getJobByIdAny(db: Db, id: number): JobRow | undefined {
  return db.select().from(backgroundJobs).where(eq(backgroundJobs.id, id)).get();
}

/**
 * 领取下一个 queued 任务（CAS）：UPDATE ... SET status='running' WHERE id=? AND status='queued'。
 * changes=1 才算领取成功（避免并发领取同一任务）；返回 running 行或 undefined（无任务/被并发抢走）。
 */
export function claimNextJob(db: Db, now: number): JobRow | undefined {
  const next = db
    .select({ id: backgroundJobs.id })
    .from(backgroundJobs)
    .where(eq(backgroundJobs.status, "queued"))
    .orderBy(asc(backgroundJobs.id))
    .limit(1)
    .get();
  if (!next) return undefined;
  const changes = db
    .update(backgroundJobs)
    .set({ status: "running", startedAt: now })
    .where(and(eq(backgroundJobs.id, next.id), eq(backgroundJobs.status, "queued")))
    .run().changes;
  if (changes === 0) return undefined;
  return getJobByIdAny(db, next.id);
}

export function updateJobProgress(db: Db, id: number, progressJson: string): void {
  db.update(backgroundJobs).set({ progress: progressJson }).where(eq(backgroundJobs.id, id)).run();
}

export function finishJob(
  db: Db,
  id: number,
  set: {
    status: JobStatus;
    result?: string | null;
    error?: string | null;
    finishedAt: number;
  },
): void {
  db.update(backgroundJobs).set(set).where(eq(backgroundJobs.id, id)).run();
}

/** 取消：仅 queued/running 可取消（结束态 changes=0，由 service 转 409）；running 中由执行器下一迭代感知 */
export function cancelJob(db: Db, id: number, now: number): number {
  return db
    .update(backgroundJobs)
    .set({ status: "cancelled", finishedAt: now })
    .where(and(eq(backgroundJobs.id, id), inArray(backgroundJobs.status, ["queued", "running"])))
    .run().changes;
}

/** 进程重启恢复：残留 running → failed（error 注明重启中断，由运维重新触发） */
export function recoverInterruptedJobs(db: Db, now: number): void {
  db.update(backgroundJobs)
    .set({ status: "failed", error: "服务重启，任务中断，请重新触发", finishedAt: now })
    .where(eq(backgroundJobs.status, "running"))
    .run();
}
