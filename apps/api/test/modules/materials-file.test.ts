// K57 资料对象存储：multipart 上传 / 预览下载 / 替换 / 软删尽力清远端。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { loginAs, seedUser, testEnv } from "../helpers/auth.js";
import { createTmpDb, type TmpDb } from "../helpers/tmp-db.js";

let tmp: TmpDb;
let clock: { t: number };
let app: FastifyInstance;
let s3Calls: { method: string; url: string }[];

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const FULL_STORAGE = {
  enabled: true,
  endpoint: "https://oss.example.com",
  region: "oss-cn-hangzhou",
  bucket: "gb-crm-files",
  prefix: "docs/",
  accessKeyId: "AKIDMATERIALS12345678",
  secretAccessKey: "secret-materials-abcdefgh1234",
};

beforeEach(() => {
  tmp = createTmpDb();
  clock = { t: Date.now() };
  s3Calls = [];
  const fetchFn = vi.fn(async (url: unknown, init?: unknown) => {
    const method = String((init as RequestInit | undefined)?.method ?? "GET");
    s3Calls.push({ method, url: String(url) });
    if (method === "GET") {
      return new Response(PNG_1x1, { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  app = buildApp({
    env: testEnv(),
    db: tmp.db,
    now: () => clock.t,
    gcProbability: 0,
    s3Fetch: fetchFn,
  });
});

afterEach(async () => {
  await app.close();
  tmp.cleanup();
});

async function loginAsRole(
  role: "admin" | "operator" | "assistant",
  username = `u-${role}`,
): Promise<{ id: number; cookie: string }> {
  const id = await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  const cookie = await loginAs(app, username, "password123");
  return { id, cookie };
}

function multipart(
  fields: Record<string, string>,
  file: { name: string; type: string; body: Buffer },
) {
  const boundary = "----GbCrmTestBoundary";
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
  );
  chunks.push(file.body);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function enableStorage(cookie: string) {
  const res = await app.inject({
    method: "PATCH",
    url: "/api/v1/system/materials-s3-config",
    headers: { cookie },
    payload: FULL_STORAGE,
  });
  expect(res.statusCode).toBe(200);
}

describe("POST /api/v1/materials JSON kind=file", () => {
  it("JSON 创建 file → 422，须走上传接口", async () => {
    const { cookie } = await loginAsRole("admin");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/materials",
      headers: { cookie },
      payload: { kind: "file", title: "图" },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("POST /api/v1/materials/upload", () => {
  it("未配置资料存储 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const mp = multipart({ title: "截图" }, { name: "a.png", type: "image/png", body: PNG_1x1 });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/materials/upload",
      headers: { cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("资料存储");
  });

  it("assistant 403；admin 上传图片成功并回 isImage", async () => {
    const asst = await loginAsRole("assistant");
    const mp = multipart({ title: "截图" }, { name: "a.png", type: "image/png", body: PNG_1x1 });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/materials/upload",
          headers: { cookie: asst.cookie, ...mp.headers },
          payload: mp.payload,
        })
      ).statusCode,
    ).toBe(403);

    const admin = await loginAsRole("admin");
    await enableStorage(admin.cookie);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/materials/upload",
      headers: { cookie: admin.cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.kind).toBe("file");
    expect(data.title).toBe("截图");
    expect(data.originalFilename).toBe("a.png");
    expect(data.contentType).toBe("image/png");
    expect(data.fileSize).toBe(PNG_1x1.length);
    expect(data.isImage).toBe(true);
    expect(data.url).toBeNull();
    expect(data.objectKey).toBeUndefined();
    expect(s3Calls.some((c) => c.method === "PUT" && c.url.includes("/docs/materials/"))).toBe(
      true,
    );
  });

  it("非图片（pdf）isImage=false", async () => {
    const { cookie } = await loginAsRole("admin");
    await enableStorage(cookie);
    const mp = multipart(
      { title: "合同" },
      { name: "c.pdf", type: "application/pdf", body: Buffer.from("%PDF-1.4 mock") },
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/materials/upload",
      headers: { cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.isImage).toBe(false);
    expect(res.json().data.originalFilename).toBe("c.pdf");
  });
});

describe("GET /api/v1/materials/:id/file", () => {
  it("图片 inline；download=1 attachment；非 file 422", async () => {
    const { cookie } = await loginAsRole("admin");
    await enableStorage(cookie);
    const mp = multipart({ title: "截图" }, { name: "a.png", type: "image/png", body: PNG_1x1 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/materials/upload",
      headers: { cookie, ...mp.headers },
      payload: mp.payload,
    });
    const id = created.json().data.id;

    const inline = await app.inject({
      method: "GET",
      url: `/api/v1/materials/${id}/file`,
      headers: { cookie },
    });
    expect(inline.statusCode).toBe(200);
    expect(inline.headers["content-type"]).toContain("image/png");
    expect(String(inline.headers["content-disposition"])).toContain("inline");
    expect(Buffer.from(inline.rawPayload)).toEqual(PNG_1x1);

    const dl = await app.inject({
      method: "GET",
      url: `/api/v1/materials/${id}/file?download=1`,
      headers: { cookie },
    });
    expect(String(dl.headers["content-disposition"])).toContain("attachment");

    const text = await app.inject({
      method: "POST",
      url: "/api/v1/materials",
      headers: { cookie },
      payload: { kind: "text", title: "纪要" },
    });
    const bad = await app.inject({
      method: "GET",
      url: `/api/v1/materials/${text.json().data.id}/file`,
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(422);
  });
});

describe("POST /api/v1/materials/upload 资料标签（K58）", () => {
  it("带 tagIds/newTagNames 字段 → 201 且挂上；tagIds/newTagNames 非法 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    await enableStorage(cookie);
    const tag = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      headers: { cookie },
      payload: { name: "合同模板", domain: "material" },
    });
    expect(tag.statusCode).toBe(201);

    const mp = multipart(
      {
        title: "带标签文件",
        tagIds: JSON.stringify([tag.json().data.id]),
        newTagNames: JSON.stringify(["签字版"]),
      },
      { name: "a.png", type: "image/png", body: PNG_1x1 },
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/materials/upload",
      headers: { cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    const names = (res.json().data.tags as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["合同模板", "签字版"].sort());

    // tagIds 非法 JSON → 422
    const badJson = multipart(
      { title: "坏标签", tagIds: "[not-json" },
      { name: "b.png", type: "image/png", body: PNG_1x1 },
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/materials/upload",
          headers: { cookie, ...badJson.headers },
          payload: badJson.payload,
        })
      ).statusCode,
    ).toBe(422);

    // newTagNames 非数组的合法 JSON → 422
    const badNames = multipart(
      { title: "坏新词", newTagNames: "123" },
      { name: "c.png", type: "image/png", body: PNG_1x1 },
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/materials/upload",
          headers: { cookie, ...badNames.headers },
          payload: badNames.payload,
        })
      ).statusCode,
    ).toBe(422);
  });
});

describe("替换与删除", () => {
  it("替换文件 OCC；删除软删并尽力 DELETE 远端对象", async () => {
    const { cookie } = await loginAsRole("admin");
    await enableStorage(cookie);
    const mp = multipart({ title: "截图" }, { name: "a.png", type: "image/png", body: PNG_1x1 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/materials/upload",
      headers: { cookie, ...mp.headers },
      payload: mp.payload,
    });
    const m = created.json().data;
    clock.t += 1000;

    const other = Buffer.from("hello-pdf");
    const replaceMp = multipart(
      { updatedAt: String(m.updatedAt) },
      { name: "b.pdf", type: "application/pdf", body: other },
    );
    const replaced = await app.inject({
      method: "POST",
      url: `/api/v1/materials/${m.id}/file`,
      headers: { cookie, ...replaceMp.headers },
      payload: replaceMp.payload,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().data.originalFilename).toBe("b.pdf");
    expect(replaced.json().data.isImage).toBe(false);

    s3Calls.length = 0;
    clock.t += 1000;
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/materials/${m.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);
    expect(s3Calls.some((c) => c.method === "DELETE")).toBe(true);

    const row = tmp.sqlite
      .prepare("SELECT deleted_at, kind FROM delivery_materials WHERE id = ?")
      .get(m.id) as { deleted_at: number; kind: string };
    expect(row.deleted_at).toBe(clock.t);
    expect(row.kind).toBe("file");
  });

  it("PATCH 不能把文本改成 file / file 改成文本", async () => {
    const { cookie } = await loginAsRole("admin");
    await enableStorage(cookie);
    const text = await app.inject({
      method: "POST",
      url: "/api/v1/materials",
      headers: { cookie },
      payload: { kind: "text", title: "纪要" },
    });
    const t = text.json().data;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/materials/${t.id}`,
          headers: { cookie },
          payload: { kind: "file", updatedAt: t.updatedAt },
        })
      ).statusCode,
    ).toBe(422);

    const mp = multipart({ title: "截图" }, { name: "a.png", type: "image/png", body: PNG_1x1 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/materials/upload",
      headers: { cookie, ...mp.headers },
      payload: mp.payload,
    });
    const f = created.json().data;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/materials/${f.id}`,
          headers: { cookie },
          payload: { kind: "text", updatedAt: f.updatedAt },
        })
      ).statusCode,
    ).toBe(422);
  });
});
