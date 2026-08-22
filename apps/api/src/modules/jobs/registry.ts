// K51 任务类型注册表：type code → 中文名 + 创建所需业务权限 + 预检 + 执行器。
// 新增任务类型只需在此注册（未来定时任务也是同一套 type，只是 trigger='scheduled'）。
import { type Action, type Resource, type CustomerListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { assertAiReady, runBulkTaggingJob } from "../customers/service.js";export interface JobProgress {
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
}

export interface JobContext {
  db: Db;
  jobId: number;
  /** 执行审计（createdBy 即任务创建人；createdAt 用 runner 时钟） */
  audit: { now: number; userId: number | null };
  fetchFn?: typeof fetch;
  /** 每迭代前检查：已被取消（status='cancelled'）时返回 true */
  isCancelled: () => boolean;
  /** 写进度（初始 + 每客户后） */
  reportProgress: (p: JobProgress) => void;
  /** 落终态（succeeded/partial/failed/cancelled）+ 可选 result/error；handler 必须恰好调用一次 */
  finish: (
    status: "succeeded" | "partial" | "failed" | "cancelled",
    payload: { result?: unknown; error?: string },
  ) => void;
}

export interface JobTypeDef {
  label: string;
  /** 创建任务时的业务权限（路由层 requireCan(jobs, create) 之外的资源权限，如批量打标 → customers.update） */
  requiredPermission: { resource: Resource; action: Action };
  /** 创建时预检（422，先于入队）：LLM 就绪 / 参数合法 */
  validate?: (db: Db, params: Record<string, unknown>) => void;
  run: (ctx: JobContext, params: Record<string, unknown>) => Promise<void>;
}

export const JOB_TYPES: Record<string, JobTypeDef> = {
  "customer-tags-generate-all": {
    label: "全量生成客户标签",
    requiredPermission: { resource: "customers", action: "update" },
    // 创建时即拦：LLM 未配置/词表空 → 422（执行时还会再校验一次，防排队期间配置被清）
    validate: (db) => {
      assertAiReady(db);
    },
    run: async (ctx, params) => {
      const result = await runBulkTaggingJob(ctx.db, params as unknown as CustomerListQuery, ctx.audit, {
        fetchFn: ctx.fetchFn,
        isCancelled: ctx.isCancelled,
        onProgress: ctx.reportProgress,
      });
      if (result.cancelled) {
        ctx.finish("cancelled", { result });
        return;
      }
      // 全成功=succeeded；部分失败=partial；全失败=failed
      const status = result.failed === 0 ? "succeeded" : result.succeeded > 0 ? "partial" : "failed";
      ctx.finish(status, { result });
    },
  },
};

/** 未注册的 type → undefined（创建 422 / 执行 failed） */
export function getJobType(type: string): JobTypeDef | undefined {
  return JOB_TYPES[type];
}
