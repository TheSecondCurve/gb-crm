// system materials-s3-config（K57）：资料存储，独立于备份 s3-config。
// GET 掩码；PATCH placeholder + enabled 四要素；POST /test 连通性探测。
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

const PATH = "/api/v1/system/materials-s3-config";
const FULL_CONFIG = {
  enabled: true,
  endpoint: "https://oss.example.com",
  region: "oss-cn-hangzhou",
  bucket: "gb-crm-files",
  prefix: "materials/",
  accessKeyId: "AKIDMATERIALS12345678",
  secretAccessKey: "secret-materials-abcdefgh1234",
};

describe("GET/PATCH /api/v1/system/materials-s3-config", () => {
  it("未登录 401；operator/assistant → 403", async () => {
    expect((await app.inject({ method: "GET", url: PATH })).statusCode).toBe(401);
    for (const role of ["operator", "assistant"] as const) {
      const cookie = await loginAsRole(role);
      expect((await get(PATH, cookie)).statusCode).toBe(403);
      expect((await patch(PATH, cookie, { enabled: false })).statusCode).toBe(403);
      expect((await post(`${PATH}/test`, cookie)).statusCode).toBe(403);
    }
  });

  it("未配置 → 默认空值 + secretKeySet=false，无 keep", async () => {
    const cookie = await loginAsRole("admin");
    const res = await get(PATH, cookie);
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
    });
    expect(res.json().data.keep).toBeUndefined();
  });

  it("与备份 s3-config 互相独立", async () => {
    const cookie = await loginAsRole("admin");
    await patch("/api/v1/system/s3-config", cookie, {
      ...FULL_CONFIG,
      bucket: "gb-crm-backup",
      keep: 5,
    });
    const materials = await get(PATH, cookie);
    expect(materials.json().data.enabled).toBe(false);
    expect(materials.json().data.bucket).toBeNull();

    await patch(PATH, cookie, FULL_CONFIG);
    const backup = await get("/api/v1/system/s3-config", cookie);
    expect(backup.json().data.bucket).toBe("gb-crm-backup");
    expect(backup.json().data.keep).toBe(5);
    const saved = await get(PATH, cookie);
    expect(saved.json().data.bucket).toBe("gb-crm-files");
    expect(saved.json().data.keep).toBeUndefined();
    expect(saved.json().data.secretKeySet).toBe(true);
  });

  it("启用但四要素残缺 → 422", async () => {
    const cookie = await loginAsRole("admin");
    const res = await patch(PATH, cookie, { enabled: true, endpoint: "https://oss.example.com" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("资料存储");
  });
});

describe("POST /api/v1/system/materials-s3-config/test", () => {
  function s3Mock(responder: () => Response) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: unknown) => {
      calls.push({ url: url as URL, init: (init ?? {}) as RequestInit });
      return responder();
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

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

  it("成功：写探针 + 删除", async () => {
    const { calls, fetchFn } = s3Mock(() => new Response(null, { status: 200 }));
    const cookie = await rebuildWith(fetchFn);
    await patch(PATH, cookie, FULL_CONFIG);

    const res = await post(`${PATH}/test`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true, probeKey: "materials/.gb-crm-probe.txt" });
    expect(calls[0]!.init.method).toBe("PUT");
    expect(String(calls[0]!.url)).toBe(
      "https://oss.example.com/gb-crm-files/materials/.gb-crm-probe.txt",
    );
    const putHeaders = calls[0]!.init.headers as Record<string, string>;
    expect(putHeaders["x-amz-content-sha256"]).toBe(
      createHash("sha256").update("gb-crm connectivity probe").digest("hex"),
    );
  });
});
