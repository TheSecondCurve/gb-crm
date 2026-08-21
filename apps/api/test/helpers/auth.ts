// auth 测试夹具：测试环境 env、快速 argon2 参数预生成 hash 的用户、loginAs 取 cookie。
// 注意：种子 hash 用降参数的 argon2id（hash 内嵌参数，verify 不受影响），保证套件速度；
// 生产 hash 参数由 service.ts 的 ARGON2_OPTIONS 钉住并单测。
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { Db } from "../../src/db/client.js";
import { users } from "../../src/db/schema.js";
import { parseAppEnv, type AppEnv } from "../../src/env.js";

export const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef";

export function testEnv(overrides: NodeJS.ProcessEnv = {}): AppEnv {
  return parseAppEnv({ SESSION_SECRET: TEST_SESSION_SECRET, ...overrides });
}

const FAST_ARGON2 = {
  type: argon2.argon2id,
  memoryCost: 1024,
  timeCost: 1,
  parallelism: 1,
} as const;

export interface SeedUserOptions {
  username?: string | null;
  password?: string | null;
  nickname?: string;
  systemRole?: string | null;
  accountStatus?: string;
  deletedAt?: number | null;
}

export async function seedUser(db: Db, options: SeedUserOptions = {}): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const password = options.password === undefined ? "password123" : options.password;
  const result = db
    .insert(users)
    .values({
      username: options.username === undefined ? "alice" : options.username,
      passwordHash: password === null ? null : await argon2.hash(password, FAST_ARGON2),
      nickname: options.nickname ?? "爱丽丝",
      systemRole: options.systemRole === undefined ? "admin" : options.systemRole,
      accountStatus: options.accountStatus ?? "enabled",
      createdAt: now,
      updatedAt: now,
      deletedAt: options.deletedAt ?? null,
    })
    .run();
  return Number(result.lastInsertRowid);
}

/** POST /login，断言 204 并返回可直接放进 Cookie 头的 `gb_crm_sid=...` 片段 */
export async function loginAs(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  if (res.statusCode !== 204) {
    throw new Error(`loginAs(${username}) failed: ${res.statusCode} ${res.body}`);
  }
  const setCookie = res.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) throw new Error("login response missing set-cookie");
  return header.split(";", 1)[0]!;
}

export function setAccountStatus(db: Db, userId: number, status: "enabled" | "disabled"): void {
  db.update(users).set({ accountStatus: status }).where(eq(users.id, userId)).run();
}
