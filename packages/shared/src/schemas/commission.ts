import { z } from "zod";

import { dealStageSchema } from "../enums.js";
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

// ---- 动态筛选条件组（成交分成管理页；dealDate/deliveryDate/productId + 全局 AND/OR）----

/** 列表可排序字段（映射 deals 列，repo 层解析）；方向用 pageQuerySchema 的 order */
export const commissionSortSchema = z.enum(["dealDate", "deliveryDate", "amountCents", "updatedAt"]);
export type CommissionSort = z.infer<typeof commissionSortSchema>;

/** 成交日期范围条件（epoch ms，单边可空；两边都空 = no-op） */
const dealDateFilterRuleSchema = z.object({
  field: z.literal("dealDate"),
  op: z.literal("between"),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
});

/** 交付日期条件：范围 / 空否 */
const deliveryDateFilterRuleSchema = z.object({
  field: z.literal("deliveryDate"),
  op: z.enum(["between", "empty", "notEmpty"]),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
});

/** 产品条件：多选，命中任一 */
const productIdFilterRuleSchema = z.object({
  field: z.literal("productId"),
  op: z.literal("in"),
  ids: z.array(z.number().int().positive()).min(1).max(100),
});

export const commissionFilterRuleSchema = z.discriminatedUnion("field", [
  dealDateFilterRuleSchema,
  deliveryDateFilterRuleSchema,
  productIdFilterRuleSchema,
]);
export type CommissionFilterRule = z.infer<typeof commissionFilterRuleSchema>;

/** 扁平条件组：rules 之间按 combinator 组合（and=满足全部 / or=满足任一） */
export const commissionFilterGroupSchema = z.object({
  combinator: z.enum(["and", "or"]),
  rules: z.array(commissionFilterRuleSchema).min(1).max(20),
});
export type CommissionFilterGroup = z.infer<typeof commissionFilterGroupSchema>;

/** query 参数 filters：JSON 字符串 → 解析 + 校验为条件组；非法 → 422 VALIDATION */
const filtersQuerySchema = z.string().transform((s, ctx) => {
  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "filters 必须是合法 JSON" });
    return z.NEVER;
  }
  const r = commissionFilterGroupSchema.safeParse(raw);
  if (!r.success) {
    for (const issue of r.error.issues) ctx.addIssue(issue);
    return z.NEVER;
  }
  return r.data;
});

/** 管理页列表 query：分页 + 排序（sort/order，缺省 updatedAt）+ 成交日期范围（epoch ms）+ 交付日期范围 + 交付日期空否 + 阶段 + 金额下限 + 状态（default/custom）+ q + payout 状态 + filters 动态条件组 */
export const dealCommissionListQuerySchema = pageQuerySchema.extend({
  /** 排序字段（方向用 order=asc|desc，缺省 desc） */
  sort: commissionSortSchema.optional(),
  /** 成交日期范围（epoch ms） */
  startDate: z.coerce.number().int().optional(),
  endDate: z.coerce.number().int().optional(),
  /** 交付日期范围（epoch ms），与成交日期范围相互独立 */
  deliveryStartDate: z.coerce.number().int().optional(),
  deliveryEndDate: z.coerce.number().int().optional(),
  /** 交付日期是否为空：empty=未填；notEmpty=已填（与交付日期范围叠加） */
  deliveryStatus: z.enum(["empty", "notEmpty"]).optional(),
  /** 成交阶段等值过滤（gift/paid/refunded/closed） */
  stage: dealStageSchema.optional(),
  /** 成交金额下限（分）：amount_cents >= minAmountCents（「金额>0」传 1） */
  minAmountCents: z.coerce.number().int().optional(),
  /** default=未配置（套默认方案）；custom=已配置 */
  status: z.enum(["default", "custom"]).optional(),
  /** v2：按成交是否存在该状态的 payout 过滤 */
  payoutStatus: z.enum(["pending", "paid"]).optional(),
  /** 动态筛选条件组（JSON 字符串：{combinator, rules}），与上方 flat 参数 AND 叠加 */
  filters: filtersQuerySchema.optional(),
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
