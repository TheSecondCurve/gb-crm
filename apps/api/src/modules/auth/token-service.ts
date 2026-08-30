// Agent PAT：用户名密码签发；列表/撤销不含明文。
import type { AdminTokenListQuery, TokenScope, TokenStatus } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { notFound } from "../../plugins/error-handler.js";
import { verifyLogin } from "./service.js";
import {
  generateRawToken,
  hashToken,
  insertToken,
  listAdminTokens,
  listTokensByUserId,
  revokeTokenByAdmin,
  revokeTokenByUser,
  TOKEN_TTL_MS,
  type AdminTokenRow,
} from "./token-repo.js";

export interface MintedToken {
  token: string;
  prefix: string;
  scope: TokenScope;
  name: string | null;
  expiresAt: number;
}

export interface TokenListItem {
  id: number;
  prefix: string;
  scope: TokenScope;
  name: string | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export async function mintToken(
  db: Db,
  input: { username: string; password: string; scope: TokenScope; name?: string; now: number },
): Promise<MintedToken | null> {
  const user = await verifyLogin(db, input.username, input.password);
  if (!user) return null;

  const { token, prefix } = generateRawToken(input.scope);
  const expiresAt = input.now + TOKEN_TTL_MS;
  const name = input.name ?? null;
  insertToken(db, {
    userId: user.id,
    tokenHash: hashToken(token),
    tokenPrefix: prefix,
    scope: input.scope,
    name,
    now: input.now,
    expiresAt,
  });
  return { token, prefix, scope: input.scope, name, expiresAt };
}

export function listOwnTokens(db: Db, userId: number): TokenListItem[] {
  return listTokensByUserId(db, userId).map((row) => ({
    id: row.id,
    prefix: row.tokenPrefix,
    scope: row.scope as TokenScope,
    name: row.name,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  }));
}

export function revokeOwnToken(db: Db, userId: number, id: number, now: number): void {
  if (!revokeTokenByUser(db, userId, id, now)) throw notFound("令牌不存在");
}

// ── 后台「授权管理」（K35 治理）：admin 列全部令牌 + 吊销任意令牌；DTO 不含 hash/明文 ──

export interface AdminTokenDto {
  id: number;
  prefix: string;
  name: string | null;
  scope: TokenScope;
  status: TokenStatus;
  user: { id: number; nickname: string };
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedBy: { id: number; nickname: string } | null;
}

function deriveTokenStatus(row: AdminTokenRow, now: number): TokenStatus {
  if (row.revokedAt !== null) return "revoked";
  if (now >= row.expiresAt) return "expired";
  return "active";
}

export function listAdminTokenResult(
  db: Db,
  query: AdminTokenListQuery,
  now: number,
): { data: AdminTokenDto[]; total: number } {
  const { rows, total } = listAdminTokens(db, {
    page: query.page,
    pageSize: query.pageSize,
    scope: query.scope,
    status: query.status,
    userId: query.userId,
    now,
  });
  const data = rows.map((row) => ({
    id: row.id,
    prefix: row.tokenPrefix,
    name: row.name,
    scope: row.scope as TokenScope,
    status: deriveTokenStatus(row, now),
    user: { id: row.userId, nickname: row.userNickname ?? "" },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    revokedBy:
      row.revokedBy !== null ? { id: row.revokedBy, nickname: row.revokedByNickname ?? "" } : null,
  }));
  return { data, total };
}

export function adminRevokeToken(db: Db, id: number, revokerId: number, now: number): void {
  if (!revokeTokenByAdmin(db, id, revokerId, now)) throw notFound("令牌不存在");
}
