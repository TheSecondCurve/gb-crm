import { z } from "zod";

import { dealStageSchema, productTypeSchema } from "../enums.js";
import { epochMsSchema, pageQuerySchema } from "./common.js";

const nullableText = z.string().nullable();

// 字段与 0008_deals.sql deals 表列对应（camelCase）。
// K42：客户/意向产品/负责人均为单值 FK；customerId 创建必填（成交记录的主体），
// productId/ownerId 可空；dealDate 成交日期非空（新建必填 epoch ms）；
// deliveryDate 交付日期可空可清空（与成交日期并存、语义不同）。
export const dealWriteSchema = z.object({
  customerId: z.number().int().positive(),
  productId: z.number().int().positive().nullable().optional(),
  ownerId: z.number().int().positive().nullable().optional(),
  stage: dealStageSchema.default("gift"),
  orderNo: nullableText.optional(),
  paymentRemark: nullableText.optional(),
  dealDate: z.number().int(),
  deliveryDate: z.number().int().nullable().optional(),
  // K13 金额约定：amountCents 整数「分」，NULL = 未填；afterTaxRatio 税后比例 0~1（REAL）。
  amountCents: z.number().int().nullable().optional(),
  afterTaxRatio: z.number().min(0).max(1).nullable().optional(),
  // 成交分成 v2：分红总比例 0~1（可空；null=清空回退产品/全局默认）
  commissionRatio: z.number().min(0).max(1).nullable().optional(),
});
export type DealWrite = z.infer<typeof dealWriteSchema>;

// PATCH 内核（K24）：.partial() 只表示键可缺席，实现不得把缺席键绑成 SQL NULL。
export const dealPatchSchema = dealWriteSchema
  .partial()
  .extend({ updatedAt: epochMsSchema });
export type DealPatch = z.infer<typeof dealPatchSchema>;

export const dealSortSchema = z.enum(["updatedAt", "createdAt", "dealDate", "deliveryDate"]);

export const dealListQuerySchema = pageQuerySchema.extend({
  sort: dealSortSchema.optional(),
  stage: dealStageSchema.optional(),
  // K44：按意向产品类型过滤成交（前端「按意向产品 merge 客户」依赖）
  productType: productTypeSchema.optional(),
  customerId: z.coerce.number().int().positive().optional(),
  productId: z.coerce.number().int().positive().optional(),
  ownerId: z.coerce.number().int().positive().optional(),
  // 客户归属人（customers.owner_id，EXISTS 子查询）；日期字段一律 epoch ms（同成交分成列表约定）
  customerOwnerId: z.coerce.number().int().positive().optional(),
  /** 成交日期范围（deal_date，endDate 含当日尾） */
  startDate: z.coerce.number().int().optional(),
  endDate: z.coerce.number().int().optional(),
  /** 交付日期范围（delivery_date），与成交日期范围相互独立 */
  deliveryStartDate: z.coerce.number().int().optional(),
  deliveryEndDate: z.coerce.number().int().optional(),
  /** 交付日期是否为空：empty=未填；notEmpty=已填（可与交付日期范围叠加） */
  deliveryStatus: z.enum(["empty", "notEmpty"]).optional(),
});
export type DealListQuery = z.infer<typeof dealListQuerySchema>;
