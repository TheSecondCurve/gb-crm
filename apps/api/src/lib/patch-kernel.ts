// PATCH 内核（K24）通用实现：users/channels/products 曾各自重复一份，此处收口。
// 规则（API 章节「PATCH 内核」表）：
// - JSON 键存在 → SET（null → SET NULL 可空列；非空列传 null 由 Zod 挡 422）；键缺席 → 不动；
// - 动态 SET 仅含出现的标量键 + updated_at/updated_by bump；updatedAt 是 OCC 凭证不是数据列；
// - 关系键（ownerIds 等）不在 scalarKeys 里，由调用方在本函数返回后同事务整表替换；
// - 行级 OCC：changes===0 → 软删 404，否则 409 且 data 为当前完整行（serialize 回调，含 expansions）。
import { updateAudit, type AuditContext } from "./audit.js";
import { conflict, notFound } from "../plugins/error-handler.js";

export interface PatchKernelDeps<TRow> {
  /** 可写标量键白名单（不含 updatedAt 与关系键） */
  scalarKeys: ReadonlySet<string>;
  /** 行级 OCC UPDATE（WHERE id AND updated_at AND deleted_at IS NULL），返回受影响行数 */
  occUpdate: (set: Record<string, unknown>) => number;
  /** 读当前行（含软删），changes===0 时区分 404 与 409 */
  getRowAny: () => TRow | undefined;
  isDeleted: (row: TRow) => boolean;
  /** 409 响应 data：当前完整行（含 expansions） */
  serialize: (row: TRow) => unknown;
  notFoundMessage: string;
}

/**
 * 应用标量 PATCH：键存在才 SET + 行级 OCC。成功返回；失败抛 404 / 409。
 * 调用方负责：关系键校验与整表替换（同事务）、成功后重新 assemble 返回。
 */
export function applyScalarPatch<TRow>(
  patch: Record<string, unknown>,
  ctx: AuditContext,
  deps: PatchKernelDeps<TRow>,
): void {
  // 键存在才 SET；缺席键不动。undefined 视为缺席（Zod optional 解析产物）。
  const set: Record<string, unknown> = { ...updateAudit(ctx) };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "updatedAt" || value === undefined) continue;
    if (!deps.scalarKeys.has(key)) continue;
    set[key] = value;
  }

  const changes = deps.occUpdate(set);
  if (changes === 0) {
    const row = deps.getRowAny();
    if (!row || deps.isDeleted(row)) throw notFound(deps.notFoundMessage);
    throw conflict("数据已被他人修改，请刷新后重试", deps.serialize(row));
  }
}
