// e2e 种子：重建 DATABASE_PATH 指向的库 —— 三角色账号 + 客户（含 30 条分页用）+ 产品 +
// 成交 ×2（ORD-002 是分成/发放链路锚点：¥1000、税后 1、负责人 operator）+ 渠道（含密钥列）+
// 客户/资料标签 + 圈子交付类型/交付单/客户维度交付项（K44）+ 文本资料（K54）。
// 直接建库插入；常量单一来源在 ./e2e-seed-data.ts（Playwright 用例同源 import）。由 e2e/run-server.sh 起服务前调用。
import fs from "node:fs";

import { eq } from "drizzle-orm";

import { bootstrapAdmin } from "../src/db/bootstrap-admin.js";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import {
  channels,
  customerTags,
  customers,
  deals,
  deliverables,
  deliveries,
  deliveryCustomers,
  deliveryMaterialCustomers,
  deliveryMaterials,
  deliveryMaterialTags,
  deliveryTasks,
  deliveryTypes,
  products,
  systemConfigs,
  tags,
  users,
} from "../src/db/schema.js";
import { parseScriptEnv } from "../src/env.js";
import { hashPassword } from "../src/modules/auth/service.js";
import {
  E2E_ADMIN,
  E2E_ASSISTANT,
  E2E_CHANNEL_ACCOUNT_ID,
  E2E_CHANNEL_NAME,
  E2E_CUSTOMER_NICKNAME,
  E2E_CUSTOMER_NICKNAME_2,
  E2E_DEAL2_AMOUNT_YUAN,
  E2E_DEAL2_ORDER_NO,
  E2E_DEAL_ORDER_NO,
  E2E_DELIVERABLE_CONTENT,
  E2E_DELIVERY_TYPE,
  E2E_MATERIAL_TAG_NAME,
  E2E_MATERIAL_TITLE,
  E2E_OPERATOR,
  E2E_PAGINATION_COUNT,
  E2E_PAGINATION_PREFIX,
  E2E_PRODUCT_NAME,
  E2E_TAG_NAME,
} from "./e2e-seed-data.js";

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

// ── 三角色账号 ──
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
const operatorId = Number(
  db
    .insert(users)
    .values({
      username: E2E_OPERATOR.username,
      passwordHash: await hashPassword(E2E_OPERATOR.password),
      nickname: "运营姐",
      systemRole: "operator",
      accountStatus: "enabled",
      createdAt: now,
      updatedAt: now,
    })
    .run().lastInsertRowid,
);

// ── 客户：2 条锚点 + 30 条分页用 ──
const customerIds = [E2E_CUSTOMER_NICKNAME, E2E_CUSTOMER_NICKNAME_2].map((nickname) =>
  Number(
    db
      .insert(customers)
      .values({ nickname, customerType: "customer", createdAt: now, updatedAt: now })
      .run().lastInsertRowid,
  ),
);
for (let i = 1; i <= E2E_PAGINATION_COUNT; i++) {
  db.insert(customers)
    .values({
      nickname: `${E2E_PAGINATION_PREFIX}${String(i).padStart(3, "0")}`,
      customerType: "customer",
      city: "杭州",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

// ── 产品 + 成交 ×2 ──
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
    dealDate: now,
    createdAt: now,
    updatedAt: now,
  })
  .run();
db.insert(deals)
  .values({
    customerId: customerIds[0]!,
    productId,
    ownerId: operatorId,
    stage: "paid",
    orderNo: E2E_DEAL2_ORDER_NO,
    amountCents: E2E_DEAL2_AMOUNT_YUAN * 100,
    afterTaxRatio: 1,
    dealDate: now,
    createdAt: now,
    updatedAt: now,
  })
  .run();

// ── 渠道（K27 密钥列锚点）──
db.insert(channels)
  .values({
    name: E2E_CHANNEL_NAME,
    platform: "wechat",
    channelType: "private",
    accountType: "private_assistant",
    status: "operating",
    accountId: E2E_CHANNEL_ACCOUNT_ID,
    registerPhone: "13800000000",
    registrant: "e2e注册人",
    createdAt: now,
    updatedAt: now,
  })
  .run();

// ── 标签（K45 客户域 + K58 资料域）+ 客户↔标签 ──
const customerTagId = Number(
  db
    .insert(tags)
    .values({
      name: E2E_TAG_NAME,
      scope: "identity",
      domain: "customer",
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run().lastInsertRowid,
);
db.insert(tags)
  .values({
    name: E2E_MATERIAL_TAG_NAME,
    scope: "other",
    domain: "material",
    enabled: 1,
    createdAt: now,
    updatedAt: now,
  })
  .run();
db.insert(customerTags)
  .values({ customerId: customerIds[0]!, tagId: customerTagId, createdAt: now })
  .run();

// ── 交付类型（默认动作模板）+ 交付单（关联 2 客户）+ 客户维度交付项（K44）──
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

// ── 文本资料（K54）：挂圈子交付 + 客户 1 + 资料域标签 ──
const materialId = Number(
  db
    .insert(deliveryMaterials)
    .values({
      kind: "text",
      title: E2E_MATERIAL_TITLE,
      content: "e2e 咨询纪要正文：客户关注私域转化与圈子运营节奏。",
      deliveryId,
      createdAt: now,
      updatedAt: now,
    })
    .run().lastInsertRowid,
);
db.insert(deliveryMaterialCustomers)
  .values({ materialId, customerId: customerIds[0]! })
  .run();

// 资料域标签（name 取自上面 insert 的常量，id 需重查以保稳妥）
const materialTag = db.select().from(tags).where(eq(tags.name, E2E_MATERIAL_TAG_NAME)).get();
if (materialTag) {
  db.insert(deliveryMaterialTags)
    .values({ materialId, tagId: materialTag.id, createdAt: now })
    .run();
}

// ── K57 资料对象存储配置：指向 e2e/stub-s3.mjs 桩服务（run-server.sh 同进程组拉起）──
db.insert(systemConfigs)
  .values({
    code: "materialsS3",
    value: JSON.stringify({
      enabled: true,
      endpoint: "http://127.0.0.1:3102",
      region: "e2e",
      bucket: "e2e-bucket",
      prefix: "",
      accessKeyId: "e2e-access-key",
      secretAccessKey: "e2e-secret-key",
    }),
    updatedAt: now,
  })
  .run();

close();
console.log(`e2e seed ok: ${env.DATABASE_PATH}`);
