import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateDb } from "../src/db/migrate.js";
import { users } from "../src/db/schema.js";
import { createTmpDb, type TmpDb } from "./helpers/tmp-db.js";

let tmp: TmpDb;

beforeEach(() => {
  tmp = createTmpDb();
});

afterEach(() => {
  tmp.cleanup();
});

describe("migration", () => {
  it("is idempotent: running twice does not error and applies nothing the second time", () => {
    const second = migrateDb(tmp.sqlite);
    expect(second).toEqual([]);

    const tables = tmp.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      "__migrations",
      "api_tokens",
      "channel_owners",
      "channels",
      "customer_owners",
      "customer_source_channels",
      "customer_tags",
      "customers",
      "products",
      "sessions",
      "sqlite_sequence",
      "users",
    ]);
  });
});

describe("connection", () => {
  it("applies PRAGMA journal_mode=WAL and foreign_keys=ON", () => {
    const journal = tmp.sqlite.pragma("journal_mode", { simple: true });
    expect(String(journal).toLowerCase()).toBe("wal");
    expect(tmp.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(tmp.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(String(tmp.sqlite.pragma("synchronous", { simple: true }))).toBe("1"); // NORMAL
  });

  it("chmod 600 on the sqlite file", () => {
    const mode = fs.statSync(tmp.dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("CHECK constraints", () => {
  it("rejects an invalid system_role", () => {
    expect(() =>
      tmp.sqlite
        .prepare(
          "INSERT INTO users (nickname, system_role, created_at, updated_at) VALUES (?, ?, 1, 1)",
        )
        .run("x", "superadmin"),
    ).toThrowError(/CHECK/i);
  });

  it("rejects an invalid customer_type", () => {
    expect(() =>
      tmp.sqlite
        .prepare(
          "INSERT INTO customers (nickname, customer_type, created_at, updated_at) VALUES (?, ?, 1, 1)",
        )
        .run("x", "vip_customer"),
    ).toThrowError(/CHECK/i);
  });

  it("rejects an invalid api_tokens.scope", () => {
    tmp.sqlite
      .prepare("INSERT INTO users (nickname, created_at, updated_at) VALUES (?, 1, 1)")
      .run("u");
    expect(() =>
      tmp.sqlite
        .prepare(
          "INSERT INTO api_tokens (user_id, token_hash, token_prefix, scope, created_at, expires_at) VALUES (1, 'h', 'gbcrm_ro_abcd1234', 'admin', 1, 2)",
        )
        .run(),
    ).toThrowError(/CHECK/i);
  });

  it("rejects an invalid customer_tags.tag", () => {
    tmp.sqlite
      .prepare("INSERT INTO customers (nickname, created_at, updated_at) VALUES (?, 1, 1)")
      .run("c");
    expect(() =>
      tmp.sqlite.prepare("INSERT INTO customer_tags (customer_id, tag) VALUES (1, ?)").run("nope"),
    ).toThrowError(/CHECK/i);
  });
});

describe("foreign keys", () => {
  it("rejects a join row referencing a non-existent user", () => {
    tmp.sqlite
      .prepare("INSERT INTO customers (nickname, created_at, updated_at) VALUES (?, 1, 1)")
      .run("c");
    expect(() =>
      tmp.sqlite
        .prepare("INSERT INTO customer_owners (customer_id, user_id) VALUES (1, 999)")
        .run(),
    ).toThrowError(/FOREIGN KEY/i);
  });
});

describe("drizzle schema mapping", () => {
  it("inserts and selects through drizzle with camelCase properties", () => {
    tmp.db
      .insert(users)
      .values({ nickname: "n", username: "u1", createdAt: 1, updatedAt: 1 })
      .run();
    const row = tmp.db.select().from(users).all()[0];
    expect(row).toMatchObject({
      nickname: "n",
      username: "u1",
      jobTitle: "other",
      accountStatus: "disabled",
      employmentStatus: "employed",
    });
    // snake_case 列名落库
    const raw = tmp.sqlite.prepare("SELECT * FROM users").get() as Record<string, unknown>;
    expect(raw["created_at"]).toBe(1);
    expect(raw["job_title"]).toBe("other");
  });
});

describe("partial unique indexes", () => {
  const insertUser = (username: string | null) =>
    tmp.sqlite
      .prepare(
        "INSERT INTO users (nickname, username, created_at, updated_at) VALUES (?, ?, 1, 1)",
      )
      .run("u", username);

  it("username: live unique is released after soft delete (reuse allowed)", () => {
    insertUser("alice");
    // live 期间冲突
    expect(() => insertUser("alice")).toThrowError(/UNIQUE/i);
    // 软删后释放
    tmp.sqlite.prepare("UPDATE users SET deleted_at = 2 WHERE username = 'alice'").run();
    expect(() => insertUser("alice")).not.toThrow();
  });

  it("wechat_openid: live unique released after soft delete", () => {
    tmp.sqlite
      .prepare(
        "INSERT INTO customers (nickname, wechat_openid, created_at, updated_at) VALUES (?, ?, 1, 1)",
      )
      .run("c1", "openid_1");
    expect(() =>
      tmp.sqlite
        .prepare(
          "INSERT INTO customers (nickname, wechat_openid, created_at, updated_at) VALUES (?, ?, 1, 1)",
        )
        .run("c2", "openid_1"),
    ).toThrowError(/UNIQUE/i);
    tmp.sqlite.prepare("UPDATE customers SET deleted_at = 2 WHERE wechat_openid = 'openid_1'").run();
    expect(() =>
      tmp.sqlite
        .prepare(
          "INSERT INTO customers (nickname, wechat_openid, created_at, updated_at) VALUES (?, ?, 1, 1)",
        )
        .run("c2", "openid_1"),
    ).not.toThrow();
  });
});
