// 数据库备份任务（type=db-backup）：仅 admin 可创建；better-sqlite3 backup → gzip 落
// <数据库目录>/backups/；滚动保留最近 7 份，超出静默删除最旧。
// K53：配置启用的 S3 远程存储时自动上传一份（覆盖单对象），失败降级 partial。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { systemConfigs } from "../../src/db/schema.js";
import { REMOTE_BACKUP_KEY } from "../../src/modules/jobs/backup.js";
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

function seedS3Config(overrides: Record<string, unknown> = {}): void {
  tmp.db
    .insert(systemConfigs)
    .values({
      code: "s3",
      value: JSON.stringify({
        enabled: true,
        endpoint: "https://s3.example.com",
        region: "ap-east-1",
        bucket: "gb-crm-backup",
        prefix: "daily/",
        accessKeyId: "AKIDEXAMPLE12345678",
        secretAccessKey: "secret-key-abcdefgh12345678",
        ...overrides,
      }),
      updatedAt: clock.t,
      updatedBy: null,
    })
    .onConflictDoNothing()
    .run();
}

interface RemoteDto {
  ok: boolean;
  bucket: string;
  key: string;
  bytes?: number;
  error?: string;
}

interface BackupResultDto {
  file: string;
  bytes: number;
  kept: number;
  pruned: string[];
  remote: RemoteDto | null;
}

async function runBackupJob(
  cookie: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<{
  status: string;
  typeLabel: string;
  result: BackupResultDto | null;
}> {
  const res = await post("/api/v1/background-jobs", cookie, { type: "db-backup" });
  expect(res.statusCode).toBe(201);
  const jobId = res.json().data.id as number;
  const runner = createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn: opts.fetchFn });
  await runner.pumpOnce();
  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/background-jobs/${jobId}`,
    headers: { cookie },
  });
  return detail.json().data as {
    status: string;
    typeLabel: string;
    result: BackupResultDto | null;
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

describe("数据库备份任务 · 远程上传（K53）", () => {
  /** 记录 PUT 请求的 S3 mock */
  function s3Mock(status: number) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: unknown) => {
      calls.push({ url: url as URL, init: (init ?? {}) as RequestInit });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  it("启用且配置完整 → 上传成功，任务 succeeded，result.remote 带 bucket/key/bytes", async () => {
    const { calls, fetchFn } = s3Mock(200);
    seedS3Config();
    const admin = await loginAsRole("admin");
    const dto = await runBackupJob(admin, { fetchFn });

    expect(dto.status).toBe("succeeded");
    expect(dto.result!.remote).toEqual({
      ok: true,
      bucket: "gb-crm-backup",
      key: `daily/${REMOTE_BACKUP_KEY}`,
      bytes: dto.result!.bytes,
    });

    // 只有一次 PUT，URL 为固定覆盖对象，body 与本地备份逐字节一致
    expect(calls.length).toBe(1);
    expect(calls[0]!.init.method).toBe("PUT");
    expect(String(calls[0]!.url)).toBe(
      "https://s3.example.com/gb-crm-backup/daily/gb-crm-latest.sqlite.gz",
    );
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE12345678\//,
    );
    expect(calls[0]!.init.body).toBeInstanceOf(Buffer);
    expect((calls[0]!.init.body as Buffer).equals(fs.readFileSync(dto.result!.file))).toBe(true);
  });

  it("上传失败 → 任务 partial + result.remote.error；本地备份不受影响", async () => {
    const { fetchFn } = s3Mock(500);
    seedS3Config();
    const admin = await loginAsRole("admin");
    const dto = await runBackupJob(admin, { fetchFn });

    expect(dto.status).toBe("partial");
    expect(dto.result!.remote!.ok).toBe(false);
    expect(dto.result!.remote!.error).toContain("500");
    // 本地备份仍成功落盘
    expect(fs.existsSync(dto.result!.file)).toBe(true);
  });

  it("未配置 / 未启用 / 配置不完整 → 跳过上传（不发请求），任务 succeeded", async () => {
    const { calls, fetchFn } = s3Mock(200);
    const admin = await loginAsRole("admin");

    let dto = await runBackupJob(admin, { fetchFn });
    expect(dto.status).toBe("succeeded");
    expect(dto.result!.remote).toBeNull();

    seedS3Config({ enabled: false });
    dto = await runBackupJob(admin, { fetchFn });
    expect(dto.status).toBe("succeeded");
    expect(dto.result!.remote).toBeNull();

    seedS3Config({ enabled: true, secretAccessKey: "" }); // 四要素缺一
    dto = await runBackupJob(admin, { fetchFn });
    expect(dto.status).toBe("succeeded");
    expect(dto.result!.remote).toBeNull();

    expect(calls.length).toBe(0);
  });

  it("网络异常 → partial，error 带中文原因", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    seedS3Config();
    const admin = await loginAsRole("admin");
    const dto = await runBackupJob(admin, { fetchFn });

    expect(dto.status).toBe("partial");
    expect(dto.result!.remote!.ok).toBe(false);
    expect(dto.result!.remote!.error).toContain("ECONNREFUSED");
  });
});
