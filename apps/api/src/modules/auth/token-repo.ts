// api_tokens CRUD。明文令牌永不落库；查找用 sha256(hex)。
import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, isNull } from "drizzle-orm";

import type { TokenScope } from "@gb-crm/shared";

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
