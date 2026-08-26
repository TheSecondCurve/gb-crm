// K51 任务类型注册表：type code → 中文名 + 创建所需业务权限 + params schema + 预检 + 执行器。
// 新增任务类型只需在此注册（未来定时任务也是同一套 type，只是 trigger='scheduled'）。
import { bulkTagJobParamsSchema, type Action, type Resource } from "@gb-crm/shared";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { unprocessable } from "../../plugins/error-handler.js";
import { assertAiReady, runBulkTaggingJob } from "../customers/service.js";
import { runDbBackup } from "./backup.js";export interface JobProgress {
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
  /**
   * params 的 Zod schema（M11）：创建时校验（非法 → 422 VALIDATION）、执行前由 runner 复验；
   * 缺省 = 不校验（params 原样透传）。
   */
  paramsSchema?: z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;
  /** 创建时预检（422，先于入队）：LLM 就绪 / 参数合法 */
  validate?: (db: Db, params: Record<string, unknown>) => void;
  run: (ctx: JobContext, params: Record<string, unknown>) => Promise<void>;
}

/** 解析并校验任务参数（M11）：未注册 schema 原样返回；失败 → 422 VALIDATION（中文 message + 字段明细） */
export function parseJobParams(
  def: Pick<JobTypeDef, "paramsSchema">,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (!def.paramsSchema) return raw;
  const parsed = def.paramsSchema.safeParse(raw);
  if (!parsed.success) {
    throw unprocessable("任务参数不合法", parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })));
  }
  return parsed.data;
}

export const JOB_TYPES: Record<string, JobTypeDef> = {
  "customer-tags-generate-all": {
    label: "全量生成客户标签",
    requiredPermission: { resource: "customers", action: "update" },
    // 列表 WHERE 子集（不含分页，任务不分页全量跑）；strict 拒绝未知键
    paramsSchema: bulkTagJobParamsSchema,
    // 创建时即拦：LLM 未配置/词表空 → 422（执行时还会再校验一次，防排队期间配置被清）
    validate: (db) => {
      assertAiReady(db);
    },
    run: async (ctx, params) => {
      // params 已由 runner 经 parseJobParams 复验过，此处仅收窄类型
      const result = await runBulkTaggingJob(ctx.db, params as never, ctx.audit, {
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
  // 数据库备份：仅 admin（system.update）。备份到 <数据库目录>/backups/，gzip + 滚动保留 7 份；
  // 一次性任务，进度 total=1。日常备份由管理员在「定时任务」tab 配 cron 调度。
  "db-backup": {
    label: "数据库备份",
    requiredPermission: { resource: "system", action: "update" },
    run: async (ctx) => {
      ctx.reportProgress({ processed: 0, total: 1, succeeded: 0, failed: 0 });
      if (ctx.isCancelled()) {
        ctx.finish("cancelled", {});
        return;
      }
      const result = await runDbBackup(ctx.db.$client, ctx.audit.now);
      ctx.reportProgress({ processed: 1, total: 1, succeeded: 1, failed: 0 });
      ctx.finish("succeeded", { result });
    },
  },
};

/** 未注册的 type → undefined（创建 422 / 执行 failed） */
export function getJobType(type: string): JobTypeDef | undefined {
  return JOB_TYPES[type];
}
