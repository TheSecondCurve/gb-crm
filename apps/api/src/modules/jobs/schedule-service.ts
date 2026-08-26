// job_schedules 业务规则（K52，仅 admin，经路由 requireCan("jobSchedules", ...)）：
// - 创建/更新：复用 jobs 注册表（未知 type 422）、按任务类型业务权限（can()）、
//   params 双侧 Zod 校验（M11）、类型预检（LLM 就绪 422）、cron 合法性（cronNext 422）；
// - enabled 则计算 next_run_at（cronNext(now)），disabled 则 next_run_at=NULL；
// - 列表/详情：admin only；删除走硬删（调度定义本身不软删）；
// - 立即执行（POST /:id/run）：只插一条 trigger='scheduled' 队列行，不推进 next_run_at。
import {
  can,
  type JobScheduleCreate,
  type JobScheduleListQuery,
  type JobSchedulePatch,
} from "@gb-crm/shared";
import type { SystemRole } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { cronNext } from "../../lib/cron.js";
import { forbidden, notFound, unprocessable } from "../../plugins/error-handler.js";
import { assembleJob } from "./assemble.js";
import {
  assembleJobSchedule,
  assembleJobSchedules,
  type JobScheduleDto,
} from "./schedule-assemble.js";
import {
  deleteJobScheduleRow,
  getJobScheduleById,
  insertJobSchedule,
  listJobSchedules,
  updateJobScheduleRow,
} from "./schedule-repo.js";
import { getJobType, JOB_TYPES, parseJobParams } from "./registry.js";
import { getJobByIdAny, insertJob } from "./repo.js";

export interface JobScheduleAuthContext {
  now: number;
  userId: number;
  systemRole: SystemRole | null;
}

function parseParams(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** cron 校验：表达式非法（parseCron 抛错）或 5 年内不可达 → 422 VALIDATION（中文 message） */
function validateCron(cron: string, now: number): void {
  let next: number | null;
  try {
    next = cronNext(cron, now);
  } catch (err) {
    throw unprocessable(err instanceof Error ? err.message : "cron 表达式不合法");
  }
  if (next === null) {
    throw unprocessable("cron 表达式在未来 5 年内无法匹配到触发时间");
  }
}

/** 注册表校验：未知 type 422；按任务类型业务权限 403；params 校验 422；预检；返回规范化 params */
function assertValidatedType(db: Db, role: SystemRole | null, type: string, params: Record<string, unknown>) {
  const def = getJobType(type);
  if (!def) {
    throw unprocessable(`未知任务类型：${type}`, [{ path: "type", message: "未注册" }]);
  }
  if (!can(role, def.requiredPermission.resource, def.requiredPermission.action)) {
    throw forbidden();
  }
  const parsed = parseJobParams(def, params); // 非法 → 422 VALIDATION
  def.validate?.(db, parsed); // 预检（LLM 就绪等）→ 422
  return parsed;
}

export function listJobScheduleTypes(): { type: string; label: string }[] {
  return Object.entries(JOB_TYPES).map(([type, def]) => ({ type, label: def.label }));
}

export function listJobSchedulesResult(
  db: Db,
  query: JobScheduleListQuery,
): { data: JobScheduleDto[]; total: number } {
  const { rows, total } = listJobSchedules(db, query);
  return { data: assembleJobSchedules(db, rows), total };
}

export function getJobScheduleResult(db: Db, id: number): JobScheduleDto {
  const row = getJobScheduleById(db, id);
  if (!row) throw notFound("定时任务不存在");
  return assembleJobSchedule(db, row);
}

export function createJobSchedule(
  db: Db,
  body: JobScheduleCreate,
  ctx: JobScheduleAuthContext,
): JobScheduleDto {
  const parsed = assertValidatedType(db, ctx.systemRole, body.type, body.params ?? {});
  validateCron(body.cron, ctx.now);
  const nextRunAt = cronNext(body.cron, ctx.now);
  const id = insertJobSchedule(db, {
    type: body.type,
    params: JSON.stringify(parsed),
    cron: body.cron.trim(),
    enabled: 1,
    nextRunAt,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  });
  return assembleJobSchedule(db, getJobScheduleById(db, id)!);
}

export function patchJobSchedule(
  db: Db,
  id: number,
  patch: JobSchedulePatch,
  ctx: JobScheduleAuthContext,
): JobScheduleDto {
  const row = getJobScheduleById(db, id);
  if (!row) throw notFound("定时任务不存在");

  // 键存在才更新（PATCH 内核）；未提供的字段沿用当前值
  const type = patch.type ?? row.type;
  const params = patch.params !== undefined ? patch.params : parseParams(row.params);
  const cron = patch.cron !== undefined ? patch.cron.trim() : row.cron;
  const enabled = patch.enabled ?? row.enabled === 1;

  const parsed = assertValidatedType(db, ctx.systemRole, type, params);
  validateCron(cron, ctx.now);
  const nextRunAt = enabled ? cronNext(cron, ctx.now) : null;

  updateJobScheduleRow(db, id, {
    type,
    params: JSON.stringify(parsed),
    cron,
    enabled: enabled ? 1 : 0,
    nextRunAt,
    updatedAt: ctx.now,
    updatedBy: ctx.userId,
  });
  return assembleJobSchedule(db, getJobScheduleById(db, id)!);
}

export function deleteJobScheduleResult(db: Db, id: number): void {
  const row = getJobScheduleById(db, id);
  if (!row) throw notFound("定时任务不存在");
  deleteJobScheduleRow(db, id);
}

/** 立即执行一次（不推进 next_run_at）；返回创建的队列行 DTO 供前端感知 */
export function runJobScheduleNow(
  db: Db,
  id: number,
  ctx: JobScheduleAuthContext,
): ReturnType<typeof assembleJob> {
  const row = getJobScheduleById(db, id);
  if (!row) throw notFound("定时任务不存在");
  const jobId = insertJob(db, {
    type: row.type,
    params: row.params,
    status: "queued",
    progress: "{}",
    trigger: "scheduled",
    triggerSpec: row.cron,
    createdAt: ctx.now,
    createdBy: ctx.userId,
  });
  return assembleJob(db, getJobByIdAny(db, jobId)!);
}
