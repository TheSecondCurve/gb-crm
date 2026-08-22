// jobs 业务规则（K51）：
// - 创建：type 注册表校验（未知 422）+ 业务权限（requiredPermission，如批量打标 → customers.update，
//   权限唯一来源仍是 shared.can()）+ type 预检（LLM 未配置/词表空 422）→ 入队 queued；
// - 列表/详情：全角色可见（内网、参数不敏感；非行级 ACL 收紧）；
// - 取消：仅 queued/running（结束态 409）；非本人操作需 jobs.cancelAny（仅 admin）。
import { can, type JobCreate, type JobListQuery } from "@gb-crm/shared";
import type { SystemRole } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { conflict, forbidden, notFound, unprocessable } from "../../plugins/error-handler.js";
import { assembleJob, assembleJobs, type BackgroundJobDto } from "./assemble.js";
import {
  cancelJob as cancelJobRow,
  getJobByIdAny,
  insertJob,
  listJobs,
} from "./repo.js";
import { getJobType } from "./registry.js";

export interface JobAuthContext {
  now: number;
  userId: number;
  systemRole: SystemRole | null;
}

export function listJobsResult(db: Db, query: JobListQuery): { data: BackgroundJobDto[]; total: number } {
  const { rows, total } = listJobs(db, query);
  return { data: assembleJobs(db, rows), total };
}

export function getJobResult(db: Db, id: number): BackgroundJobDto {
  const row = getJobByIdAny(db, id);
  if (!row) throw notFound("任务不存在");
  return assembleJob(db, row);
}

export function createJob(db: Db, body: JobCreate, ctx: JobAuthContext): BackgroundJobDto {
  const def = getJobType(body.type);
  if (!def) {
    throw unprocessable(`未知任务类型：${body.type}`, [{ path: "type", message: "未注册" }]);
  }
  // 任务类型的业务权限（批量打标 → customers.update；与同步打标端点同权）
  if (!can(ctx.systemRole, def.requiredPermission.resource, def.requiredPermission.action)) {
    throw forbidden();
  }
  // 创建时预检（LLM 就绪等），先于入队给用户即时反馈
  def.validate?.(db, body.params ?? {});

  const id = insertJob(db, {
    type: body.type,
    params: JSON.stringify(body.params ?? {}),
    status: "queued",
    progress: JSON.stringify({ processed: 0, total: 0, succeeded: 0, failed: 0 }),
    trigger: "manual",
    createdAt: ctx.now,
    createdBy: ctx.userId,
  });
  return assembleJob(db, getJobByIdAny(db, id)!);
}

export function cancelJobResult(db: Db, id: number, ctx: JobAuthContext): BackgroundJobDto {
  const row = getJobByIdAny(db, id);
  if (!row) throw notFound("任务不存在");
  // 非本人操作 → 需 cancelAny（仅 admin）
  if (row.createdBy !== ctx.userId && !can(ctx.systemRole, "jobs", "cancelAny")) {
    throw forbidden();
  }
  const changes = cancelJobRow(db, id, ctx.now);
  if (changes === 0) throw conflict("任务已结束，无法取消");
  return assembleJob(db, getJobByIdAny(db, id)!);
}
