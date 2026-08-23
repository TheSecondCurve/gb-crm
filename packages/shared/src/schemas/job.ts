import { z } from "zod";

import { customerListQuerySchema } from "./customer.js";
import { pageQuerySchema } from "./common.js";

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
