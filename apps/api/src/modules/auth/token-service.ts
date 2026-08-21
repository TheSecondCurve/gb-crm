// Agent PAT：用户名密码签发；列表/撤销不含明文。
import type { TokenScope } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { notFound } from "../../plugins/error-handler.js";
import { verifyLogin } from "./service.js";
import {
  generateRawToken,
  hashToken,
  insertToken,
  listTokensByUserId,
  revokeTokenByUser,
  TOKEN_TTL_MS,
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
