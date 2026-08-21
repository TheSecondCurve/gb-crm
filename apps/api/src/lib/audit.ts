// 审计列工具（Data Model：所有业务表 created_at/updated_at/created_by/updated_by）。
// 时间戳一律 epoch 毫秒（now 由调用方注入，便于测试假时钟）。

export interface AuditContext {
  /** epoch 毫秒 */
  now: number;
  /** 操作人；bootstrap 等无操作人路径可为 null */
  userId: number | null;
}

/** INSERT 时四列全填 */
export function createAudit(ctx: AuditContext) {
  return {
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
}

/** UPDATE / PATCH 时 bump updated_at / updated_by */
export function updateAudit(ctx: AuditContext) {
  return {
    updatedAt: ctx.now,
    updatedBy: ctx.userId,
  };
}
