import argon2 from "argon2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { bootstrapAdmin, BootstrapRefusedError } from "../src/db/bootstrap-admin.js";
import { seedUser, testEnv } from "./helpers/auth.js";
import { createTmpDb, type TmpDb } from "./helpers/tmp-db.js";

let tmp: TmpDb;
let logs: string[];
const log = (m: string) => logs.push(m);

beforeEach(() => {
  tmp = createTmpDb();
  logs = [];
});

afterEach(() => {
  tmp.cleanup();
});

const env = (overrides: Partial<Parameters<typeof bootstrapAdmin>[1]> = {}) => ({
  ADMIN_USERNAME: undefined,
  ADMIN_PASSWORD: undefined,
  ADMIN_BOOTSTRAP_RESET_PASSWORD: false,
  ...overrides,
});

describe("bootstrap admin（§5 五条规则）", () => {
  it("已有 live admin 且无 ADMIN_PASSWORD → skipped，不要求密码", async () => {
    await seedUser(tmp.db); // live admin
    const result = await bootstrapAdmin(tmp.db, env(), { log });
    expect(result).toBe("skipped");
    expect(logs).toEqual(["bootstrap=skipped"]);
  });

  it("reset=true 但无 ADMIN_PASSWORD → 拒启", async () => {
    await seedUser(tmp.db);
    await expect(
      bootstrapAdmin(tmp.db, env({ ADMIN_BOOTSTRAP_RESET_PASSWORD: true }), { log }),
    ).rejects.toBeInstanceOf(BootstrapRefusedError);
    expect(logs).toEqual(["bootstrap=refused"]);
  });

  it("零 live admin 且缺凭据 → 拒启", async () => {
    await expect(bootstrapAdmin(tmp.db, env(), { log })).rejects.toBeInstanceOf(
      BootstrapRefusedError,
    );
    await expect(
      bootstrapAdmin(tmp.db, env({ ADMIN_USERNAME: "root" }), { log }),
    ).rejects.toBeInstanceOf(BootstrapRefusedError);
    expect(logs).toEqual(["bootstrap=refused", "bootstrap=refused"]);
  });

  it("零 live admin 且凭据齐全 → created：默认值正确且能登录", async () => {
    const result = await bootstrapAdmin(
      tmp.db,
      env({ ADMIN_USERNAME: "root", ADMIN_PASSWORD: "root-password-1" }),
      { log },
    );
    expect(result).toBe("created");
    expect(logs).toEqual(["bootstrap=created"]);

    const row = tmp.sqlite.prepare("SELECT * FROM users WHERE username = 'root'").get() as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      nickname: "管理员",
      job_title: "other",
      system_role: "admin",
      employment_status: "employed",
      account_status: "enabled",
      created_by: null,
    });
    expect(await argon2.verify(row["password_hash"] as string, "root-password-1")).toBe(true);

    // 能登录
    const app = buildApp({ env: testEnv(), db: tmp.db, gcProbability: 0 });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "root", password: "root-password-1" },
      });
      expect(res.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  it("零 live admin 但同名 disabled 用户存在 → 拉回 enabled admin（自锁恢复）", async () => {
    await seedUser(tmp.db, { username: "root", systemRole: null, accountStatus: "disabled" });
    const result = await bootstrapAdmin(
      tmp.db,
      env({ ADMIN_USERNAME: "root", ADMIN_PASSWORD: "root-password-1" }),
      { log },
    );
    expect(result).toBe("created");
    const row = tmp.sqlite.prepare("SELECT * FROM users WHERE username = 'root'").get() as Record<
      string,
      unknown
    >;
    expect(row["system_role"]).toBe("admin");
    expect(row["account_status"]).toBe("enabled");
    expect(await argon2.verify(row["password_hash"] as string, "root-password-1")).toBe(true);
  });

  it("有 live admin + reset + 密码 → 改 hash 并删其 session", async () => {
    const id = await seedUser(tmp.db, { username: "alice", password: "old-password-1" });
    tmp.sqlite
      .prepare(
        "INSERT INTO sessions (id, user_id, created_at, expires_at, last_touched_at) VALUES ('s1', ?, 1, 9999999999, 1)",
      )
      .run(id);

    const result = await bootstrapAdmin(
      tmp.db,
      env({
        ADMIN_USERNAME: "alice",
        ADMIN_PASSWORD: "new-password-1",
        ADMIN_BOOTSTRAP_RESET_PASSWORD: true,
      }),
      { log },
    );
    expect(result).toBe("reset");
    expect(logs).toEqual(["bootstrap=reset"]);

    const row = tmp.sqlite.prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as {
      password_hash: string;
    };
    expect(await argon2.verify(row.password_hash, "new-password-1")).toBe(true);
    expect(await argon2.verify(row.password_hash, "old-password-1")).toBe(false);
    expect(tmp.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("reset 找不到目标用户 → 拒启", async () => {
    await seedUser(tmp.db, { username: "alice" }); // live admin 存在
    await expect(
      bootstrapAdmin(
        tmp.db,
        env({
          ADMIN_USERNAME: "ghost",
          ADMIN_PASSWORD: "whatever-123",
          ADMIN_BOOTSTRAP_RESET_PASSWORD: true,
        }),
        { log },
      ),
    ).rejects.toBeInstanceOf(BootstrapRefusedError);
    expect(logs).toEqual(["bootstrap=refused"]);
  });

  it("disabled 的 admin 不算 live admin：零 live admin 时按规则 3 走", async () => {
    await seedUser(tmp.db, { username: "alice", accountStatus: "disabled" }); // disabled admin
    await expect(bootstrapAdmin(tmp.db, env(), { log })).rejects.toBeInstanceOf(
      BootstrapRefusedError,
    );
  });
});
