import { z } from "zod";

import { pageQuerySchema } from "./common.js";

// K56 v2 成交分成：以「成交」为粒度的财务配置（三级：税后基数 → 总比例 → 内部分配）。
// 分红池 = round(税后基数 × totalRatio)；每人金额 = round(分红池 × percentage)。
// percentage 是「占分红池的内部分配比例」（0~1，Σ≤1），不再是 base-relative。
// 与其它关系数组同规则：PUT /deals/:id/commissions 的 items「缺席不动、[]=还原为默认」。

/** 单个成交人分成项（占分红池的内部分配比例 0~1） */
export const commissionItemSchema = z.object({
  userId: z.number().int().positive(),
  percentage: z.number().min(0).max(1),
});
export type CommissionItem = z.infer<typeof commissionItemSchema>;

/** PUT /api/v1/deals/:id/commissions body：items 存在即整表替换；[]=删除配置行（还原默认） */
export const dealCommissionPutSchema = z.object({
  items: z.array(commissionItemSchema).max(30),
});
export type DealCommissionPut = z.infer<typeof dealCommissionPutSchema>;

/** 管理页列表 query：分页 + 成交日期范围（epoch ms）+ 状态（default/custom）+ q + payout 状态 */
export const dealCommissionListQuerySchema = pageQuerySchema.extend({
  startDate: z.coerce.number().int().optional(),
  endDate: z.coerce.number().int().optional(),
  /** default=未配置（套默认方案）；custom=已配置 */
  status: z.enum(["default", "custom"]).optional(),
  /** v2：按成交是否存在该状态的 payout 过滤 */
  payoutStatus: z.enum(["pending", "paid"]).optional(),
});
export type DealCommissionListQuery = z.infer<typeof dealCommissionListQuerySchema>;

/** 全局默认方案（system_configs code='commissionDefault'）：按关系角色推导 + 额外指定人 */
export const commissionDefaultSourceSchema = z.enum(["owner", "dealOwner", "user"]);
export type CommissionDefaultSource = z.infer<typeof commissionDefaultSourceSchema>;

export const commissionDefaultRuleSchema = z
  .object({
    /** owner=客户归属人(customers.owner_id)；dealOwner=成交负责人(deals.owner_id)；user=指定人 */
    source: commissionDefaultSourceSchema,
    percentage: z.number().min(0).max(1),
    userId: z.number().int().positive().optional(),
  })
  .refine((rule) => rule.source !== "user" || rule.userId !== undefined, {
    message: "source=user 时必须提供 userId",
    path: ["userId"],
  });
export type CommissionDefaultRule = z.infer<typeof commissionDefaultRuleSchema>;

/** 全局默认方案（v2）：总比例 + 内部分配规则 */
export interface CommissionDefaultScheme {
  totalRatio: number;
  rules: CommissionDefaultRule[];
}

/** GET /api/v1/system/commission-default */
export const commissionDefaultGetSchema = z.object({
  /** v2：全局默认分红总比例（0~1；成交未单独覆盖、产品无默认时回退到此） */
  totalRatio: z.number().min(0).max(1),
  rules: z.array(commissionDefaultRuleSchema),
});
export type CommissionDefaultGet = z.infer<typeof commissionDefaultGetSchema>;

/** PATCH /api/v1/system/commission-default：送 totalRatio+rules 即整表替换（admin；单配置不做 OCC，同 llm/s3） */
export const commissionDefaultPatchSchema = z.object({
  totalRatio: z.number().min(0).max(1),
  rules: z.array(commissionDefaultRuleSchema).max(30),
});
export type CommissionDefaultPatch = z.infer<typeof commissionDefaultPatchSchema>;

// ---- payout（v2）----

/** payout 支付期序号 */
export const payoutSeqSchema = z.union([z.literal(1), z.literal(2)]);

/** PUT /deals/:id/payouts body：payouts 存在即整表替换；[]=清空；seq 唯一、rate 0~1、date epoch ms */
export const dealPayoutUpsertSchema = z
  .object({
    payouts: z
      .array(
        z.object({
          seq: payoutSeqSchema,
          payoutDate: z.number().int(),
          rate: z.number().min(0).max(1),
        }),
      )
      .max(2),
  })
  .refine((v) => new Set(v.payouts.map((p) => p.seq)).size === v.payouts.length, {
    message: "payout 支付期序号不能重复",
    path: ["payouts"],
  });
export type DealPayoutUpsert = z.infer<typeof dealPayoutUpsertSchema>;

/** PATCH /deals/:id/payouts/:seq body：状态流转 */
export const dealPayoutPatchSchema = z.object({
  status: z.enum(["pending", "paid"]),
});
export type DealPayoutPatch = z.infer<typeof dealPayoutPatchSchema>;
