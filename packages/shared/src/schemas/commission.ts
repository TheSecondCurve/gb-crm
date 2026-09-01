import { z } from "zod";

import { pageQuerySchema } from "./common.js";

// K56 成交分成：以「成交」为粒度的财务配置（可多人、各自比例）。
// 分成金额 = amount_cents × after_tax_ratio（税后基数）× percentage。
// 与其它关系数组同规则：PUT /deals/:id/commissions 的 items「缺席不动、[]=还原为默认」。

/** 单个成交人分成项（占税后基数的比例 0~1） */
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

/** 管理页列表 query：分页 + 成交日期范围（epoch ms）+ 状态（default/custom）+ q */
export const dealCommissionListQuerySchema = pageQuerySchema.extend({
  startDate: z.coerce.number().int().optional(),
  endDate: z.coerce.number().int().optional(),
  /** default=未配置（套默认方案）；custom=已配置 */
  status: z.enum(["default", "custom"]).optional(),
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

/** GET /api/v1/system/commission-default */
export const commissionDefaultGetSchema = z.object({
  rules: z.array(commissionDefaultRuleSchema),
});
export type CommissionDefaultGet = z.infer<typeof commissionDefaultGetSchema>;

/** PATCH /api/v1/system/commission-default：送 rules 即整表替换（admin；单配置不做 OCC，同 llm/s3） */
export const commissionDefaultPatchSchema = z.object({
  rules: z.array(commissionDefaultRuleSchema).max(30),
});
export type CommissionDefaultPatch = z.infer<typeof commissionDefaultPatchSchema>;
