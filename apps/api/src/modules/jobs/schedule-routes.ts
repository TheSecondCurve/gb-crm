// /api/v1/job-schedules 路由（K52，§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// 仅 admin（ACL jobSchedules）；定时任务调度定义维护 + 立即执行一次。
import {
  jobScheduleCreateSchema,
  jobScheduleListQuerySchema,
  jobSchedulePatchSchema,
  type SystemRole,
} from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  createJobSchedule,
  deleteJobScheduleResult,
  getJobScheduleResult,
  listJobScheduleTypes,
  listJobSchedulesResult,
  patchJobSchedule,
  runJobScheduleNow,
  type JobScheduleAuthContext,
} from "./schedule-service.js";

export interface JobSchedulesRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function jobSchedulesRoutes(app: FastifyInstance, opts: JobSchedulesRoutesOptions): void {
  const { db, now } = opts;
  const authCtx = (req: { user: { id: number; systemRole: SystemRole } | null }): JobScheduleAuthContext => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
    systemRole: req.user!.systemRole,
  });

  // 可被调度的任务类型（供前端创建表单选型）
  app.get(
    "/api/v1/job-schedules/types",
    { preHandler: requireCan("jobSchedules", "list") },
    async () => ({ data: listJobScheduleTypes() }),
  );

  app.get(
    "/api/v1/job-schedules",
    { preHandler: requireCan("jobSchedules", "list") },
    async (req) => {
      const query = jobScheduleListQuerySchema.parse(req.query ?? {});
      const { data, total } = listJobSchedulesResult(db, query);
      return { data, meta: listMeta(query.page, query.pageSize, total) };
    },
  );

  app.post(
    "/api/v1/job-schedules",
    { preHandler: requireCan("jobSchedules", "create") },
    async (req, reply) => {
      const body = jobScheduleCreateSchema.parse(req.body ?? {});
      return reply.code(201).send({ data: createJobSchedule(db, body, authCtx(req)) });
    },
  );

  app.get(
    "/api/v1/job-schedules/:id",
    { preHandler: requireCan("jobSchedules", "read") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      return { data: getJobScheduleResult(db, id) };
    },
  );

  app.patch(
    "/api/v1/job-schedules/:id",
    { preHandler: requireCan("jobSchedules", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = jobSchedulePatchSchema.parse(req.body ?? {});
      return { data: patchJobSchedule(db, id, patch, authCtx(req)) };
    },
  );

  app.delete(
    "/api/v1/job-schedules/:id",
    { preHandler: requireCan("jobSchedules", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteJobScheduleResult(db, id);
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/job-schedules/:id/run",
    { preHandler: requireCan("jobSchedules", "update") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      return { data: runJobScheduleNow(db, id, authCtx(req)) };
    },
  );
}
