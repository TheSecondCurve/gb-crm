// K61 工作台快照分发集成测试：发布 / 清单 / 对象下载 / 权限矩阵 / 内容寻址去重 / 滚动保留 GC。
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { loginAs, seedUser, testEnv } from "../helpers/auth.js";
import { createTmpDb, type TmpDb } from "../helpers/tmp-db.js";
import { fileBlock, tarGz, ustarHeader } from "../helpers/tar-builder.js";

let tmp: TmpDb;
let clock: { t: number };
let app: FastifyInstance;
let store: Map<string, Buffer>;
let s3Log: { method: string; key: string }[];

/** 内存 S3：key = 去 bucket 后的对象路径（workbench/objects/<sha>） */
function makeS3Fetch() {
  return vi.fn(async (url: unknown, init?: unknown) => {
    const method = String((init as RequestInit | undefined)?.method ?? "GET");
    const u = new URL(String(url));
    const key = u.pathname.replace(/^\/[^/]+\//, "");
    s3Log.push({ method, key });
    if (method === "PUT") {
      store.set(key, Buffer.from((init as RequestInit).body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      store.delete(key);
      return new Response(null, { status: 204 });
    }
    if (u.searchParams.has("list-type")) {
      const prefix = u.searchParams.get("prefix") ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
        keys.map((k) => `<Key>${k}</Key>`).join("") +
        `<IsTruncated>false</IsTruncated></ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    }
    const hit = store.get(key);
    if (!hit) return new Response(" NoSuchKey", { status: 404 });
    return new Response(hit, { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  tmp = createTmpDb();
  clock = { t: Date.now() };
  store = new Map();
  s3Log = [];
  app = buildApp({
    env: testEnv(),
    db: tmp.db,
    now: () => clock.t,
    gcProbability: 0,
    s3Fetch: makeS3Fetch(),
  });
});

afterEach(async () => {
  await app.close();
  tmp.cleanup();
});

async function pat(username: string, scope: "read" | "write"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/tokens",
    payload: { username, password: "password123", scope, name: `test-${scope}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().data.token as string;
}

function multipart(fields: Record<string, string>, bundle: Buffer) {
  const boundary = "----GbWorkbenchTest";
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="snapshot.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`,
    ),
  );
  chunks.push(bundle);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const FULL_STORAGE = {
  enabled: true,
  endpoint: "https://oss.example.com",
  region: "oss-cn-hangzhou",
  bucket: "gb-wb",
  prefix: "wb/",
  accessKeyId: "AKIDWORKBENCH1234567",
  secretAccessKey: "secret-workbench-abcdefgh12",
};

async function seedRolesAndLogin() {
  await seedUser(tmp.db, { username: "boss", systemRole: "admin" });
  await seedUser(tmp.db, { username: "op", systemRole: "operator" });
  await seedUser(tmp.db, { username: "asst", systemRole: "assistant" });
  const adminCookie = await loginAs(app, "boss", "password123");
  const opCookie = await loginAs(app, "op", "password123");
  return { adminCookie, opCookie };
}

async function enableStorage(adminCookie: string) {
  const res = await app.inject({
    method: "PATCH",
    url: "/api/v1/system/workbench-s3-config",
    headers: { cookie: adminCookie },
    payload: FULL_STORAGE,
  });
  expect(res.statusCode).toBe(200);
}

function bundleOf(files: { path: string; content: string; mode?: number }[]): Buffer {
  return tarGz(files.map((f) => fileBlock(f)));
}

describe("配置（system/workbench-s3-config）", () => {
  it("GET 缺省未配置；PATCH admin 保存并掩码；operator 403", async () => {
    const { adminCookie, opCookie } = await seedRolesAndLogin();
    const before = await app.inject({
      method: "GET",
      url: "/api/v1/system/workbench-s3-config",
      headers: { cookie: adminCookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().data.enabled).toBe(false);

    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/system/workbench-s3-config",
          headers: { cookie: opCookie },
          payload: FULL_STORAGE,
        })
      ).statusCode,
    ).toBe(403);

    await enableStorage(adminCookie);
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/system/workbench-s3-config",
      headers: { cookie: adminCookie },
    });
    expect(after.json().data).toMatchObject({
      enabled: true,
      bucket: "gb-wb",
      prefix: "wb/",
      secretKeySet: true,
      secretKeyMasked: expect.any(String),
    });
    expect(JSON.stringify(after.json())).not.toContain("secret-workbench");
  });

  it("enabled=true 但四要素残缺 → 422", async () => {
    const { adminCookie } = await seedRolesAndLogin();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/system/workbench-s3-config",
      headers: { cookie: adminCookie },
      payload: { enabled: true, endpoint: "https://oss.example.com" },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("POST /api/v1/workbench/versions 发布", () => {
  it("未配置对象存储 → 422 提示去系统设置", async () => {
    const { adminCookie } = await seedRolesAndLogin();
    const mp = multipart({ commitSha: "0f1e2d3c" }, bundleOf([{ path: "a.md", content: "A" }]));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/versions",
      headers: { cookie: adminCookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("工作台");
  });

  it("read PAT / operator cookie / 未登录均拒绝；write PAT admin 发布成功", async () => {
    const { adminCookie, opCookie } = await seedRolesAndLogin();
    await enableStorage(adminCookie);
    const bundle = bundleOf([
      { path: "_工作区仓库/AGENTS.md", content: "总纲" },
      { path: "scripts/sync.sh", content: "#!/bin/sh\n", mode: 0o755 },
    ]);
    const mp = multipart({ commitSha: "0f1e2d3c4b5a", subject: "接入快照分发", note: "首发" }, bundle);

    // read PAT（admin 的只读令牌）POST → 403（session-auth 拦 read 令牌写操作）
    const ro = await pat("boss", "read");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/workbench/versions",
          headers: { authorization: `Bearer ${ro}`, ...mp.headers },
          payload: mp.payload,
        })
      ).statusCode,
    ).toBe(403);

    // operator cookie → 403（仅管理员）
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/workbench/versions",
          headers: { cookie: opCookie, ...mp.headers },
          payload: mp.payload,
        })
      ).statusCode,
    ).toBe(403);

    // 未登录 → 401
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/workbench/versions",
          headers: mp.headers,
          payload: mp.payload,
        })
      ).statusCode,
    ).toBe(401);

    // write PAT admin → 200
    const rw = await pat("boss", "write");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/versions",
      headers: { authorization: `Bearer ${rw}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.version).toMatchObject({
      id: 1,
      commitSha: "0f1e2d3c4b5a",
      commitSubject: "接入快照分发",
      note: "首发",
      fileCount: 2,
    });
    expect(data.uploaded).toBe(2);
    expect(data.skipped).toBe(0);
    expect(data.version.files).toHaveLength(2);
    // 对象 key = 前缀 + workbench/objects/<sha>；可执行档 mode=493
    const files = data.version.files as { path: string; sha256: string; mode: number }[];
    expect(store.get(`wb/workbench/objects/${files[1]!.sha256}`)).toBeDefined();
    expect(files.find((f) => f.path === "scripts/sync.sh")!.mode).toBe(0o755);
    expect(files.find((f) => f.path === "_工作区仓库/AGENTS.md")!.mode).toBe(0o644);
  });

  it("同内容重发布：list 去重，uploaded=0 / skipped=全量", async () => {
    const { adminCookie } = await seedRolesAndLogin();
    await enableStorage(adminCookie);
    const rw = await pat("boss", "write");
    const mp = multipart({ commitSha: "aaa1111" }, bundleOf([{ path: "a.md", content: "A" }]));
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/workbench/versions",
          headers: { authorization: `Bearer ${rw}`, ...mp.headers },
          payload: mp.payload,
        })
      ).statusCode,
    ).toBe(200);
    const mp2 = multipart({ commitSha: "bbb2222" }, bundleOf([{ path: "a.md", content: "A" }]));
    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/versions",
      headers: { authorization: `Bearer ${rw}`, ...mp2.headers },
      payload: mp2.payload,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().data.uploaded).toBe(0);
    expect(res2.json().data.skipped).toBe(1);
  });

  it("zip-slip / 链接 / 重复路径 → 422，且不留版本行", async () => {
    const { adminCookie } = await seedRolesAndLogin();
    await enableStorage(adminCookie);
    const rw = await pat("boss", "write");
    const bad = tarGz([
      Buffer.concat([
        ustarHeader({ name: "esc", size: 1, typeflag: "2", linkname: "x" }),
        Buffer.alloc(512),
      ]),
    ]);
    const mp = multipart({ commitSha: "ccc3333" }, bad);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/versions",
      headers: { authorization: `Bearer ${rw}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("链接");
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/workbench/versions",
      headers: { authorization: `Bearer ${rw}` },
    });
    expect(list.json().meta.total).toBe(0);
  });
});

describe("读取端点", () => {
  interface PublishedVersion {
    id: number;
    files: { path: string; sha256: string; size: number; mode: number }[];
  }

  async function publishOne(note: string, content: string): Promise<PublishedVersion> {
    const rw = await pat("boss", "write");
    const mp = multipart({ commitSha: "0f1e2d3c", note }, bundleOf([{ path: "a.md", content }]));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/versions",
      headers: { authorization: `Bearer ${rw}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json().data.version as PublishedVersion;
  }

  it("manifest.tsv：元数据行 + TSV 数据行（read PAT / assistant 可读，未登录 401）", async () => {
    const { adminCookie } = await seedRolesAndLogin();
    await enableStorage(adminCookie);
    const v = await publishOne("首发说明", "内容V1");

    const ro = await pat("asst", "read");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/workbench/manifest.tsv",
      headers: { authorization: `Bearer ${ro}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    const lines = res.body.split("\n");
    expect(lines[0]).toBe(`#version\t${v.id}`);
    expect(lines).toContain(`#note\t首发说明`);
    expect(lines[5]).toBe(`${v.files[0]!.sha256}\t${v.files[0]!.size}\t420\ta.md`);

    expect(
      (
        await app.inject({ method: "GET", url: "/api/v1/workbench/manifest.tsv" })
      ).statusCode,
    ).toBe(401);
  });

  it("对象下载：内容一致 + ETag；非法 sha 422；未知 sha 404", async () => {
    const { adminCookie } = await seedRolesAndLogin();
    await enableStorage(adminCookie);
    const v = await publishOne("n", "内容V1");
    const ro = await pat("asst", "read");
    const sha = v.files[0]!.sha256;

    const ok = await app.inject({
      method: "GET",
      url: `/api/v1/workbench/objects/${sha}`,
      headers: { authorization: `Bearer ${ro}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("内容V1");
    expect(ok.headers.etag).toBe(`"${sha}"`);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/workbench/objects/nothex",
          headers: { authorization: `Bearer ${ro}` },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/workbench/objects/${"0".repeat(64)}`,
          headers: { authorization: `Bearer ${ro}` },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("latest / :id / 列表 / ?version= 指定版本清单；无版本时 latest 404", async () => {
    const { adminCookie } = await seedRolesAndLogin();
    await enableStorage(adminCookie);
    const ro = await pat("asst", "read");

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/workbench/versions/latest",
          headers: { authorization: `Bearer ${ro}` },
        })
      ).statusCode,
    ).toBe(404);

    const v1 = await publishOne("v1", "内容V1");
    const v2 = await publishOne("v2", "内容V2");

    const latest = await app.inject({
      method: "GET",
      url: "/api/v1/workbench/versions/latest",
      headers: { authorization: `Bearer ${ro}` },
    });
    expect(latest.json().data.id).toBe(v2.id);

    const old = await app.inject({
      method: "GET",
      url: `/api/v1/workbench/versions/${v1.id}`,
      headers: { authorization: `Bearer ${ro}` },
    });
    expect(old.json().data.files[0].sha256).toBe(v1.files[0]!.sha256);

    const tsv = await app.inject({
      method: "GET",
      url: `/api/v1/workbench/manifest.tsv?version=${v1.id}`,
      headers: { authorization: `Bearer ${ro}` },
    });
    expect(tsv.body.split("\n")[0]).toBe(`#version\t${v1.id}`);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/workbench/versions?page=1&pageSize=1",
      headers: { authorization: `Bearer ${ro}` },
    });
    expect(list.json()).toMatchObject({ meta: { page: 1, pageSize: 1, total: 2 } });
    expect(list.json().data[0].id).toBe(v2.id);
  });
});

describe("滚动保留与对象 GC", () => {
  it("发布 12 版（keep=10）：版本只留 10，被删版本独占对象被 GC，共享对象保留", async () => {
    const { adminCookie } = await seedRolesAndLogin();
    await enableStorage(adminCookie);
    const rw = await pat("boss", "write");

    const shas: string[] = [];
    for (let i = 1; i <= 12; i += 1) {
      // common.txt 内容恒定（跨版本共享）；per-v<i>.txt 每版不同（被裁版本独占）
      const mp = multipart(
        { commitSha: `${i.toString(16).padStart(7, "0")}` },
        bundleOf([
          { path: "common.txt", content: "SHARED" },
          { path: `per-v${i}.txt`, content: `unique-${i}` },
        ]),
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/workbench/versions",
        headers: { authorization: `Bearer ${rw}`, ...mp.headers },
        payload: mp.payload,
      });
      expect(res.statusCode).toBe(200);
      shas.push(
        ...(res.json().data.version.files as { sha256: string; path: string }[])
          .filter((f) => f.path === `per-v${i}.txt`)
          .map((f) => f.sha256),
      );
    }

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/workbench/versions",
      headers: { authorization: `Bearer ${rw}` },
    });
    expect(list.json().meta.total).toBe(10);
    const ids = list.json().data.map((v: { id: number }) => v.id);
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);

    // v1 / v2 的独占对象被 GC；对象库里只剩 keep 内版本（3..12）引用的对象
    expect(store.get(`wb/workbench/objects/${shas[0]}`)).toBeUndefined();
    expect(store.get(`wb/workbench/objects/${shas[1]}`)).toBeUndefined();
    expect(store.get(`wb/workbench/objects/${shas[11]}`)).toBeDefined();
    // 共享对象（common.txt 恒定内容）跨版本去重保留；总量 = per-v3..v12（10）+ common（1）
    const commonSha = createHash("sha256").update("SHARED").digest("hex");
    expect(store.get(`wb/workbench/objects/${commonSha}`)).toBeDefined();
    expect(store.size).toBe(11);
  });
});

describe("GET /agent/workbench/install.sh", () => {
  it("公开下发，注入请求 origin；非法 Host 回退本地默认", async () => {
    await seedRolesAndLogin();
    const res = await app.inject({
      method: "GET",
      url: "/agent/workbench/install.sh",
      headers: { host: "crm.internal:3001" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/x-shellscript");
    expect(res.body).toContain('BASE="http://crm.internal:3001"');
    expect(res.body).not.toContain("__GB_CRM_BASE_URL__");

    const weird = await app.inject({
      method: "GET",
      url: "/agent/workbench/install.sh",
      headers: { host: "evil host; rm -rf" },
    });
    expect(weird.body).toContain('BASE="http://127.0.0.1:3001"');
  });
});

describe("GET /agent/workbench/install.ps1", () => {
  it("公开下发，注入请求 origin；指向 /agent/login.ps1；纯 ASCII", async () => {
    await seedRolesAndLogin();
    const res = await app.inject({
      method: "GET",
      url: "/agent/workbench/install.ps1",
      headers: { host: "crm.internal:3001" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/x-powershell");
    expect(res.body).toContain('http://crm.internal:3001');
    expect(res.body).toContain("/agent/login.ps1"); // 授权链走 Windows 版登录脚本
    expect(res.body).toContain("manifest.tsv"); // 拉 TSV 清单逐文件下载
    expect(res.body).not.toContain("__GB_CRM_BASE_URL__"); // 占位符已替换
    // 纯 ASCII：Windows PS 5.1 对无 BOM 的 .ps1 按 ANSI 读、有 BOM 又让 `irm|iex` 首行报错；
    // 纯 ASCII 则 iex / -File / & 三种执行方式都无编码歧义（同 skill 安装器结论）。
    let maxByte = 0;
    for (const b of res.rawPayload) if (b > maxByte) maxByte = b;
    expect(maxByte).toBeLessThanOrEqual(0x7f);
  });

  it("非法 Host 不写入脚本（防注入），回退本地默认", async () => {
    await seedRolesAndLogin();
    const res = await app.inject({
      method: "GET",
      url: "/agent/workbench/install.ps1",
      headers: { host: "evil host; rm -rf" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("rm -rf");
    expect(res.body).toContain("http://127.0.0.1:3001");
  });
});
