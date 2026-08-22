// e2e 种子（PR 13）：重建 DATABASE_PATH 指向的库 —— bootstrap admin + 1 条客户 + 1 个 assistant 账号
// + 1 个产品（含默认动作模板）+ 1 条成交（K42）+ 1 条交付项（K43）。直接建库插入。由 e2e/run-server.sh 起服务前调用。
import fs from "node:fs";

import { bootstrapAdmin } from "../src/db/bootstrap-admin.js";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { customers, deals, deliverables, deliveryTasks, products, users } from "../src/db/schema.js";
import { parseScriptEnv } from "../src/env.js";
import { hashPassword } from "../src/modules/auth/service.js";

export const E2E_ADMIN = { username: "admin", password: "admin-e2e-password" } as const;
export const E2E_ASSISTANT = { username: "assistant", password: "assistant-e2e-pass" } as const;
export const E2E_CUSTOMER_NICKNAME = "e2e种子客户";
export const E2E_PRODUCT_NAME = "e2e种子产品";
export const E2E_DEAL_ORDER_NO = "E2E-ORD-001";

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

const customerId = Number(
  db
    .insert(customers)
    .values({
      nickname: E2E_CUSTOMER_NICKNAME,
      customerType: "customer",
      createdAt: now,
      updatedAt: now,
    })
    .run().lastInsertRowid,
);
const productId = Number(
  db
    .insert(products)
    .values({
      name: E2E_PRODUCT_NAME,
      defaultTasks: "拉群\n商品发货",
      createdAt: now,
      updatedAt: now,
    })
    .run().lastInsertRowid,
);
const dealId = Number(
  db
    .insert(deals)
    .values({
      customerId,
      productId,
      stage: "paid",
      orderNo: E2E_DEAL_ORDER_NO,
      paymentRemark: "e2e 成交备注",
      createdAt: now,
      updatedAt: now,
    })
    .run().lastInsertRowid,
);

// 交付项（K43）：动作清单预填 2 条（1 条已打勾 → 页面进度 1/2）
const deliverableId = Number(
  db
    .insert(deliverables)
    .values({
      dealId,
      productId,
      status: "delivering",
      createdAt: now,
      updatedAt: now,
    })
    .run().lastInsertRowid,
);
db.insert(deliveryTasks)
  .values({
    deliverableId,
    content: "拉群",
    done: 1,
    doneAt: now,
    createdAt: now,
    updatedAt: now,
  })
  .run();
db.insert(deliveryTasks)
  .values({
    deliverableId,
    content: "商品发货",
    done: 0,
    createdAt: now,
    updatedAt: now,
  })
  .run();

close();
console.log(`e2e seed ok: ${env.DATABASE_PATH}`);
