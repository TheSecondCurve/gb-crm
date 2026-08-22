import { z } from "zod";

import { deliverableDimensionSchema } from "../enums.js";
import { epochMsSchema, pageQuerySchema } from "./common.js";

const nullableText = z.string().nullable();
const idArraySchema = z.array(z.number().int().positive());

// ---- 交付类型配置表（K44）----
// 字段与 0010_deliverables_v2.sql delivery_types 表列对应（camelCase）。
// defaultTasks：多行文本，每行一个默认动作；创建交付项时按类型模板预填。
export const deliveryTypeWriteSchema = z.object({
  name: z.string().min(1),
  description: nullableText.optional(),
  defaultTasks: nullableText.optional(),
});
export type DeliveryTypeWrite = z.infer<typeof deliveryTypeWriteSchema>;

export const deliveryTypePatchSchema = deliveryTypeWriteSchema
  .partial()
  .extend({ updatedAt: epochMsSchema });
export type DeliveryTypePatch = z.infer<typeof deliveryTypePatchSchema>;

export const deliveryTypeSortSchema = z.enum(["updatedAt", "createdAt", "name"]);

export const deliveryTypeListQuerySchema = pageQuerySchema.extend({
  sort: deliveryTypeSortSchema.optional(),
});
export type DeliveryTypeListQuery = z.infer<typeof deliveryTypeListQuerySchema>;

// ---- 交付单（K44：精简 = 类型 + 客户集合 + 备注；与成交弱关联，客户来源可来自成交 merge）----
export const deliveryWriteSchema = z.object({
  deliveryTypeId: z.number().int().positive(),
  // 客户集合：创建必填（至少一个）
  customerIds: idArraySchema.min(1),
  remark: nullableText.optional(),
});
export type DeliveryWrite = z.infer<typeof deliveryWriteSchema>;

// PATCH：customerIds 允许 []（清空），缺席不动（K24 关系数组语义）
export const deliveryPatchSchema = z
  .object({
    deliveryTypeId: z.number().int().positive().optional(),
    customerIds: idArraySchema.optional(),
    remark: nullableText.optional(),
  })
  .extend({ updatedAt: epochMsSchema });
export type DeliveryPatch = z.infer<typeof deliveryPatchSchema>;

export const deliverySortSchema = z.enum(["updatedAt", "createdAt"]);

export const deliveryListQuerySchema = pageQuerySchema.extend({
  sort: deliverySortSchema.optional(),
  deliveryTypeId: z.coerce.number().int().positive().optional(),
  customerId: z.coerce.number().int().positive().optional(),
});
export type DeliveryListQuery = z.infer<typeof deliveryListQuerySchema>;

// ---- 交付项（K44：项目维度 / 客户维度；无独立状态，打勾进度即状态）----
// 客户维度创建时 customerIds 省略 = 交付单全部客户；显式传 = 部分客户。
// dimension 与 customer 范围创建后不可改（避免迁移已生成的任务）。
export const deliverableWriteSchema = z.object({
  content: z.string().min(1),
  dimension: deliverableDimensionSchema.default("project"),
  customerIds: idArraySchema.optional(),
  description: nullableText.optional(),
  deliveryUrl: nullableText.optional(),
});
export type DeliverableWrite = z.infer<typeof deliverableWriteSchema>;

export const deliverablePatchSchema = z
  .object({
    content: z.string().min(1).optional(),
    description: nullableText.optional(),
    deliveryUrl: nullableText.optional(),
  })
  .extend({ updatedAt: epochMsSchema });
export type DeliverablePatch = z.infer<typeof deliverablePatchSchema>;

// ---- 动作清单任务（K44：客户维度按 customer_id 展开，每客户分别打勾/备注）----
export const deliveryTaskWriteSchema = z.object({
  content: z.string().trim().min(1),
  // 客户维度交付项的任务必带 customerId；项目维度缺席（NULL）
  customerId: z.number().int().positive().optional(),
});
export type DeliveryTaskWrite = z.infer<typeof deliveryTaskWriteSchema>;

export const deliveryTaskPatchSchema = z.object({
  content: z.string().trim().min(1).optional(),
  done: z.boolean().optional(),
  remark: z.string().nullable().optional(),
  updatedAt: epochMsSchema,
});
export type DeliveryTaskPatch = z.infer<typeof deliveryTaskPatchSchema>;
