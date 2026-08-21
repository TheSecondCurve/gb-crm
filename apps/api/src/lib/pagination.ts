// 分页工具（§9）：page 1-based，pageSize 默认 25、上限 100。
// 边界校验由 shared 的 pageQuerySchema（Zod）完成，本模块只做纯计算。
import type { ListEnvelope } from "@gb-crm/shared";

export function toOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

export function listMeta(page: number, pageSize: number, total: number): ListEnvelope<never>["meta"] {
  return { page, pageSize, total };
}
