// K63 素材 AI 识别：assetsLlm 配置端点（掩码/回退/测试）+ 上传调度矩阵
//（pending/skipped·未配置/skipped·超限/aiEnrich=false 不动）+ enrich 执行
//（描述填空/标签并集/归档现有文件夹/AI 不建目录/失败 failed 可重跑）+ 重跑端点 RBAC。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { createJobRunner } from "../../src/modules/jobs/runner.js";
import { loginAs, seedUser, testEnv } from "../helpers/auth.js";
import { createTmpDb, type TmpDb } from "../helpers/tmp-db.js";

let tmp: TmpDb;
let clock: { t: number };
let app: FastifyInstance;
/** S3 调用记录；GET 回 PNG_1x1 */
let s3Calls: { method: string; url: string }[];
/** LLM 请求体记录（验证 multimodal content 数组与 data URL） */
let llmBodies: { model: string; messages: unknown[] }[];
let llmResponse: () => unknown;
let makeRunner: () => ReturnType<typeof createJobRunner>;

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

const ASSETS_LLM_FULL = {
  provider: "openai-compat",
  baseUrl: "https://llm.example.com/v1",
  model: "glm-4.6v",
  apiKey: "sk-assets-test-key",
};

beforeEach(() => {
  tmp = createTmpDb();
  clock = { t: Date.now() };
  s3Calls = [];
  llmBodies = [];
  llmResponse = () => ({
    choices: [
      {
        message: {
          content:
            '{"description":"现场大合影，暖色灯光，横幅写着下午茶活动，竖版手机拍摄","tags":["现场图","合影"],"folder":"活动素材/下午茶"}',
        },
      },
    ],
  });
  const s3Fetch = vi.fn(async (url: unknown, init?: unknown) => {
    const method = String((init as RequestInit | undefined)?.method ?? "GET");
    s3Calls.push({ method, url: String(url) });
    if (method === "GET") {
      return new Response(PNG_1x1, { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const llmFetch = vi.fn(async (url: unknown, init?: unknown) => {
    llmBodies.push(JSON.parse(String((init as RequestInit).body)));
    return new Response(JSON.stringify(llmResponse()), { status: 200 });
  }) as unknown as typeof fetch;
  // job runner 共用注入：按 URL 分发（enrich 任务里 S3 GET 与 LLM POST 走同一 ctx.fetchFn）
  const jobFetch = vi.fn(async (url: unknown, init?: unknown) => {
    const target = String(url);
    const args = [target, init] as Parameters<typeof fetch>;
    return target.includes("llm.example.com") ? llmFetch(...args) : s3Fetch(...args);
  }) as unknown as typeof fetch;
  app = buildApp({
    env: testEnv(),
    db: tmp.db,
    now: () => clock.t,
    gcProbability: 0,
    s3Fetch,
    llmFetch,
  });
  makeRunner = () => createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn: jobFetch });
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

function multipart(fields: Record<string, string>, file: { name: string; type: string; body: Buffer }) {
  const boundary = "----GbCrmTestBoundary";
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
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

async function configureAssetsLlm(cookie: string) {
  const res = await app.inject({
    method: "PATCH",
    url: "/api/v1/system/assets-llm-config",
    headers: { cookie },
    payload: ASSETS_LLM_FULL,
  });
  expect(res.statusCode).toBe(200);
}

async function upload(cookie: string, fields: Record<string, string> = {}) {
  const mp = multipart(
    { title: "现场图", ...fields },
    { name: "photo.png", type: "image/png", body: PNG_1x1 },
  );
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/materials/upload",
    headers: { cookie, ...mp.headers },
    payload: mp.payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Material = any;

describe("assets-llm-config 端点（K63）", () => {
  it("GET 缺省 not ready；PATCH 保存后 dedicatedReady + 掩码；operator 403", async () => {
    const admin = await loginAsRole("admin");
    const before = await app.inject({
      method: "GET",
      url: "/api/v1/system/assets-llm-config",
      headers: { cookie: admin.cookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().data.dedicatedReady).toBe(false);

    await configureAssetsLlm(admin.cookie);
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/system/assets-llm-config",
      headers: { cookie: admin.cookie },
    });
    expect(after.json().data.dedicatedReady).toBe(true);
    expect(after.json().data.model).toBe("glm-4.6v");
    expect(after.json().data.apiKeyMasked).not.toContain("sk-assets-test-key");

    const op = await loginAsRole("operator");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/system/assets-llm-config",
          headers: { cookie: op.cookie },
          payload: ASSETS_LLM_FULL,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("test 探测：未配置 422；配置后 ok（走 llmFetch mock）", async () => {
    const admin = await loginAsRole("admin");
    const noCfg = await app.inject({
      method: "POST",
      url: "/api/v1/system/assets-llm-config/test",
      headers: { cookie: admin.cookie },
      payload: {},
    });
    expect(noCfg.statusCode).toBe(422);

    await configureAssetsLlm(admin.cookie);
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/system/assets-llm-config/test",
      headers: { cookie: admin.cookie },
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({ ok: true });
  });
});

describe("上传调度矩阵（scheduleMaterialEnrich）", () => {
  it("图片 + LLM 配置 → aiStatus=pending 且入队；跑 job → ready，描述/标签/归档落库", async () => {
    const admin = await loginAsRole("admin");
    await enableStorage(admin.cookie);
    await configureAssetsLlm(admin.cookie);
    // 预建文件夹，让 LLM 的 folder 建议可匹配
    await app.inject({
      method: "POST",
      url: "/api/v1/material-folders",
      headers: { cookie: admin.cookie },
      payload: { name: "活动素材" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/material-folders",
      headers: { cookie: admin.cookie },
      payload: { name: "下午茶", parentId: 1 },
    });

    const body = await upload(admin.cookie);
    expect(body.data.aiStatus).toBe("pending");

    const runner = makeRunner();
    const job = await runner.pumpOnce();
    expect(job?.type).toBe("material-ai-enrich");
    const jobFinal = await app.inject({
      method: "GET",
      url: `/api/v1/background-jobs/${job!.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(jobFinal.json().data.status).toBe("succeeded");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/materials/${body.data.id}`,
      headers: { cookie: admin.cookie },
    });
    const m: Material = detail.json().data;
    expect(m.aiStatus).toBe("ready");
    expect(m.enrichedAt).toBe(clock.t);
    expect(m.description).toContain("大合影");
    expect(m.tags.map((t: { name: string }) => t.name).sort()).toEqual(["合影", "现场图"]);
    expect(m.folder).toMatchObject({ path: "活动素材/下午茶" });

    // multimodal 请求形态：user content 是数组，带 image_url data:
    const last = llmBodies.at(-1)!;
    const userMsg = (last.messages as { role: string; content: unknown }[]).find(
      (x) => x.role === "user",
    )!;
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as { type: string; image_url?: { url: string } }[];
    expect(parts.some((p) => p.type === "image_url" && p.image_url!.url.startsWith("data:image/"))).toBe(
      true,
    );
  });

  it("人写的描述不被 AI 覆盖；已有标签并集；未归档才接受 folder", async () => {
    const admin = await loginAsRole("admin");
    await enableStorage(admin.cookie);
    await configureAssetsLlm(admin.cookie);
    const body = await upload(admin.cookie, {
      description: "运营手写的关键描述",
      newTagNames: '["手选标签"]',
    });

    const runner = makeRunner();
    await runner.pumpOnce();

    const m = (await app.inject({
      method: "GET",
      url: `/api/v1/materials/${body.data.id}`,
      headers: { cookie: admin.cookie },
    })).json().data;
    expect(m.description).toBe("运营手写的关键描述");
    const names = m.tags.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["合影", "手选标签", "现场图"]);
    // LLM 建议的 folder「活动素材/下午茶」不存在 → 不建目录、保持未分类
    expect(m.folder).toBeNull();
    const folders = await app.inject({
      method: "GET",
      url: "/api/v1/material-folders",
      headers: { cookie: admin.cookie },
    });
    expect(folders.json().data).toHaveLength(0);
  });

  it("LLM 未配置 → skipped（上传成功不受影响）；配置后再重跑 → ready", async () => {
    const admin = await loginAsRole("admin");
    await enableStorage(admin.cookie);
    const body = await upload(admin.cookie);
    expect(body.data.aiStatus).toBe("skipped");

    // 重跑端点此时 422（显式请求要报错）
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/materials/${body.data.id}/enrich`,
      headers: { cookie: admin.cookie },
    });
    expect(denied.statusCode).toBe(422);

    await configureAssetsLlm(admin.cookie);
    const rerun = await app.inject({
      method: "POST",
      url: `/api/v1/materials/${body.data.id}/enrich`,
      headers: { cookie: admin.cookie },
    });
    expect(rerun.statusCode).toBe(200);
    expect(rerun.json().data.aiStatus).toBe("pending");

    const runner = makeRunner();
    await runner.pumpOnce();
    const m = (await app.inject({
      method: "GET",
      url: `/api/v1/materials/${body.data.id}`,
      headers: { cookie: admin.cookie },
    })).json().data;
    expect(m.aiStatus).toBe("ready");
  });

  it("aiEnrich=false → 不入队不动状态；aiStatus=failed 的资料重跑端点重置 pending", async () => {
    const admin = await loginAsRole("admin");
    await enableStorage(admin.cookie);
    await configureAssetsLlm(admin.cookie);
    const body = await upload(admin.cookie, { aiEnrich: "false" });
    expect(body.data.aiStatus).toBeNull();

    // 模拟一次失败（LLM 挂掉）
    llmResponse = () => {
      throw new Error("boom");
    };
    const rerun = await app.inject({
      method: "POST",
      url: `/api/v1/materials/${body.data.id}/enrich`,
      headers: { cookie: admin.cookie },
    });
    expect(rerun.statusCode).toBe(200);
    const runner = makeRunner();
    const job = await runner.pumpOnce();
    const jobFinal = await app.inject({
      method: "GET",
      url: `/api/v1/background-jobs/${job!.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(jobFinal.json().data.status).toBe("failed");
    const m = (await app.inject({
      method: "GET",
      url: `/api/v1/materials/${body.data.id}`,
      headers: { cookie: admin.cookie },
    })).json().data;
    expect(m.aiStatus).toBe("failed");

    // LLM 恢复后重跑 → ready
    llmResponse = () => ({
      choices: [{ message: { content: '{"description":"恢复后的描述","tags":["现场图"],"folder":null}' } }],
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/materials/${body.data.id}/enrich`,
      headers: { cookie: admin.cookie },
    });
    await runner.pumpOnce();
    const m2 = (await app.inject({
      method: "GET",
      url: `/api/v1/materials/${body.data.id}`,
      headers: { cookie: admin.cookie },
    })).json().data;
    expect(m2.aiStatus).toBe("ready");
    expect(m2.description).toBe("恢复后的描述");
  });

  it("非图片上传 → aiStatus=null；文本资料手动 enrich 422；RBAC assistant 403", async () => {
    const admin = await loginAsRole("admin");
    await enableStorage(admin.cookie);
    await configureAssetsLlm(admin.cookie);
    const doc = Buffer.from("%PDF-1.4 pretend");
    const mp = multipart({ title: "讲义" }, { name: "a.pdf", type: "application/pdf", body: doc });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/materials/upload",
      headers: { cookie: admin.cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.aiStatus).toBeNull();

    const text = await app.inject({
      method: "POST",
      url: "/api/v1/materials",
      headers: { cookie: admin.cookie },
      payload: { kind: "text", title: "纪要", content: "正文" },
    });
    const textId = text.json().data.id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/materials/${textId}/enrich`,
          headers: { cookie: admin.cookie },
        })
      ).statusCode,
    ).toBe(422);

    const asst = await loginAsRole("assistant");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/materials/${textId}/enrich`,
          headers: { cookie: asst.cookie },
        })
      ).statusCode,
    ).toBe(403);
  });
});
