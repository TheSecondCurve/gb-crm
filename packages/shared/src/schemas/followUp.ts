import { z } from "zod";

import { maintenanceKindSchema } from "../enums.js";
import { epochMsSchema, pageQuerySchema } from "./common.js";

const nullableText = z.string().nullable();

// 字段与 0021_customer_maintenance_records.sql 表列对应（camelCase）。
// K55：customerId 取自路由路径（:customerId），body 不含；kind/happenedAt 必填；content 可空。
export const maintenanceRecordWriteSchema = z.object({
  kind: maintenanceKindSchema,
  happenedAt: epochMsSchema,
  content: nullableText.optional(),
});
export type MaintenanceRecordWrite = z.infer<typeof maintenanceRecordWriteSchema>;

// PATCH 内核（K24）：.partial() 只表示键可缺席，实现不得把缺席键绑成 SQL NULL。
export const maintenanceRecordPatchSchema = maintenanceRecordWriteSchema
  .partial()
  .extend({ updatedAt: epochMsSchema });
export type MaintenanceRecordPatch = z.infer<typeof maintenanceRecordPatchSchema>;

export const maintenanceRecordSortSchema = z.enum(["updatedAt", "createdAt", "happenedAt"]);

export const maintenanceRecordListQuerySchema = pageQuerySchema.extend({
  sort: maintenanceRecordSortSchema.optional(),
  kind: maintenanceKindSchema.optional(),
});
export type MaintenanceRecordListQuery = z.infer<typeof maintenanceRecordListQuerySchema>;
