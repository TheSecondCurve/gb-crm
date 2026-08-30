// api_tokens CRUD。明文令牌永不落库；查找用 sha256(hex)。
import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, isNull } from "drizzle-orm";

import type { TokenScope, TokenStatus } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { apiTokens } from "../../db/schema.js";

/** 默认 90 天 */
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** last_used_at 节流，与 session touch 同档，避免每个 GET 都写库 */
export const TOKEN_TOUCH_INTERVAL_MS = 30 * 60 * 1000;

export type ApiToken = typeof apiTokens.$inferSelect;

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** `gbcrm_ro_` / `gbcrm_rw_` + 32 字节 hex；prefix = 前 17 字符（含 8 hex） */
export function generateRawToken(scope: TokenScope): { token: string; prefix: string } {
  const kind = scope === "read" ? "ro" : "rw";
  const token = `gbcrm_${kind}_${randomBytes(32).toString("hex")}`;
  return { token, prefix: token.slice(0, 17) };
}

export function insertToken(
  db: Db,
  input: {
    userId: number;
    tokenHash: string;
    tokenPrefix: string;
    scope: TokenScope;
    name: string | null;
    now: number;
    expiresAt: number;
  },
): ApiToken {
  const result = db
    .insert(apiTokens)
    .values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      tokenPrefix: input.tokenPrefix,
      scope: input.scope,
      name: input.name,
      createdAt: input.now,
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    })
    .run();
  return db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, Number(result.lastInsertRowid)))
    .get()!;
}

export function findTokenByHash(db: Db, tokenHash: string): ApiToken | undefined {
  return db.select().from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash)).get();
}

export function listTokensByUserId(db: Db, userId: number): ApiToken[] {
  return db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
    .all();
}

export function findTokenById(db: Db, id: number): ApiToken | undefined {
  return db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
}

/** 撤销自己的令牌。找不到或不属于该用户 → false；已撤销也算成功 */
export function revokeTokenByUser(db: Db, userId: number, id: number, now: number): boolean {
  const row = findTokenById(db, id);
  if (!row || row.userId !== userId) return false;
  if (row.revokedAt === null) {
    db.update(apiTokens).set({ revokedAt: now }).where(eq(apiTokens.id, id)).run();
  }
  return true;
}

export function revokeAllTokensByUserId(db: Db, userId: number, now: number): void {
  db.update(apiTokens)
    .set({ revokedAt: now })
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .run();
}

export function touchTokenLastUsed(db: Db, id: number, now: number): void {
  db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, id)).run();
}

// ── 后台「授权管理」（K35 治理）：admin 列全部令牌 + 吊销任意令牌 ──

export interface AdminTokenRow {
  id: number;
  userId: number;
  tokenPrefix: string;
  scope: string;
  name: string | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedBy: number | null;
  userNickname: string | null;
  revokedByNickname: string | null;
}

export interface AdminTokenListParams {
  page: number;
  pageSize: number;
  scope?: TokenScope;
  status?: TokenStatus;
  userId?: number;
  now: number;
}

/**
 * 列全部令牌（后台治理，含用户/吊销人昵称）。状态为派生视图：
 * active = 未吊销且未过期；revoked = 吊销过；expired = 未吊销但已过期。
 * 走原生连接（多 join + 派生状态过滤），只读。
 */
export function listAdminTokens(
  db: Db,
  p: AdminTokenListParams,
): { rows: AdminTokenRow[]; total: number } {
  const sqlite = db.$client;
  const cond: string[] = [];
  const params: unknown[] = [];
  if (p.scope !== undefined) {
    cond.push("t.scope = ?");
    params.push(p.scope);
  }
  if (p.userId !== undefined) {
    cond.push("t.user_id = ?");
    params.push(p.userId);
  }
  if (p.status === "active") {
    cond.push("t.revoked_at IS NULL AND t.expires_at > ?");
    params.push(p.now);
  } else if (p.status === "revoked") {
    cond.push("t.revoked_at IS NOT NULL");
  } else if (p.status === "expired") {
    cond.push("t.revoked_at IS NULL AND t.expires_at <= ?");
    params.push(p.now);
  }
  const where = cond.length > 0 ? `WHERE ${cond.join(" AND ")}` : "";
  const total = (
    sqlite.prepare(`SELECT COUNT(*) AS n FROM api_tokens t ${where}`).get(...params) as {
      n: number;
    }
  ).n;
  const offset = (p.page - 1) * p.pageSize;
  const rows = (
    sqlite
      .prepare(
        `SELECT
           t.id, t.user_id AS userId, t.token_prefix AS tokenPrefix, t.scope, t.name,
           t.created_at AS createdAt, t.expires_at AS expiresAt, t.last_used_at AS lastUsedAt,
           t.revoked_at AS revokedAt, t.revoked_by AS revokedBy,
           u.nickname AS userNickname, r.nickname AS revokedByNickname
         FROM api_tokens t
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN users r ON r.id = t.revoked_by
         ${where}
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, p.pageSize, offset) as unknown[]
  ) as AdminTokenRow[];
  return { rows, total };
}

/**
 * admin 吊销任意令牌：不存在 → false；已吊销 → 幂等 true（保持原 revoked_by 不变）；
 * 否则 SET revoked_at=now, revoked_by=revokerId。
 */
export function revokeTokenByAdmin(
  db: Db,
  id: number,
  revokerId: number,
  now: number,
): boolean {
  const row = findTokenById(db, id);
  if (!row) return false;
  if (row.revokedAt === null) {
    db.update(apiTokens)
      .set({ revokedAt: now, revokedBy: revokerId })
      .where(eq(apiTokens.id, id))
      .run();
  }
  return true;
}
