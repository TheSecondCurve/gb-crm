// Drizzle schema 与 drizzle/ 迁移最终态一一对应（camelCase 属性 ↔ snake_case 列；
// 0000_init.sql 为历史迁移，0002 起删除了客户表部分字段，本文件以最终态为准）。
// Migration 以手写 SQL 为准（设计要求）；本文件的 CHECK / partial unique 用于类型与 drizzle-kit 对齐，
// 若 drizzle-kit 生成结果与迁移 SQL 有出入，以手写 SQL 为准并人工对齐本文件。
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username"),
    passwordHash: text("password_hash"),
    nickname: text("nickname").notNull(),
    realName: text("real_name"),
    phone: text("phone"),
    wechat: text("wechat"),
    jobTitle: text("job_title").notNull().default("other"),
    systemRole: text("system_role"),
    employmentStatus: text("employment_status").notNull().default("employed"),
    accountStatus: text("account_status").notNull().default("disabled"),
    duties: text("duties"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: integer("created_by").references((): AnySQLiteColumn => users.id, {
      onDelete: "set null",
    }),
    updatedBy: integer("updated_by").references((): AnySQLiteColumn => users.id, {
      onDelete: "set null",
    }),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    check(
      "users_job_title_check",
      sql`"job_title" IN ('ip','partner','ops','assistant','content','other','part_time_helper','intern')`,
    ),
    check("users_system_role_check", sql`"system_role" IN ('admin','operator','assistant')`),
    check(
      "users_employment_status_check",
      sql`"employment_status" IN ('employed','handing_over','left')`,
    ),
    check("users_account_status_check", sql`"account_status" IN ('enabled','disabled')`),
    // username：live unique，软删后释放可复用
    uniqueIndex("users_username_live_uq")
      .on(t.username)
      .where(sql`"username" IS NOT NULL AND "deleted_at" IS NULL`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastTouchedAt: integer("last_touched_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    scope: text("scope").notNull(),
    name: text("name"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    check("api_tokens_scope_check", sql`"scope" IN ('read', 'write')`),
    uniqueIndex("api_tokens_token_hash_uq").on(t.tokenHash),
    index("api_tokens_user_id_idx").on(t.userId),
    index("api_tokens_expires_at_idx").on(t.expiresAt),
  ],
);

export const channels = sqliteTable(
  "channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    accountId: text("account_id"),
    registerPhone: text("register_phone"),
    registrant: text("registrant"),
    realNamePerson: text("real_name_person"),
    loginDevice: text("login_device"),
    notes: text("notes"),
    platform: text("platform").notNull().default("other"),
    channelType: text("channel_type").notNull().default("private"),
    accountType: text("account_type").notNull().default("public_account"),
    status: text("status").notNull().default("operating"),
    followerCount: integer("follower_count"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: integer("deleted_at"),
  },
  () => [
    check(
      "channels_platform_check",
      sql`"platform" IN ('wechat','weibo','xiaohongshu','douyin','xiaoyuzhou','other','bilibili','xigua','wechat_channels')`,
    ),
    check(
      "channels_channel_type_check",
      sql`"channel_type" IN ('private','public','private_assistant','public_assistant','fixed_wechat')`,
    ),
    check(
      "channels_account_type_check",
      sql`"account_type" IN ('public_account','private_assistant','fixed_wechat','wechat_group','weibo_group','xhs_group')`,
    ),
    check("channels_status_check", sql`"status" IN ('operating','paused','pending')`),
  ],
);

export const channelOwners = sqliteTable(
  "channel_owners",
  {
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] })],
);

export const products = sqliteTable(
  "products",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    notes: text("notes"),
    sopUrl: text("sop_url"),
    packageIncludes: text("package_includes"),
    deliveryCycle: text("delivery_cycle"),
    productType: text("product_type").notNull().default("c_consulting"),
    isPackage: integer("is_package").notNull().default(0),
    status: text("status").notNull().default("on_sale"),
    priceCents: integer("price_cents"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: integer("deleted_at"),
  },
  () => [
    check(
      "products_product_type_check",
      sql`"product_type" IN ('c_consulting','b_consulting','ad_coop','content_coop','knowledge','circle_sub','campaign','team_delivery')`,
    ),
    check("products_is_package_check", sql`"is_package" IN (0, 1)`),
    check("products_status_check", sql`"status" IN ('on_sale','off_sale','in_dev')`),
  ],
);

export const customers = sqliteTable(
  "customers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    nickname: text("nickname").notNull(),
    realName: text("real_name"),
    title: text("title"),
    phone: text("phone"),
    wechat: text("wechat"),
    country: text("country"),
    city: text("city"),
    originStory: text("origin_story"),
    notes: text("notes"),
    customerType: text("customer_type").notNull().default("customer"),
    wechatOpenid: text("wechat_openid"),
    lastFollowedAt: integer("last_followed_at"),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    check(
      "customers_customer_type_check",
      sql`"customer_type" IN ('guest','customer','company','invite','partner')`,
    ),
    // wechat_openid：live unique，软删后释放
    uniqueIndex("customers_wechat_openid_live_uq")
      .on(t.wechatOpenid)
      .where(sql`"wechat_openid" IS NOT NULL AND "deleted_at" IS NULL`),
    index("customers_phone_idx").on(t.phone),
    index("customers_owner_id_idx").on(t.ownerId),
  ],
);

export const customerSocialAccounts = sqliteTable(
  "customer_social_accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    account: text("account").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    check(
      "customer_social_accounts_platform_check",
      sql`"platform" IN ('wechat_channels','xiaoyuzhou','xiaohongshu','weibo','douyin','other')`,
    ),
    index("customer_social_accounts_customer_id_idx").on(t.customerId),
  ],
);

export const customerSourceChannels = sqliteTable(
  "customer_source_channels",
  {
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.channelId] })],
);

// K42 成交表：客户必填（创建）；意向产品/负责人单值可空；stage 枚举；delivery_date epoch ms。
export const deals = sqliteTable(
  "deals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id),
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: "set null" }),
    stage: text("stage").notNull().default("gift"),
    orderNo: text("order_no"),
    paymentRemark: text("payment_remark"),
    deliveryDate: integer("delivery_date"),
    amountCents: integer("amount_cents"),
    afterTaxRatio: real("after_tax_ratio"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    check("deals_stage_check", sql`"stage" IN ('gift','paid','refunded','closed')`),
    index("deals_customer_id_idx").on(t.customerId),
    index("deals_product_id_idx").on(t.productId),
    index("deals_owner_id_idx").on(t.ownerId),
    index("deals_stage_idx").on(t.stage),
  ],
);

// K44 交付类型配置表：分类 kind + 状态 status + 默认动作模板（多行文本，创建交付项时预填）。
export const deliveryTypes = sqliteTable(
  "delivery_types",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("other"),
    status: text("status").notNull().default("active"),
    description: text("description"),
    defaultTasks: text("default_tasks"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: integer("deleted_at"),
  },
  () => [
    check("delivery_types_kind_check", sql`"kind" IN ('consulting','activity','circle','other')`),
    check("delivery_types_status_check", sql`"status" IN ('active','inactive')`),
  ],
);

// K44 交付单（精简：类型 + 客户集合 + 备注 + 起止日期；与成交弱关联）
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deliveryTypeId: integer("delivery_type_id")
      .notNull()
      .references(() => deliveryTypes.id),
    startsAt: integer("starts_at"),
    endsAt: integer("ends_at"),
    remark: text("remark"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("deliveries_type_idx").on(t.deliveryTypeId)],
);

// K44 交付 × 客户 M2M（子表硬删）
export const deliveryCustomers = sqliteTable(
  "delivery_customers",
  {
    deliveryId: integer("delivery_id")
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.deliveryId, t.customerId] }),
    index("delivery_customers_customer_idx").on(t.customerId),
  ],
);

// K44 交付项：挂交付单；双维度（项目/客户）；无独立状态，打勾进度即状态；
// starts_at/ends_at 可空（项目维度甘特排期；客户维度通常不填）。
export const deliverables = sqliteTable(
  "deliverables",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deliveryId: integer("delivery_id")
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    dimension: text("dimension").notNull().default("project"),
    description: text("description"),
    deliveryUrl: text("delivery_url"),
    startsAt: integer("starts_at"),
    endsAt: integer("ends_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    check("deliverables_dimension_check", sql`"dimension" IN ('project','customer')`),
    index("deliverables_delivery_idx").on(t.deliveryId),
  ],
);

// K44 动作清单：客户维度任务按 customer_id 展开（每客户分别打勾/备注）；NULL = 项目维度；
// 子表硬删；done 翻转时服务端写 done_at / done_by。
export const deliveryTasks = sqliteTable(
  "delivery_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deliverableId: integer("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
    content: text("content").notNull(),
    done: integer("done").notNull().default(0),
    doneAt: integer("done_at"),
    doneBy: integer("done_by").references(() => users.id, { onDelete: "set null" }),
    remark: text("remark"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    check("delivery_tasks_done_check", sql`"done" IN (0, 1)`),
    index("delivery_tasks_deliverable_idx").on(t.deliverableId),
    index("delivery_tasks_customer_idx").on(t.customerId),
  ],
);
