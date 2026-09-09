import { z } from "zod";
import { epochMsSchema, pageQuerySchema } from "./common.js";
import { payoutBatchStatusSchema } from "../enums.js";
import { payoutSeqSchema } from "./commission.js";

// payout 结算批次（K59）：按 payout 日期范围归集待发 payout → 草稿可增删明细 →
// 锁定快照确认（金额与人均分摊物化，供查账）→ 批量标记已发。

/** POST /payout-batches body：创建草稿批次并自动纳入范围内全部未占用待发 payout */
export const payoutBatchCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    startDate: epochMsSchema,
    endDate: epochMsSchema,
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: "开始日期不能晚于结束日期",
    path: ["startDate"],
  });
export type PayoutBatchCreate = z.infer<typeof payoutBatchCreateSchema>;

/** PATCH /payout-batches/:id body：仅 draft 可改名（键存在才改） */
export const payoutBatchPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});
export type PayoutBatchPatch = z.infer<typeof payoutBatchPatchSchema>;

/** POST /payout-batches/:id/items body：单独添加一条 payout 明细 */
export const payoutBatchItemAddSchema = z.object({
  dealId: z.number().int().positive(),
  seq: payoutSeqSchema,
});
export type PayoutBatchItemAdd = z.infer<typeof payoutBatchItemAddSchema>;

/** GET /payout-batches query */
export const payoutBatchListQuerySchema = pageQuerySchema.extend({
  status: payoutBatchStatusSchema.optional(),
});
export type PayoutBatchListQuery = z.infer<typeof payoutBatchListQuerySchema>;

/** GET /payout-batches/candidates query：待发 payout 候选（payout 粒度） */
export const payoutBatchCandidatesQuerySchema = z.object({
  startDate: z.coerce.number().int().optional(),
  endDate: z.coerce.number().int().optional(),
});
export type PayoutBatchCandidatesQuery = z.infer<typeof payoutBatchCandidatesQuerySchema>;
