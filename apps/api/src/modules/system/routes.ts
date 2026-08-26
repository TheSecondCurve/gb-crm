// /api/v1/system 路由（K46/K50：LLM 打标配置；K53：S3 远程备份配置——均仅 admin）。
// 存储为 system_configs code='llm'/'s3'；GET 掩码返回；PATCH 单管理员、有意不做 OCC（见 service.ts 注释）。
import { aiConfigPatchSchema, pageAccessPatchSchema, s3ConfigPatchSchema } from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";

import type { Db } from "../../db/client.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  getAiConfigResult,
  getPageAccessMatrix,
  getS3ConfigResult,
  patchAiConfig,
  patchPageAccess,
  patchS3Config,
  testS3Connection,
} from "./service.js";

export interface SystemRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
  /** K53 S3 客户端 fetch 注入（测试 mock）；默认全局 fetch */
  s3Fetch?: typeof fetch;
}

export function systemRoutes(app: FastifyInstance, opts: SystemRoutesOptions): void {
  const { db, now, s3Fetch } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get(
    "/api/v1/system/ai-config",
    { preHandler: requireCan("system", "read") },
    async () => ({ data: getAiConfigResult(db) }),
  );

  app.patch(
    "/api/v1/system/ai-config",
    { preHandler: requireCan("system", "update") },
    async (req) => {
      const patch = aiConfigPatchSchema.parse(req.body ?? {});
      return { data: patchAiConfig(db, patch, auditCtx(req)) };
    },
  );

  // 角色→页面权限（配置层；仅 admin——system.read/update）。admin 固定全量，只配 operator/assistant。
  app.get(
    "/api/v1/system/page-access",
    { preHandler: requireCan("system", "read") },
    async () => ({ data: getPageAccessMatrix(db) }),
  );

  app.patch(
    "/api/v1/system/page-access",
    { preHandler: requireCan("system", "update") },
    async (req) => {
      const patch = pageAccessPatchSchema.parse(req.body ?? {});
      return { data: patchPageAccess(db, patch, auditCtx(req)) };
    },
  );

  // S3 兼容对象存储远程备份（K53；仅 admin）。test 用写权限（会产生上游写+删探针对象）。
  app.get(
    "/api/v1/system/s3-config",
    { preHandler: requireCan("system", "read") },
    async () => ({ data: getS3ConfigResult(db) }),
  );

  app.patch(
    "/api/v1/system/s3-config",
    { preHandler: requireCan("system", "update") },
    async (req) => {
      const patch = s3ConfigPatchSchema.parse(req.body ?? {});
      return { data: patchS3Config(db, patch, auditCtx(req)) };
    },
  );

  app.post(
    "/api/v1/system/s3-config/test",
    { preHandler: requireCan("system", "update") },
    async () => ({ data: await testS3Connection(db, { fetchFn: s3Fetch }) }),
  );
}
