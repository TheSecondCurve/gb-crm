// e2e 种子（PR 13）：重建 DATABASE_PATH 指向的库 —— bootstrap admin + assistant + 2 客户
// + 产品 + 成交（K42）+ 交付类型/交付单/客户维度交付项（K44）。直接建库插入。由 e2e/run-server.sh 起服务前调用。
import fs from "node:fs";

import { bootstrapAdmin } from "../src/db/bootstrap-admin.js";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import {
  customers,
  deals,
  deliverables,
  deliveries,
  deliveryCustomers,
  deliveryTasks,
  deliveryTypes,
  products,
  users,
} from "../src/db/schema.js";
import { parseScriptEnv } from "../src/env.js";
import { hashPassword } from "../src/modules/auth/service.js";

export const E2E_ADMIN = { username: "admin", password: "admin-e2e-password" } as const;
export const E2E_ASSISTANT = { username: "assistant", password: "assistant-e2e-pass" } as const;
export const E2E_CUSTOMER_NICKNAME = "e2e种子客户";
export const E2E_PRODUCT_NAME = "e2e种子产品";
export const E2E_DEAL_ORDER_NO = "E2E-ORD-001";
export const E2E_DELIVERY_TYPE = "e2e圈子交付";
export const E2E_DELIVERABLE_CONTENT = "e2e拉群";

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

const customerIds = [E2E_CUSTOMER_NICKNAME, "e2e种子客户二"].map((nickname) =>
  Number(
    db
      .insert(customers)
      .values({ nickname, customerType: "customer", createdAt: now, updatedAt: now })
      .run().lastInsertRowid,
  ),
);
const productId = Number(
  db.insert(products).values({ name: E2E_PRODUCT_NAME, createdAt: now, updatedAt: now }).run()
    .lastInsertRowid,
);
db.insert(deals)
  .values({
    customerId: customerIds[0]!,
    productId,
    stage: "paid",
    orderNo: E2E_DEAL_ORDER_NO,
    paymentRemark: "e2e 成交备注",
    createdAt: now,
    updatedAt: now,
  })
  .run();

// 交付类型（默认动作模板）+ 交付单（关联 2 客户）+ 客户维度交付项（K44）
const typeId = Number(
  db
    .insert(deliveryTypes)
    .values({
      name: E2E_DELIVERY_TYPE,
      kind: "circle", // 圈子类：详情/列表提供「圈子工作台」入口
      description: "e2e 圈子全年交付",
      defaultTasks: "拉群\n商品发货",
      createdAt: now,
      updatedAt: now,
    })
    .run().lastInsertRowid,
);
const deliveryId = Number(
  db
    .insert(deliveries)
    .values({ deliveryTypeId: typeId, remark: "e2e 交付备注", createdAt: now, updatedAt: now })
    .run().lastInsertRowid,
);
for (const customerId of customerIds) {
  db.insert(deliveryCustomers).values({ deliveryId, customerId }).run();
}
// 客户维度交付项：每客户一组模板任务；客户 1 的「拉群」已打勾
const itemId = Number(
  db
    .insert(deliverables)
    .values({
      deliveryId,
      content: E2E_DELIVERABLE_CONTENT,
      dimension: "customer",
      createdAt: now,
      updatedAt: now,
    })
    .run().lastInsertRowid,
);
for (const [i, customerId] of customerIds.entries()) {
  db.insert(deliveryTasks)
    .values({
      deliverableId: itemId,
      customerId,
      content: "拉群",
      done: i === 0 ? 1 : 0,
      doneAt: i === 0 ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(deliveryTasks)
    .values({
      deliverableId: itemId,
      customerId,
      content: "商品发货",
      done: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

close();
console.log(`e2e seed ok: ${env.DATABASE_PATH}`);
