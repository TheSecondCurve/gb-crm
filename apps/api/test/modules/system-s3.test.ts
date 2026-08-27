// system s3-config（K53）：GET 掩码返回；PATCH placeholder 语义 + enabled 四要素完整性校验；
// POST /test 连通性探测（写探针再删）。存储为 system_configs code='s3'。
import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
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

async function loginAsRole(role: "admin" | "operator" | "assistant") {
  const username = `u-${role}`;
  await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  return loginAs(app, username, "password123");
}

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const patch = (url: string, cookie: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });
const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });

const FULL_CONFIG = {
  enabled: true,
  endpoint: "https://s3.example.com",
  region: "ap-east-1",
  bucket: "gb-crm-backup",
  prefix: "backups/",
  accessKeyId: "AKIDEXAMPLE12345678",
  secretAccessKey: "secret-key-abcdefgh12345678",
};

describe("GET/PATCH /api/v1/system/s3-config", () => {
  it("未登录 401；operator/assistant → 403", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/system/s3-config" })).statusCode).toBe(
      401,
    );
    for (const role of ["operator", "assistant"] as const) {
      const cookie = await loginAsRole(role);
      expect((await get("/api/v1/system/s3-config", cookie)).statusCode).toBe(403);
      expect(
        (await patch("/api/v1/system/s3-config", cookie, { enabled: false })).statusCode,
      ).toBe(403);
      expect((await post("/api/v1/system/s3-config/test", cookie)).statusCode).toBe(403);
    }
  });

  it("未配置 → 默认空值 + secretKeySet=false", async () => {
    const cookie = await loginAsRole("admin");
    const res = await get("/api/v1/system/s3-config", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      enabled: false,
      endpoint: null,
      region: null,
      bucket: null,
      prefix: null,
      accessKeyId: null,
      secretKeySet: false,
      secretKeyMasked: null,
      keep: 7,
    });
  });

  it("保存完整配置；GET 只回掩码（永不全量返回 secret）", async () => {
    const cookie = await loginAsRole("admin");
    const res = await patch("/api/v1/system/s3-config", cookie, FULL_CONFIG);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      ...FULL_CONFIG,
      secretAccessKey: undefined,
      secretKeySet: true,
      secretKeyMasked: "secr…5678",
      keep: 7,
    });
    expect(res.body).not.toContain(FULL_CONFIG.secretAccessKey);

    const again = await get("/api/v1/system/s3-config", cookie);
    expect(again.json().data.enabled).toBe(true);
    expect(again.json().data.keep).toBe(7);
    expect(again.body).not.toContain(FULL_CONFIG.secretAccessKey);
  });

  it("secretAccessKey 缺席/空 → 保留旧值；可只改单项", async () => {
    const cookie = await loginAsRole("admin");
    await patch("/api/v1/system/s3-config", cookie, FULL_CONFIG);

    const r2 = await patch("/api/v1/system/s3-config", cookie, { region: "us-west-2" });
    expect(r2.json().data.region).toBe("us-west-2");
    expect(r2.json().data.secretKeySet).toBe(true);

    const r3 = await patch("/api/v1/system/s3-config", cookie, {
      endpoint: null,
      bucket: null,
      accessKeyId: null,
      enabled: false,
    });
    expect(r3.json().data.endpoint).toBeNull();
    expect(r3.json().data.bucket).toBeNull();
    expect(r3.json().data.accessKeyId).toBeNull();
    expect(r3.json().data.secretKeySet).toBe(true); // secret 不受清空影响
  });

  it("enabled=true 但四要素不齐 → 422 VALIDATION；禁用态允许残缺", async () => {
    const cookie = await loginAsRole("admin");
    const partial = {
      endpoint: FULL_CONFIG.endpoint,
      bucket: FULL_CONFIG.bucket,
      accessKeyId: FULL_CONFIG.accessKeyId,
      enabled: false,
    };
    const saved = await patch("/api/v1/system/s3-config", cookie, partial);
    expect(saved.statusCode).toBe(200);

    const enable = await patch("/api/v1/system/s3-config", cookie, { enabled: true });
    expect(enable.statusCode).toBe(422);
    expect(enable.json().error.code).toBe("VALIDATION");
    expect(enable.json().error.message).toContain("SecretAccessKey");

    // 补齐 secret 后启用成功
    const ok = await patch("/api/v1/system/s3-config", cookie, {
      secretAccessKey: FULL_CONFIG.secretAccessKey,
      enabled: true,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.enabled).toBe(true);
  });

  it("prefix 归一化：去开头斜杠、结尾补一个斜杠", async () => {
    const cookie = await loginAsRole("admin");
    const res = await patch("/api/v1/system/s3-config", cookie, {
      ...FULL_CONFIG,
      prefix: "//deep/path//",
    });
    expect(res.json().data.prefix).toBe("deep/path/");
  });

  it("endpoint 非 http(s)/bucket 非法字符 → 422", async () => {
    const cookie = await loginAsRole("admin");
    const r1 = await patch("/api/v1/system/s3-config", cookie, {
      ...FULL_CONFIG,
      endpoint: "ftp://x.example.com",
    });
    expect(r1.statusCode).toBe(422);
    const r2 = await patch("/api/v1/system/s3-config", cookie, {
      ...FULL_CONFIG,
      bucket: "bad bucket!",
    });
    expect(r2.statusCode).toBe(422);
  });
});

describe("POST /api/v1/system/s3-config/test", () => {
  /** 记录请求并按脚本应答的 S3 mock */
  function s3Mock(responder: () => Response) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: unknown) => {
      calls.push({ url: url as URL, init: (init ?? {}) as RequestInit });
      return responder();
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  /** 用注入了 s3Fetch 的 app 替换全局 app（afterEach 统一清理） */
  async function rebuildWith(fetchFn?: typeof fetch): Promise<string> {
    await app.close();
    tmp.cleanup();
    tmp = createTmpDb();
    clock = { t: Date.now() };
    app = buildApp({
      env: testEnv(),
      db: tmp.db,
      now: () => clock.t,
      gcProbability: 0,
      s3Fetch: fetchFn,
    });
    return loginAsRole("admin");
  }

  it("未保存/未启用 → 422 提示先保存完整配置", async () => {
    const cookie = await loginAsRole("admin");
    expect((await post("/api/v1/system/s3-config/test", cookie)).statusCode).toBe(422);

    // 残缺但已保存 → 同样拒绝测试
    await patch("/api/v1/system/s3-config", cookie, { endpoint: "https://s3.example.com" });
    expect((await post("/api/v1/system/s3-config/test", cookie)).statusCode).toBe(422);
  });

  it("成功：写探针 + 删除，SigV4 请求头齐全；响应带回 probeKey", async () => {
    const { calls, fetchFn } = s3Mock(() => new Response(null, { status: 200 }));
    const cookie = await rebuildWith(fetchFn);
    await patch("/api/v1/system/s3-config", cookie, FULL_CONFIG);

    const res = await post("/api/v1/system/s3-config/test", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true, probeKey: "backups/.gb-crm-probe.txt" });

    expect(calls.length).toBe(2); // PUT 探针 + DELETE 清理
    const put = calls[0]!;
    const del = calls[1]!;
    expect(put.init.method).toBe("PUT");
    expect(String(put.url)).toBe("https://s3.example.com/gb-crm-backup/backups/.gb-crm-probe.txt");
    const putHeaders = put.init.headers as Record<string, string>;
    expect(putHeaders.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE12345678\//);
    expect(putHeaders.Authorization).toContain("/ap-east-1/s3/aws4_request");
    expect(putHeaders["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(putHeaders["x-amz-content-sha256"]).toBe(
      createHash("sha256").update("gb-crm connectivity probe").digest("hex"),
    );
    expect(del.init.method).toBe("DELETE");
  });

  it("上游失败 → 502 S3_ERROR（message 可直接 Toast）", async () => {
    const { fetchFn } = s3Mock(() => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }));
    const cookie = await rebuildWith(fetchFn);
    await patch("/api/v1/system/s3-config", cookie, FULL_CONFIG);

    const res = await post("/api/v1/system/s3-config/test", cookie);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("S3_ERROR");
    expect(res.json().error.message).toContain("403");
  });

  it("网络异常（fetch 抛错）→ 502 S3_ERROR", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const cookie = await rebuildWith(fetchFn);
    await patch("/api/v1/system/s3-config", cookie, FULL_CONFIG);

    const res = await post("/api/v1/system/s3-config/test", cookie);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("S3_ERROR");
    expect(res.json().error.message).toContain("ECONNREFUSED");
  });
});
