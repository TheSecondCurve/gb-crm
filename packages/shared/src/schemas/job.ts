import { z } from "zod";

import { pageQuerySchema, queryBooleanSchema } from "./common.js";
import { customerListQuerySchema } from "./customer.js";

// K51 后台任务（background_jobs）：手动触发 + 未来定时触发（trigger 字段预留）。
// 状态机：queued → running → succeeded | partial | failed | cancelled。

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobTriggerSchema = z.enum(["manual", "scheduled"]);
export type JobTrigger = z.infer<typeof jobTriggerSchema>;

export const jobListQuerySchema = pageQuerySchema.extend({
  status: jobStatusSchema.optional(),
  type: z.string().trim().max(50).optional(),
});
export type JobListQuery = z.infer<typeof jobListQuerySchema>;

/** 创建任务：type 由服务端注册表驱动；params 为任务参数（批量打标 = 列表 WHERE） */
export const jobCreateSchema = z.object({
  type: z.string().trim().min(1).max(50),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type JobCreate = z.infer<typeof jobCreateSchema>;

/**
 * K51 批量打标任务参数（M11）：客户列表 WHERE 子集（q/order/sort/customerType/ownerId/channelId/tagId）。
 * 任务不分页全量跑，去掉 page/pageSize；strict 拒绝未知键，防执行期 TypeError / SqliteError。
 * 创建时校验（非法 422），执行前复验（防排队期间代码演进后落库 params 不兼容）。
 */
export const bulkTagJobParamsSchema = customerListQuerySchema
  .omit({ page: true, pageSize: true })
  .strict();
export type BulkTagJobParams = z.infer<typeof bulkTagJobParamsSchema>;

// ---- K52 定时任务：调度定义（cron 表达式 + 任务类型 + params + 启停）。仅 admin 维护（ACL jobSchedules）----
// 调度器把到期 next_run_at 物化成 background_jobs（trigger='scheduled'）行；执行器无感知。

export const jobScheduleListQuerySchema = pageQuerySchema
  .pick({ page: true, pageSize: true })
  .extend({ enabled: queryBooleanSchema.optional() });
export type JobScheduleListQuery = z.infer<typeof jobScheduleListQuerySchema>;

/** 创建调度：type 由注册表驱动；params 任务参数（批量打标 = 列表 WHERE，执行侧按注册表 schema 复验）；cron 5 字段 */
export const jobScheduleCreateSchema = z.object({
  type: z.string().trim().min(1).max(50),
  params: z.record(z.string(), z.unknown()).optional(),
  cron: z.string().trim().min(1).max(100),
});
export type JobScheduleCreate = z.infer<typeof jobScheduleCreateSchema>;

/** 更新调度：键存在才更新（沿用 PATCH 内核语义）；enabled 启停 */
export const jobSchedulePatchSchema = z.object({
  type: z.string().trim().min(1).max(50).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  cron: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
});
export type JobSchedulePatch = z.infer<typeof jobSchedulePatchSchema>;
