import { z } from "zod";

import { productStatusSchema, productTypeSchema } from "../enums.js";
import { epochMsSchema, pageQuerySchema, queryBooleanSchema } from "./common.js";

const nullableText = z.string().nullable();

// 字段与 0000_init.sql products 表列对应（camelCase）。
// K13：priceCents 为 integer 分，NULL = 未定价；非整数 422。
// K43：defaultTasks 多行文本（每行一个默认交付动作，新建交付项时预填模板）。
export const productWriteSchema = z.object({
  name: z.string().min(1),
  notes: nullableText.optional(),
  sopUrl: nullableText.optional(),
  packageIncludes: nullableText.optional(),
  deliveryCycle: nullableText.optional(),
  productType: productTypeSchema.default("c_consulting"),
  isPackage: z.boolean().default(false),
  status: productStatusSchema.default("on_sale"),
  priceCents: z.number().int().nullable().optional(),
  defaultTasks: nullableText.optional(),
});
export type ProductWrite = z.infer<typeof productWriteSchema>;

export const productPatchSchema = productWriteSchema
  .partial()
  .extend({ updatedAt: epochMsSchema });
export type ProductPatch = z.infer<typeof productPatchSchema>;

export const productSortSchema = z.enum(["updatedAt", "createdAt", "name", "priceCents"]);

export const productListQuerySchema = pageQuerySchema.extend({
  sort: productSortSchema.optional(),
  productType: productTypeSchema.optional(),
  status: productStatusSchema.optional(),
  isPackage: queryBooleanSchema.optional(),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;
