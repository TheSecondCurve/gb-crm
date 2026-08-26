// 数据库备份任务（type=db-backup）：仅 admin 可创建；better-sqlite3 backup → gzip 落
// <数据库目录>/backups/；滚动保留最近 7 份，超出静默删除最旧。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createJobRunner } from "../../src/modules/jobs/runner.js";
import { loginAs, seedUser, testEnv } from "../helpers/auth.js";
import { createTmpDb, type TmpDb } from "../helpers/tmp-db.js";

let tmp: TmpDb;
let clock: { t: number };
let app: FastifyInstance;

beforeEach(() => {
  tmp = createTmpDb();
  clock = { t: Date.now() };
  app = buildApp({ env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0 });
});

afterEach(async () => {
  await app.close();
  tmp.cleanup();
});

const backupDir = () => path.join(path.dirname(tmp.dbPath), "backups");

async function loginAsRole(role: "admin" | "operator" | "assistant") {
  const username = `u-${role}`;
  await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  return loginAs(app, username, "password123");
}

const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function runBackupJob(cookie: string) {
  const res = await post("/api/v1/background-jobs", cookie, { type: "db-backup" });
  expect(res.statusCode).toBe(201);
  const jobId = res.json().data.id as number;
  const runner = createJobRunner({ db: tmp.db, now: () => clock.t });
  await runner.pumpOnce();
  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/background-jobs/${jobId}`,
    headers: { cookie },
  });
  return detail.json().data as {
    status: string;
    typeLabel: string;
    result: { file: string; bytes: number; kept: number; pruned: string[] } | null;
  };
}

describe("数据库备份任务", () => {
  it("operator / assistant 创建 → 403；admin → 201", async () => {
    const operator = await loginAsRole("operator");
    const assistant = await loginAsRole("assistant");
    expect((await post("/api/v1/background-jobs", operator, { type: "db-backup" })).statusCode).toBe(403);
    expect((await post("/api/v1/background-jobs", assistant, { type: "db-backup" })).statusCode).toBe(403);
    const admin = await loginAsRole("admin");
    expect((await post("/api/v1/background-jobs", admin, { type: "db-backup" })).statusCode).toBe(201);
  });

  it("执行成功：gzip 备份落 backups/ 且可解压为合法 sqlite", async () => {
    const admin = await loginAsRole("admin");
    const dto = await runBackupJob(admin);

    expect(dto.status).toBe("succeeded");
    expect(dto.typeLabel).toBe("数据库备份");
    expect(dto.result).not.toBeNull();
    expect(dto.result!.kept).toBe(1);
    expect(dto.result!.pruned).toEqual([]);

    const file = dto.result!.file;
    expect(path.dirname(file)).toBe(backupDir());
    expect(file).toMatch(/gb-crm-\d{8}-\d{6}-\d{3}\.sqlite\.gz$/);
    expect(fs.statSync(file).size).toBe(dto.result!.bytes);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const raw = zlib.gunzipSync(fs.readFileSync(file));
    expect(raw.subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
  });

  it("滚动保留最近 7 份：更旧的备份被删除", async () => {
    const admin = await loginAsRole("admin");
    fs.mkdirSync(backupDir(), { recursive: true });
    // 预置 7 份更旧的备份（文件名时间戳递增，字典序 = 时间序）
    const oldNames = Array.from(
      { length: 7 },
      (_, i) => `gb-crm-2020010${i + 1}-000000-000.sqlite.gz`,
    );
    for (const name of oldNames) {
      fs.writeFileSync(path.join(backupDir(), name), zlib.gzipSync("dummy"));
    }
    const outsider = "gb-crm-notes.txt"; // 不匹配备份命名，绝不动它
    fs.writeFileSync(path.join(backupDir(), outsider), "keep me");

    clock.t = new Date("2026-08-26T09:49:04.123").getTime();
    const dto = await runBackupJob(admin);

    expect(dto.status).toBe("succeeded");
    expect(dto.result!.kept).toBe(7);
    expect(dto.result!.pruned).toEqual([oldNames[0]]);

    const remaining = fs.readdirSync(backupDir()).sort();
    expect(remaining).toHaveLength(8); // 7 份备份 + 无关文件
    expect(remaining).toContain(outsider);
    expect(remaining).not.toContain(oldNames[0]!);
    expect(remaining).toContain(path.basename(dto.result!.file));
  });
});
