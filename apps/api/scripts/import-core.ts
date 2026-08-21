// 飞书导入共享核心（设计 §11 / K16 / Appendix A）：
// - 输入是与来源无关的 FeishuDump（飞书 API 或 CSV 回退都归一成这个结构）；
//   fields 以「字段中文名」为键（摘录没有 fld*，禁止编造 field id）。
// - 两遍扫描：第一遍 INSERT/UPSERT 四张主表（写 feishu_record_id，不写关系）；
//   第二遍按 link（record id）填五张 join + customer_tags + parent_id。
// - 枚举中文 → code 用 shared 反向映射；未知非空 select → 该字段回 DEFAULT、行仍插入、warn+1。
// - INSERT users 登录字段固定：username/password_hash/system_role=NULL、account_status='disabled'；
//   UPSERT 只列业务列，绝不 SET 这四个登录列；目标行软删则 deleted_at=NULL 复活。
// - UPSERT 带 partial unique 谓词 ON CONFLICT (feishu_record_id) WHERE feishu_record_id IS NOT NULL。
// - 无 record id 的行 skipped（无法幂等 UPSERT）；找不到的 link warn 不失败整次。
import type Database from "better-sqlite3";

import {
  accountTypeFromFeishu,
  channelStatusFromFeishu,
  channelTypeFromFeishu,
  customerTypeFromFeishu,
  employmentStatusFromFeishu,
  jobTitleFromFeishu,
  platformFromFeishu,
  productStatusFromFeishu,
  productTypeFromFeishu,
  tagFromFeishu,
  type AccountType,
  type ChannelStatus,
  type ChannelType,
  type CustomerType,
  type Platform,
  type ProductStatus,
  type ProductType,
  type Tag,
} from "@gb-crm/shared";

// ---------------------------------------------------------------------------
// Dump 结构（来源无关）

export interface FeishuRecord {
  recordId: string;
  /** 键 = 飞书字段中文名；值允许 string / number / 飞书 API 的复合结构 */
  fields: Record<string, unknown>;
}

export interface FeishuDump {
  users: FeishuRecord[];
  channels: FeishuRecord[];
  products: FeishuRecord[];
  customers: FeishuRecord[];
}

// ---------------------------------------------------------------------------
// 值归一化：同时吃飞书 API 复合结构与 CSV 纯字符串

/** 文本：string 原样；飞书 text 段数组 [{text,...}] 拼接；{text}/{link} 取文本；空 → null */
export function textValue(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? null : s;
  }
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    const s = v
      .map((seg) =>
        typeof seg === "string"
          ? seg
          : typeof (seg as { text?: unknown })?.text === "string"
            ? ((seg as { text: string }).text as string)
            : "",
      )
      .join("")
      .trim();
    return s === "" ? null : s;
  }
  if (typeof v === "object") {
    const obj = v as { text?: unknown; link?: unknown };
    if (typeof obj.text === "string") return obj.text.trim() || null;
    if (typeof obj.link === "string") return obj.link.trim() || null;
  }
  return null;
}

/** 数字：number 原样；数字字符串解析；非数 → null（价格 NULL 的依据） */
export function numberValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = textValue(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 日期时间：飞书给 epoch ms；CSV 给 epoch ms 数字字符串 */
export function dateValue(v: unknown): number | null {
  return numberValue(v);
}

/** select：单值文本 */
export function selectValue(v: unknown): string | null {
  return textValue(v);
}

/**
 * multi-select / link：
 * - 飞书 multi：string[]；link：record id 的 string[]（或 [{record_id}] / {record_ids:[]}）
 * - CSV 回退：单元格内以「;」分隔多个值
 */
export function listValue(v: unknown): string[] {
  if (v == null) return [];
  if (typeof v === "string") {
    return v
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      if (typeof item === "string") {
        if (item.trim() !== "") out.push(item.trim());
      } else if (item && typeof item === "object") {
        const obj = item as { record_id?: unknown; recordId?: unknown; id?: unknown };
        const id = obj.record_id ?? obj.recordId;
        if (typeof id === "string" && id !== "") out.push(id);
      }
    }
    return out;
  }
  if (typeof v === "object") {
    const ids = (v as { record_ids?: unknown }).record_ids;
    if (Array.isArray(ids)) return listValue(ids);
  }
  return [];
}

/** user 字段：飞书 [{id,...}] 取第一个 user id；CSV 字符串原样；失败 → null */
export function userIdValue(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === "object") {
        const id = (item as { id?: unknown }).id;
        if (typeof id === "string" && id !== "") return id;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 报告

export interface TableReport {
  inserted: number;
  updated: number;
  skipped: number;
  /** warn 计数（未知枚举 / 找不到的 link / 环 / 深度 / 缺 record id 等） */
  warn: number;
  messages: string[];
}

export interface RelationReport {
  /** 实际新增的 join 行数（INSERT OR IGNORE 命中的不算） */
  joinsInserted: number;
  parentsSet: number;
  warn: number;
  messages: string[];
}

export interface ImportReport {
  users: TableReport;
  channels: TableReport;
  products: TableReport;
  customers: TableReport;
  relations: RelationReport;
}

function newTableReport(): TableReport {
  return { inserted: 0, updated: 0, skipped: 0, warn: 0, messages: [] };
}

function warn(report: TableReport | RelationReport, message: string): void {
  report.warn += 1;
  report.messages.push(message);
}

// ---------------------------------------------------------------------------
// 第一遍：四张主表 INSERT/UPSERT

type Sqlite = Database.Database;

/** 枚举中文 → code；空 → 默认（不 warn）；未知非空 → 默认 + warn */
function mapEnum<T extends string>(
  raw: string | null,
  table: Record<string, T>,
  fallback: T,
  report: TableReport,
  ctx: string,
): T {
  if (raw === null) return fallback;
  const hit = table[raw];
  if (hit !== undefined) return hit;
  warn(report, `${ctx}: 未知枚举「${raw}」，字段回默认 ${fallback}`);
  return fallback;
}

interface UpsertArgs {
  table: string;
  label: string;
  record: FeishuRecord;
  /** INSERT 的业务列（不含 created_at/updated_at；登录列由 SQL 字面量固定） */
  insertColumns: string[];
  /** DO UPDATE 的业务列（禁止含 username/password_hash/system_role/account_status） */
  updateColumns: string[];
  /** 命名参数（键 = insertColumns 去掉 feishu_record_id 后的 camelCase 占位名） */
  params: Record<string, string | number | null>;
  report: TableReport;
  now: number;
}

function upsertMainRow(sqlite: Sqlite, args: UpsertArgs): void {
  const { table, label, record, insertColumns, updateColumns, params, report, now } = args;
  if (!record.recordId) {
    report.skipped += 1;
    warn(report, `${label}: 缺少 record id，跳过（无法幂等 UPSERT）`);
    return;
  }
  const insertCols = ["feishu_record_id", ...insertColumns];
  const allParams: Record<string, unknown> = { feishu_record_id: record.recordId, ...params, now };
  const sql = `
    INSERT INTO ${table} (${insertCols.join(", ")}, created_at, updated_at)
    VALUES (${insertCols.map((c) => `@${c}`).join(", ")}, @now, @now)
    ON CONFLICT (feishu_record_id) WHERE feishu_record_id IS NOT NULL
    DO UPDATE SET
      ${updateColumns.map((c) => `${c} = excluded.${c}`).join(", ")},
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `;
  const exists = sqlite
    .prepare(`SELECT 1 AS x FROM ${table} WHERE feishu_record_id = ?`)
    .get(record.recordId);
  sqlite.prepare(sql).run(allParams);
  if (exists) report.updated += 1;
  else report.inserted += 1;
}

// users 的 INSERT 需要额外固定登录列字面量（K16：username/password_hash/system_role=NULL、
// account_status='disabled'），且 UPDATE 禁止 SET 这四列，所以 users 不走通用 upsertMainRow。
function importUsersPass1(sqlite: Sqlite, records: FeishuRecord[], report: TableReport, now: number): void {
  const sql = `
    INSERT INTO users (
      feishu_record_id, nickname, real_name, phone, wechat,
      job_title, employment_status, duties, notes, feishu_user_id,
      username, password_hash, system_role, account_status,
      created_at, updated_at
    ) VALUES (
      @feishu_record_id, @nickname, @real_name, @phone, @wechat,
      @job_title, @employment_status, @duties, @notes, @feishu_user_id,
      NULL, NULL, NULL, 'disabled',
      @now, @now
    )
    ON CONFLICT (feishu_record_id) WHERE feishu_record_id IS NOT NULL
    DO UPDATE SET
      nickname = excluded.nickname,
      real_name = excluded.real_name,
      phone = excluded.phone,
      wechat = excluded.wechat,
      job_title = excluded.job_title,
      employment_status = excluded.employment_status,
      duties = excluded.duties,
      notes = excluded.notes,
      feishu_user_id = excluded.feishu_user_id,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `;
  const stmt = sqlite.prepare(sql);
  const existsStmt = sqlite.prepare("SELECT 1 AS x FROM users WHERE feishu_record_id = ?");
  for (const record of records) {
    if (!record.recordId) {
      report.skipped += 1;
      warn(report, "users: 缺少 record id，跳过（无法幂等 UPSERT）");
      continue;
    }
    const f = record.fields;
    const ctx = `users ${record.recordId}`;
    const jobTitle = mapEnum(selectValue(f["角色"]), jobTitleFromFeishu, "other", report, `${ctx} 角色`);
    const employmentStatus = mapEnum(
      selectValue(f["状态"]),
      employmentStatusFromFeishu,
      "employed",
      report,
      `${ctx} 状态`,
    );
    const exists = existsStmt.get(record.recordId);
    stmt.run({
      feishu_record_id: record.recordId,
      nickname: textValue(f["昵称"]) ?? "未命名成员",
      real_name: textValue(f["真实姓名"]),
      phone: textValue(f["电话"]),
      wechat: textValue(f["个人微信"]),
      job_title: jobTitle,
      employment_status: employmentStatus,
      duties: textValue(f["职责描述"]),
      notes: textValue(f["其他备注"]),
      feishu_user_id: userIdValue(f["飞书用户"]),
      now,
    });
    if (exists) report.updated += 1;
    else report.inserted += 1;
  }
}

function importChannelsPass1(sqlite: Sqlite, records: FeishuRecord[], report: TableReport, now: number): void {
  const columns = [
    "name",
    "description",
    "account_id",
    "register_phone",
    "registrant",
    "real_name_person",
    "login_device",
    "notes",
    "platform",
    "channel_type",
    "account_type",
    "status",
    "follower_count",
  ];
  for (const record of records) {
    const f = record.fields;
    const ctx = `channels ${record.recordId}`;
    upsertMainRow(sqlite, {
      table: "channels",
      label: "channels",
      record,
      insertColumns: columns,
      updateColumns: columns,
      params: {
        name: textValue(f["渠道名称"]) ?? "未命名渠道",
        description: textValue(f["渠道说明"]),
        account_id: textValue(f["账号ID"]),
        register_phone: textValue(f["注册手机号"]),
        registrant: textValue(f["注册人"]),
        real_name_person: textValue(f["实名认证人"]),
        login_device: textValue(f["登录设备"]),
        notes: textValue(f["备注"]),
        platform: mapEnum(selectValue(f["平台"]), platformFromFeishu, "other", report, `${ctx} 平台`) as Platform,
        channel_type: mapEnum(
          selectValue(f["渠道类型"]),
          channelTypeFromFeishu,
          "private",
          report,
          `${ctx} 渠道类型`,
        ) as ChannelType,
        account_type: mapEnum(
          selectValue(f["账号类型"]),
          accountTypeFromFeishu,
          "public_account",
          report,
          `${ctx} 账号类型`,
        ) as AccountType,
        status: mapEnum(
          selectValue(f["状态"]),
          channelStatusFromFeishu,
          "operating",
          report,
          `${ctx} 状态`,
        ) as ChannelStatus,
        follower_count: numberValue(f["粉丝/好友数"]),
      },
      report,
      now,
    });
  }
}

function importProductsPass1(sqlite: Sqlite, records: FeishuRecord[], report: TableReport, now: number): void {
  const columns = [
    "name",
    "notes",
    "sop_url",
    "package_includes",
    "delivery_cycle",
    "product_type",
    "is_package",
    "status",
    "price_cents",
    "feishu_created_date",
  ];
  const isPackageFromFeishu: Record<string, number> = { 否: 0, 是: 1 };
  for (const record of records) {
    const f = record.fields;
    const ctx = `products ${record.recordId}`;
    const rawIsPackage = selectValue(f["是否套餐"]);
    let isPackage = 0;
    if (rawIsPackage !== null) {
      const hit = isPackageFromFeishu[rawIsPackage];
      if (hit !== undefined) isPackage = hit;
      else warn(report, `${ctx} 是否套餐: 未知枚举「${rawIsPackage}」，字段回默认 0`);
    }
    const yuan = numberValue(f["价格"]);
    upsertMainRow(sqlite, {
      table: "products",
      label: "products",
      record,
      insertColumns: columns,
      updateColumns: columns,
      params: {
        name: textValue(f["产品名称"]) ?? "未命名产品",
        notes: textValue(f["备注"]),
        sop_url: textValue(f["SOP链接"]),
        package_includes: textValue(f["套餐包含"]),
        delivery_cycle: textValue(f["交付周期"]),
        product_type: mapEnum(
          selectValue(f["产品类型"]),
          productTypeFromFeishu,
          "c_consulting",
          report,
          `${ctx} 产品类型`,
        ) as ProductType,
        is_package: isPackage,
        status: mapEnum(
          selectValue(f["状态"]),
          productStatusFromFeishu,
          "on_sale",
          report,
          `${ctx} 状态`,
        ) as ProductStatus,
        // K13：yuan * 100 必须 round；非数 → NULL
        price_cents: yuan === null ? null : Math.round(yuan * 100),
        feishu_created_date: dateValue(f["创建日期"]),
      },
      report,
      now,
    });
  }
}

function importCustomersPass1(sqlite: Sqlite, records: FeishuRecord[], report: TableReport, now: number): void {
  const columns = [
    "nickname",
    "real_name",
    "title",
    "phone",
    "wechat",
    "other_social",
    "wechat_channels_account",
    "xiaoyuzhou_account",
    "xiaohongshu_account",
    "weibo_account",
    "douyin_account",
    "country",
    "city",
    "origin_story",
    "notes",
    "profile_url",
    "customer_type",
    "last_followed_at",
    "feishu_created_date",
  ];
  for (const record of records) {
    const f = record.fields;
    const ctx = `customers ${record.recordId}`;
    upsertMainRow(sqlite, {
      table: "customers",
      label: "customers",
      record,
      // parent_id 与五张 join 属于关系，第二遍才写；wechat_openid 本系统自管，INSERT 默认 NULL。
      insertColumns: columns,
      updateColumns: columns,
      params: {
        nickname: textValue(f["客户昵称"]) ?? "未命名客户",
        real_name: textValue(f["真实姓名"]),
        title: textValue(f["用户称谓 Title"]),
        phone: textValue(f["手机号"]),
        wechat: textValue(f["微信号"]),
        other_social: textValue(f["其他社交账号"]),
        wechat_channels_account: textValue(f["视频号账号"]),
        xiaoyuzhou_account: textValue(f["小宇宙账号"]),
        xiaohongshu_account: textValue(f["小红书账号"]),
        weibo_account: textValue(f["微博账号"]),
        douyin_account: textValue(f["抖音账号"]),
        country: textValue(f["国家"]),
        city: textValue(f["城市"]),
        origin_story: textValue(f["3句话元故事"]),
        notes: textValue(f["备注"]),
        profile_url: textValue(f["档案页"]),
        customer_type: mapEnum(
          selectValue(f["客户类型"]),
          customerTypeFromFeishu,
          "customer",
          report,
          `${ctx} 客户类型`,
        ) as CustomerType,
        last_followed_at: dateValue(f["最近跟进时间"]),
        feishu_created_date: dateValue(f["创建日期"]),
      },
      report,
      now,
    });
  }
}

// ---------------------------------------------------------------------------
// 第二遍：五张 join + customer_tags + parent_id

function recordIdMap(sqlite: Sqlite, table: string): Map<string, number> {
  const rows = sqlite
    .prepare(`SELECT id, feishu_record_id FROM ${table} WHERE feishu_record_id IS NOT NULL`)
    .all() as { id: number; feishu_record_id: string }[];
  return new Map(rows.map((r) => [r.feishu_record_id, r.id]));
}

interface JoinSpec {
  table: string;
  leftColumn: string;
  rightColumn: string;
}

function insertJoin(
  sqlite: Sqlite,
  spec: JoinSpec,
  leftId: number,
  rightId: number,
  report: RelationReport,
): void {
  const result = sqlite
    .prepare(
      `INSERT OR IGNORE INTO ${spec.table} (${spec.leftColumn}, ${spec.rightColumn}) VALUES (?, ?)`,
    )
    .run(leftId, rightId);
  report.joinsInserted += Number(result.changes);
}

/** 解析 link 目标；找不到 → warn 并返回 null（不失败整次） */
function resolveLink(
  map: Map<string, number>,
  feishuId: string,
  report: RelationReport,
  ctx: string,
): number | null {
  const id = map.get(feishuId);
  if (id === undefined) {
    warn(report, `${ctx}: 找不到 link 目标 ${feishuId}，跳过该关系`);
    return null;
  }
  return id;
}

function importPass2(sqlite: Sqlite, dump: FeishuDump, report: RelationReport): void {
  const userIds = recordIdMap(sqlite, "users");
  const channelIds = recordIdMap(sqlite, "channels");
  const customerIds = recordIdMap(sqlite, "customers");

  // --- 成员侧 link（A.1）：负责的渠道 → channel_owners；负责的客户 + 客户名单（去重）→ customer_owners
  for (const record of dump.users) {
    const userId = userIds.get(record.recordId);
    if (userId === undefined) continue;
    const ctx = `users ${record.recordId}`;
    for (const channelFeishuId of listValue(record.fields["负责的渠道"])) {
      const channelId = resolveLink(channelIds, channelFeishuId, report, `${ctx} 负责的渠道`);
      if (channelId !== null) {
        insertJoin(
          sqlite,
          { table: "channel_owners", leftColumn: "channel_id", rightColumn: "user_id" },
          channelId,
          userId,
          report,
        );
      }
    }
    // 「负责的客户」与「客户名单」可能重叠，合并去重（A.1）
    const customerLinks = [
      ...new Set([...listValue(record.fields["负责的客户"]), ...listValue(record.fields["客户名单"])]),
    ];
    for (const customerFeishuId of customerLinks) {
      const customerId = resolveLink(customerIds, customerFeishuId, report, `${ctx} 负责的客户`);
      if (customerId !== null) {
        insertJoin(
          sqlite,
          { table: "customer_owners", leftColumn: "customer_id", rightColumn: "user_id" },
          customerId,
          userId,
          report,
        );
      }
    }
  }

  // --- 渠道侧 link（A.2）：负责人 → channel_owners（与成员侧 INSERT OR IGNORE 去重）
  for (const record of dump.channels) {
    const channelId = channelIds.get(record.recordId);
    if (channelId === undefined) continue;
    const ctx = `channels ${record.recordId}`;
    for (const userFeishuId of listValue(record.fields["负责人"])) {
      const userId = resolveLink(userIds, userFeishuId, report, `${ctx} 负责人`);
      if (userId !== null) {
        insertJoin(
          sqlite,
          { table: "channel_owners", leftColumn: "channel_id", rightColumn: "user_id" },
          channelId,
          userId,
          report,
        );
      }
    }
  }

  // --- 客户侧 link（A.4）：标签 + 三张 join + 归属/升单
  const insertTag = sqlite.prepare(
    "INSERT OR IGNORE INTO customer_tags (customer_id, tag) VALUES (?, ?)",
  );
  for (const record of dump.customers) {
    const customerId = customerIds.get(record.recordId);
    if (customerId === undefined) continue;
    const ctx = `customers ${record.recordId}`;

    for (const rawTag of listValue(record.fields["客户标签"])) {
      const tag: Tag | undefined = tagFromFeishu[rawTag];
      if (tag === undefined) {
        warn(report, `${ctx} 客户标签: 未知枚举「${rawTag}」，跳过该标签`);
        continue;
      }
      report.joinsInserted += Number(insertTag.run(customerId, tag).changes);
    }

    const joinFields: { field: string; spec: JoinSpec; map: Map<string, number> }[] = [
      {
        field: "所在社群",
        spec: { table: "customer_community_channels", leftColumn: "customer_id", rightColumn: "channel_id" },
        map: channelIds,
      },
      {
        field: "来源渠道",
        spec: { table: "customer_source_channels", leftColumn: "customer_id", rightColumn: "channel_id" },
        map: channelIds,
      },
      {
        field: "归属人",
        spec: { table: "customer_owners", leftColumn: "customer_id", rightColumn: "user_id" },
        map: userIds,
      },
      {
        field: "升单人",
        spec: { table: "customer_upsell_owners", leftColumn: "customer_id", rightColumn: "user_id" },
        map: userIds,
      },
    ];
    for (const { field, spec, map } of joinFields) {
      for (const targetFeishuId of listValue(record.fields[field])) {
        const targetId = resolveLink(map, targetFeishuId, report, `${ctx} ${field}`);
        if (targetId !== null) insertJoin(sqlite, spec, customerId, targetId, report);
      }
    }
  }

  // --- parent_id（K15，与服务层同规则：自指/环/深度>2 一律 skip+warn）
  const getRow = sqlite.prepare("SELECT id, parent_id FROM customers WHERE id = ?");
  const hasLiveChildren = sqlite.prepare(
    "SELECT 1 AS x FROM customers WHERE parent_id = ? AND deleted_at IS NULL LIMIT 1",
  );
  const setParent = sqlite.prepare("UPDATE customers SET parent_id = ? WHERE id = ?");
  for (const record of dump.customers) {
    const links = listValue(record.fields["父记录"]);
    if (links.length === 0) continue;
    const selfId = customerIds.get(record.recordId);
    if (selfId === undefined) continue;
    const ctx = `customers ${record.recordId} 父记录`;
    const parentFeishuId = links[0]!;
    const parentId = customerIds.get(parentFeishuId);
    if (parentId === undefined) {
      warn(report, `${ctx}: 找不到 link 目标 ${parentFeishuId}，跳过该关系`);
      continue;
    }
    if (parentId === selfId) {
      warn(report, `${ctx}: 不允许自指，跳过`);
      continue;
    }
    const parentRow = getRow.get(parentId) as { id: number; parent_id: number | null };
    if (parentRow.parent_id === selfId) {
      warn(report, `${ctx}: 会形成父子环，跳过`);
      continue;
    }
    if (parentRow.parent_id !== null) {
      warn(report, `${ctx}: 层级最多两层（企业 → 下属），新父自身已有父，跳过`);
      continue;
    }
    if (hasLiveChildren.get(selfId)) {
      warn(report, `${ctx}: 层级最多两层（企业 → 下属），自身已有下属，跳过`);
      continue;
    }
    setParent.run(parentId, selfId);
    report.parentsSet += 1;
  }
}

// ---------------------------------------------------------------------------
// 入口

/** 两遍扫描导入；整体一个事务，失败回滚不落地半份数据。 */
export function importDump(sqlite: Sqlite, dump: FeishuDump): ImportReport {
  const report: ImportReport = {
    users: newTableReport(),
    channels: newTableReport(),
    products: newTableReport(),
    customers: newTableReport(),
    relations: { joinsInserted: 0, parentsSet: 0, warn: 0, messages: [] },
  };
  const now = Date.now(); // epoch 毫秒（全库统一单位）
  sqlite.transaction(() => {
    importUsersPass1(sqlite, dump.users, report.users, now);
    importChannelsPass1(sqlite, dump.channels, report.channels, now);
    importProductsPass1(sqlite, dump.products, report.products, now);
    importCustomersPass1(sqlite, dump.customers, report.customers, now);
    importPass2(sqlite, dump, report.relations);
  })();
  return report;
}

export function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  const tableLine = (label: string, r: TableReport) =>
    `  ${label.padEnd(10)} inserted=${r.inserted} updated=${r.updated} skipped=${r.skipped} warn=${r.warn}`;
  lines.push("import report:");
  lines.push(tableLine("users", report.users));
  lines.push(tableLine("channels", report.channels));
  lines.push(tableLine("products", report.products));
  lines.push(tableLine("customers", report.customers));
  lines.push(
    `  relations  joins=${report.relations.joinsInserted} parents=${report.relations.parentsSet} warn=${report.relations.warn}`,
  );
  const allMessages = [
    ...report.users.messages,
    ...report.channels.messages,
    ...report.products.messages,
    ...report.customers.messages,
    ...report.relations.messages,
  ];
  if (allMessages.length > 0) {
    lines.push("warnings:");
    for (const m of allMessages) lines.push(`  - ${m}`);
  }
  return lines.join("\n");
}
