import { z } from "zod";

import { deliverableStatusSchema } from "../enums.js";
import { epochMsSchema, pageQuerySchema } from "./common.js";

const nullableText = z.string().nullable();

// 字段与 0009_deliverables.sql deliverables / delivery_tasks 表列对应（camelCase）。
// K43：交付项挂成交（dealId 创建必填，一个成交可拆多个交付项）；productId 可空；
// 日期为 epoch ms；动作清单是交付项子表（独立子端点 CRUD，不打整表替换）。
export const deliverableWriteSchema = z.object({
  dealId: z.number().int().positive(),
  productId: z.number().int().positive().nullable().optional(),
  status: deliverableStatusSchema.default("pending"),
  planDeliverDate: z.number().int().nullable().optional(),
  actualDeliverDate: z.number().int().nullable().optional(),
  expiryDate: z.number().int().nullable().optional(),
  description: nullableText.optional(),
  deliveryUrl: nullableText.optional(),
});
export type DeliverableWrite = z.infer<typeof deliverableWriteSchema>;

// PATCH 内核（K24）：.partial() 只表示键可缺席，实现不得把缺席键绑成 SQL NULL。
export const deliverablePatchSchema = deliverableWriteSchema
  .partial()
  .extend({ updatedAt: epochMsSchema });
export type DeliverablePatch = z.infer<typeof deliverablePatchSchema>;

export const deliverableSortSchema = z.enum(["updatedAt", "createdAt", "planDeliverDate"]);

export const deliverableListQuerySchema = pageQuerySchema.extend({
  sort: deliverableSortSchema.optional(),
  status: deliverableStatusSchema.optional(),
  dealId: z.coerce.number().int().positive().optional(),
  productId: z.coerce.number().int().positive().optional(),
  customerId: z.coerce.number().int().positive().optional(),
});
export type DeliverableListQuery = z.infer<typeof deliverableListQuerySchema>;

// 动作清单子端点：新建（追加到末尾）、PATCH（改文本 / 打勾，done 翻转由服务端记 done_at/done_by）。
export const deliveryTaskWriteSchema = z.object({
  content: z.string().trim().min(1),
});
export type DeliveryTaskWrite = z.infer<typeof deliveryTaskWriteSchema>;

export const deliveryTaskPatchSchema = z.object({
  content: z.string().trim().min(1).optional(),
  done: z.boolean().optional(),
  updatedAt: epochMsSchema,
});
export type DeliveryTaskPatch = z.infer<typeof deliveryTaskPatchSchema>;
