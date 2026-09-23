// K62 insights 路由：透视台 / 客户深潜 / 信号读写 / 词表。
// ACL：insights 资源（admin/operator；assistant 默认拒绝）。
// 「口径即 API」：pivot/depth 响应带 meta.calibre（shared insightsCalibre 快照），agent 与页面同口径。
import {
  insightDepthParamsSchema,
  insightsCalibre,
  pivotQuerySchema,
  signalIdParamsSchema,
  signalManualWriteSchema,
  signalTopicMergeSchema,
  signalTopicsListQuerySchema,
  signalsListQuerySchema,
} from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  geoResult,
  guardResult,
  intentResult,
  ladderResult,
} from "./decisions.js";
import { matchResult } from "./match.js";
import { insightsSummaryResult } from "./summary.js";
import {
  createManualSignalResult,
  depthResult,
  listSignalsResult,
  listTopicsResult,
  mergeTopicResult,
  pivotResult,
  rejectSignalResult,
} from "./service.js";

export interface InsightsRoutesOptions {
  db: Db;
  now: () => number;
  /** LLM fetch 注入（AI 经营备忘；未配置时端点内部回退规则版） */
  llmFetch?: typeof fetch;
}

export function insightsRoutes(app: FastifyInstance, opts: InsightsRoutesOptions): void {
  const { db, now, llmFetch } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });

  app.get(
    "/api/v1/insights/pivot",
    { preHandler: requireCan("insights", "list") },
    async (req) => {
      const query = pivotQuerySchema.parse(req.query ?? {});
      const data = pivotResult(db, query, now());
      return { data, meta: { calibre: insightsCalibre(), windowDays: query.window, generatedAt: now() } };
    },
  );

  app.get(
    "/api/v1/insights/customers/:id/depth",
    { preHandler: requireCan("insights", "read") },
    async (req) => {
      const { id } = insightDepthParamsSchema.parse(req.params);
      const data = depthResult(db, id, now());
      return { data, meta: { calibre: insightsCalibre(), generatedAt: now() } };
    },
  );

  // ── 二期决策台（K62）：全部纯查询视图，消费一期事实与信号 ──

  app.get(
    "/api/v1/insights/geo",
    { preHandler: requireCan("insights", "list") },
    async () => {
      return { data: geoResult(db, now()), meta: { calibre: insightsCalibre(), generatedAt: now() } };
    },
  );

  app.get(
    "/api/v1/insights/ladder",
    { preHandler: requireCan("insights", "list") },
    async () => {
      return { data: ladderResult(db, now()), meta: { calibre: insightsCalibre(), generatedAt: now() } };
    },
  );

  app.get(
    "/api/v1/insights/intent",
    { preHandler: requireCan("insights", "list") },
    async () => {
      return { data: intentResult(db, now()), meta: { calibre: insightsCalibre(), generatedAt: now() } };
    },
  );

  app.get(
    "/api/v1/insights/guard",
    { preHandler: requireCan("insights", "list") },
    async () => {
      return { data: guardResult(db, now()), meta: { calibre: insightsCalibre(), generatedAt: now() } };
    },
  );

  // ── 三期 缘分清单（need × supply 两级召回）与词表健康度（GET /insights/topics 已有） ──

  app.get(
    "/api/v1/insights/match",
    { preHandler: requireCan("insights", "list") },
    async () => {
      return { data: matchResult(db, now()), meta: { calibre: insightsCalibre(), generatedAt: now() } };
    },
  );

  // ── 四期 AI 经营备忘：显式动作（POST），LLM 可用时生成、否则回退规则版 ──

  app.post(
    "/api/v1/insights/summary",
    { preHandler: requireCan("insights", "read") },
    async () => {
      const data = await insightsSummaryResult(db, now(), llmFetch);
      return { data, meta: { generatedAt: data.generatedAt } };
    },
  );

  app.get(
    "/api/v1/insights/signals",
    { preHandler: requireCan("insights", "list") },
    async (req) => {
      const query = signalsListQuerySchema.parse(req.query ?? {});
      const { data, total } = listSignalsResult(
        db,
        { customerId: query.customerId, type: query.type, activeOnly: query.active, page: query.page, pageSize: query.pageSize },
        now(),
      );
      return { data, meta: listMeta(query.page, query.pageSize, total) };
    },
  );

  app.post(
    "/api/v1/insights/signals",
    { preHandler: requireCan("insights", "create") },
    async (req, reply) => {
      const body = signalManualWriteSchema.parse(req.body ?? {});
      const data = createManualSignalResult(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.post(
    "/api/v1/insights/signals/:id/reject",
    { preHandler: requireCan("insights", "update") },
    async (req) => {
      const { id } = signalIdParamsSchema.parse(req.params);
      return { data: rejectSignalResult(db, id, auditCtx(req)) };
    },
  );

  app.get(
    "/api/v1/insights/topics",
    { preHandler: requireCan("insights", "list") },
    async (req) => {
      const query = signalTopicsListQuerySchema.parse(req.query ?? {});
      const { data, total } = listTopicsResult(db, now(), query.page, query.pageSize);
      return { data, meta: listMeta(query.page, query.pageSize, total) };
    },
  );

  app.post(
    "/api/v1/insights/topics/:id/merge",
    { preHandler: requireCan("insights", "update") },
    async (req) => {
      const { id } = signalIdParamsSchema.parse(req.params);
      const body = signalTopicMergeSchema.parse(req.body ?? {});
      const data = mergeTopicResult(db, id, body.intoId, auditCtx(req));
      return { data };
    },
  );
}
