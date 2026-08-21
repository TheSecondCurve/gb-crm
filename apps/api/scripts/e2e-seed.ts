// e2e 种子（PR 13）：重建 DATABASE_PATH 指向的库 —— bootstrap admin + 1 条客户 + 1 个 assistant 账号。
// 直接建库插入。由 e2e/run-server.sh 在起服务前调用。
import fs from "node:fs";

import { bootstrapAdmin } from "../src/db/bootstrap-admin.js";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { customers, users } from "../src/db/schema.js";
import { parseScriptEnv } from "../src/env.js";
import { hashPassword } from "../src/modules/auth/service.js";

export const E2E_ADMIN = { username: "admin", password: "admin-e2e-password" } as const;
export const E2E_ASSISTANT = { username: "assistant", password: "assistant-e2e-pass" } as const;
export const E2E_CUSTOMER_NICKNAME = "e2e种子客户";

const env = parseScriptEnv();

// 每次重建，保证冒烟用例可重复
for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(env.DATABASE_PATH + suffix, { force: true });
}

const { db, sqlite, close } = createDb(env.DATABASE_PATH);
migrateDb(sqlite);

await bootstrapAdmin(db, {
  ADMIN_USERNAME: E2E_ADMIN.username,
  ADMIN_PASSWORD: E2E_ADMIN.password,
  ADMIN_BOOTSTRAP_RESET_PASSWORD: false,
});

const now = Date.now(); // epoch 毫秒
db.insert(users)
  .values({
    username: E2E_ASSISTANT.username,
    passwordHash: await hashPassword(E2E_ASSISTANT.password),
    nickname: "小助手",
    systemRole: "assistant",
    accountStatus: "enabled",
    createdAt: now,
    updatedAt: now,
  })
  .run();

db.insert(customers)
  .values({
    nickname: E2E_CUSTOMER_NICKNAME,
    customerType: "customer",
    createdAt: now,
    updatedAt: now,
  })
  .run();

close();
console.log(`e2e seed ok: ${env.DATABASE_PATH}`);
