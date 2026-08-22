// /api/v1/background-jobs 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// K51：手动触发后台任务 + 运维查看（列表/详情/取消）。jobs.create/list/read/cancel 见 shared ACL。
import { jobCreateSchema, jobListQuerySchema, type SystemRole } from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import { cancelJobResult, createJob, getJobResult, listJobsResult, type JobAuthContext } from "./service.js";

export interface JobsRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function jobsRoutes(app: FastifyInstance, opts: JobsRoutesOptions): void {
  const { db, now } = opts;
  const authCtx = (req: { user: { id: number; systemRole: SystemRole } | null }): JobAuthContext => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
    systemRole: req.user!.systemRole,
  });

  app.post(
    "/api/v1/background-jobs",
    { preHandler: requireCan("jobs", "create") },
    async (req, reply) => {
      const body = jobCreateSchema.parse(req.body ?? {});
      return reply.code(201).send({ data: createJob(db, body, authCtx(req)) });
    },
  );

  app.get("/api/v1/background-jobs", { preHandler: requireCan("jobs", "list") }, async (req) => {
    const query = jobListQuerySchema.parse(req.query ?? {});
    const { data, total } = listJobsResult(db, query);
    return { data, meta: listMeta(query.page, query.pageSize, total) };
  });

  app.get(
    "/api/v1/background-jobs/:id",
    { preHandler: requireCan("jobs", "read") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      return { data: getJobResult(db, id) };
    },
  );

  app.post(
    "/api/v1/background-jobs/:id/cancel",
    { preHandler: requireCan("jobs", "cancel") },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      return { data: cancelJobResult(db, id, authCtx(req)) };
    },
  );
}
