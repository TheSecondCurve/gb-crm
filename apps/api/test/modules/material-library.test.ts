// K63 素材库：material_folders CRUD（同级唯一/跨级重名/移动防环/仅空可删）+
// 资料 description/folderId/folderPath（自动建链）+ 列表过滤（folderId/folderPath/tagIds AND/
// tagNames/checksum/aiStatus）+ FTS 索引 description。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

async function loginAsRole(
  role: "admin" | "operator" | "assistant",
  username = `u-${role}`,
): Promise<{ id: number; cookie: string }> {
  const id = await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  const cookie = await loginAs(app, username, "password123");
  return { id, cookie };
}

type JsonBody = Record<string, unknown>;

const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload?: JsonBody) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
const patch = (url: string, cookie: string, payload: JsonBody) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });
const del = (url: string, cookie: string) => app.inject({ method: "DELETE", url, headers: { cookie } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Folder = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Material = any;

async function createFolder(cookie: string, payload: JsonBody): Promise<Folder> {
  const res = await post("/api/v1/material-folders", cookie, payload);
  expect(res.statusCode).toBe(201);
  return res.json().data;
}

async function createMaterial(cookie: string, payload: JsonBody): Promise<Material> {
  const res = await post("/api/v1/materials", cookie, payload);
  expect(res.statusCode).toBe(201);
  return res.json().data;
}

const TEXT = { kind: "text", title: "咨询纪要", content: "全文正文。" };

describe("material-folders CRUD（K63）", () => {
  it("建根/子文件夹；path 推导；materialCount 直接计数", async () => {
    const admin = await loginAsRole("admin");
    const root = await createFolder(admin.cookie, { name: "活动素材" });
    expect(root.parentId).toBeNull();
    expect(root.path).toBe("活动素材");
    expect(root.materialCount).toBe(0);

    const child = await createFolder(admin.cookie, { name: "下午茶", parentId: root.id });
    expect(child.path).toBe("活动素材/下午茶");

    await createMaterial(admin.cookie, { ...TEXT, folderId: child.id });
    await createMaterial(admin.cookie, { ...TEXT, title: "根下另一份", folderId: root.id });

    const list = await get("/api/v1/material-folders", admin.cookie);
    expect(list.statusCode).toBe(200);
    const byId = new Map<number, Folder>(list.json().data.map((f: Folder) => [f.id, f]));
    expect(byId.get(child.id)!.materialCount).toBe(1);
    expect(byId.get(root.id)!.materialCount).toBe(1); // 直接计数，不含子文件夹
  });

  it("同级重名 409；跨级同名 201；软删后名字可复用", async () => {
    const admin = await loginAsRole("admin");
    const root = await createFolder(admin.cookie, { name: "根A" });
    expect((await post("/api/v1/material-folders", admin.cookie, { name: "根A" })).statusCode).toBe(409);
    expect(
      (await post("/api/v1/material-folders", admin.cookie, { name: "根A", parentId: root.id })).statusCode,
    ).toBe(201);
  });

  it("改名/移动；OCC 409；改到不存在父 422；名字带 / 422", async () => {
    const admin = await loginAsRole("admin");
    const root = await createFolder(admin.cookie, { name: "根" });
    const f = await createFolder(admin.cookie, { name: "旧名", parentId: root.id });

    clock.t += 1000;
    const renamed = await patch(`/api/v1/material-folders/${f.id}`, admin.cookie, {
      name: "新名",
      updatedAt: f.updatedAt,
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data.path).toBe("根/新名");

    // 陈旧 updatedAt → 409
    const stale = await patch(`/api/v1/material-folders/${f.id}`, admin.cookie, {
      name: "再改",
      updatedAt: f.updatedAt,
    });
    expect(stale.statusCode).toBe(409);

    // 不存在父 → 422
    const cur = (await get(`/api/v1/material-folders/${f.id}`, admin.cookie)).json().data;
    expect(
      (
        await patch(`/api/v1/material-folders/${f.id}`, admin.cookie, {
          parentId: 99999,
          updatedAt: cur.updatedAt,
        })
      ).statusCode,
    ).toBe(422);

    // 名字带 / → 422
    expect(
      (
        await patch(`/api/v1/material-folders/${f.id}`, admin.cookie, {
          name: "a/b",
          updatedAt: cur.updatedAt,
        })
      ).statusCode,
    ).toBe(422);
  });

  it("移动到根；移动到兄弟；移动到自己后代 → 422", async () => {
    const admin = await loginAsRole("admin");
    const root = await createFolder(admin.cookie, { name: "根" });
    const a = await createFolder(admin.cookie, { name: "A", parentId: root.id });
    const b = await createFolder(admin.cookie, { name: "B", parentId: root.id });
    const a1 = await createFolder(admin.cookie, { name: "A1", parentId: a.id });

    // 移 A1 到 B 下
    clock.t += 1000;
    const moved = await patch(`/api/v1/material-folders/${a1.id}`, admin.cookie, {
      parentId: b.id,
      updatedAt: a1.updatedAt,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().data.path).toBe("根/B/A1");

    // A1 已移出 A 的子树：A 移入 A1 合法（不构成环）
    expect(
      (
        await patch(`/api/v1/material-folders/${a.id}`, admin.cookie, {
          parentId: a1.id,
          updatedAt: a.updatedAt,
        })
      ).statusCode,
    ).toBe(200);
    // 移回原位（根下），重建 A→A2 结构用于环测试
    const aNow = (await get(`/api/v1/material-folders/${a.id}`, admin.cookie)).json().data;
    clock.t += 1000;
    await patch(`/api/v1/material-folders/${a.id}`, admin.cookie, {
      parentId: root.id,
      updatedAt: aNow.updatedAt,
    });
    const a2 = await createFolder(admin.cookie, { name: "A2", parentId: a.id });

    // 移 A 到自己的后代 A2 下 → 422
    expect(
      (
        await patch(`/api/v1/material-folders/${a.id}`, admin.cookie, {
          parentId: a2.id,
          updatedAt: (await get(`/api/v1/material-folders/${a.id}`, admin.cookie)).json().data.updatedAt,
        })
      ).statusCode,
    ).toBe(422);

    // 移回根（parentId: null）
    clock.t += 1000;
    const toRoot = await patch(`/api/v1/material-folders/${b.id}`, admin.cookie, {
      parentId: null,
      updatedAt: b.updatedAt,
    });
    expect(toRoot.statusCode).toBe(200);
    expect(toRoot.json().data.path).toBe("B");
  });

  it("仅空文件夹可删：有直接资料 409 带计数；有子文件夹 409；清空后可删", async () => {
    const admin = await loginAsRole("admin");
    const root = await createFolder(admin.cookie, { name: "根" });
    const m = await createMaterial(admin.cookie, { ...TEXT, folderId: root.id });

    const blocked = await del(`/api/v1/material-folders/${root.id}`, admin.cookie);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain("资料");

    const child = await createFolder(admin.cookie, { name: "子", parentId: root.id });
    // 先移走资料
    clock.t += 1000;
    await patch(`/api/v1/materials/${m.id}`, admin.cookie, {
      folderId: null,
      updatedAt: m.updatedAt,
    });
    const blocked2 = await del(`/api/v1/material-folders/${root.id}`, admin.cookie);
    expect(blocked2.statusCode).toBe(409);

    expect((await del(`/api/v1/material-folders/${child.id}`, admin.cookie)).statusCode).toBe(204);
    clock.t += 1000;
    expect((await del(`/api/v1/material-folders/${root.id}`, admin.cookie)).statusCode).toBe(204);
    expect((await del(`/api/v1/material-folders/${root.id}`, admin.cookie)).statusCode).toBe(404);
  });

  it("RBAC：assistant 只读（create/patch/delete 403）；operator 可写", async () => {
    const admin = await loginAsRole("admin");
    const folder = await createFolder(admin.cookie, { name: "共享" });

    const asst = await loginAsRole("assistant");
    expect((await get("/api/v1/material-folders", asst.cookie)).statusCode).toBe(200);
    expect((await post("/api/v1/material-folders", asst.cookie, { name: "x" })).statusCode).toBe(403);
    expect(
      (
        await patch(`/api/v1/material-folders/${folder.id}`, asst.cookie, {
          name: "y",
          updatedAt: folder.updatedAt,
        })
      ).statusCode,
    ).toBe(403);
    expect((await del(`/api/v1/material-folders/${folder.id}`, asst.cookie)).statusCode).toBe(403);

    const op = await loginAsRole("operator");
    expect((await post("/api/v1/material-folders", op.cookie, { name: "运营建的" })).statusCode).toBe(201);
  });
});

describe("资料 description / 文件夹归档（K63）", () => {
  it("folderPath 自动建链（逐级缺则建、幂等）；优先级高于 folderId；folder 展开带 path", async () => {
    const admin = await loginAsRole("admin");
    const m1 = await createMaterial(admin.cookie, {
      ...TEXT,
      folderPath: "客户A/下午茶/现场图",
    });
    expect(m1.folder).toMatchObject({ name: "现场图", path: "客户A/下午茶/现场图" });

    // 再传同路径：复用不重建
    const m2 = await createMaterial(admin.cookie, { ...TEXT, title: "第二份", folderPath: "客户A/下午茶/现场图" });
    expect(m2.folder.id).toBe(m1.folder.id);
    const list = await get("/api/v1/material-folders", admin.cookie);
    expect(list.json().data).toHaveLength(3);

    // folderId + folderPath 同给：folderPath 赢
    const other = await createFolder(admin.cookie, { name: "别处" });
    const m3 = await createMaterial(admin.cookie, {
      ...TEXT,
      title: "第三份",
      folderId: other.id,
      folderPath: "客户A/下午茶",
    });
    expect(m3.folder.path).toBe("客户A/下午茶");
  });

  it("folderId 校验：不存在 422；PATCH 移动 folderId / null 回未分类；folderPath 在 PATCH 中被忽略", async () => {
    const admin = await loginAsRole("admin");
    expect(
      (await post("/api/v1/materials", admin.cookie, { ...TEXT, folderId: 99999 })).statusCode,
    ).toBe(422);

    const root = await createFolder(admin.cookie, { name: "归档" });
    const m = await createMaterial(admin.cookie, { ...TEXT, folderId: root.id });
    const other = await createFolder(admin.cookie, { name: "另一个" });

    clock.t += 1000;
    const moved = await patch(`/api/v1/materials/${m.id}`, admin.cookie, {
      folderId: other.id,
      updatedAt: m.updatedAt,
    });
    expect(moved.json().data.folder.path).toBe("另一个");

    clock.t += 1000;
    const cleared = await patch(`/api/v1/materials/${m.id}`, admin.cookie, {
      folderId: null,
      updatedAt: moved.json().data.updatedAt,
    });
    expect(cleared.json().data.folder).toBeNull();

    // folderPath 不是 PATCH 键：静默剥除（不建链）
    clock.t += 1000;
    const noop = await patch(`/api/v1/materials/${m.id}`, admin.cookie, {
      folderPath: "不该出现/的链",
      updatedAt: cleared.json().data.updatedAt,
    });
    expect(noop.statusCode).toBe(200);
    expect(noop.json().data.folder).toBeNull();
    const folders = await get("/api/v1/material-folders", admin.cookie);
    expect(folders.json().data.some((f: Folder) => f.name === "不该出现")).toBe(false);
  });

  it("description 保存并可被 q 搜到（FTS 含 description 列）", async () => {
    const admin = await loginAsRole("admin");
    const m = await createMaterial(admin.cookie, {
      ...TEXT,
      title: "无关键字的标题",
      description: "现场大合影，下午茶活动横幅清晰可见",
    });
    const detail = await get(`/api/v1/materials/${m.id}`, admin.cookie);
    expect(detail.json().data.description).toBe("现场大合影，下午茶活动横幅清晰可见");

    const hit = await get("/api/v1/materials?q=大合影", admin.cookie);
    expect(hit.json().data.map((r: Material) => r.id)).toContain(m.id);

    const miss = await get("/api/v1/materials?q=不存在的词组", admin.cookie);
    expect(miss.json().data).toHaveLength(0);
  });

  it("列表过滤：folderId / folderId=0（未分类）/ folderPath（未解析 → 空）", async () => {
    const admin = await loginAsRole("admin");
    const uncategorized = await createMaterial(admin.cookie, TEXT);
    const inFolder = await createMaterial(admin.cookie, {
      ...TEXT,
      title: "文件夹里的",
      folderPath: "活动/海报",
    });
    const inParent = await createMaterial(admin.cookie, {
      ...TEXT,
      title: "父文件夹里的",
      folderPath: "活动",
    });

    const byId = await get(`/api/v1/materials?folderId=${inFolder.folder.id}`, admin.cookie);
    expect(byId.json().data.map((r: Material) => r.id)).toEqual([inFolder.id]);

    const uncats = await get("/api/v1/materials?folderId=0", admin.cookie);
    expect(uncats.json().data.map((r: Material) => r.id)).toContain(uncategorized.id);
    expect(uncats.json().data.map((r: Material) => r.id)).not.toContain(inFolder.id);

    const byPath = await get("/api/v1/materials?folderPath=活动/海报", admin.cookie);
    expect(byPath.json().data.map((r: Material) => r.id)).toEqual([inFolder.id]);

    const noPath = await get("/api/v1/materials?folderPath=活动/不存在", admin.cookie);
    expect(noPath.json().meta.total).toBe(0);

    const rootPath = await get("/api/v1/materials?folderPath=活动", admin.cookie);
    expect(rootPath.json().data.map((r: Material) => r.id)).toEqual([inParent.id]);
  });

  it("标签过滤：tagIds 逗号 AND；tagNames 按名解析（未知名 → 空）", async () => {
    const admin = await loginAsRole("admin");
    const both = await createMaterial(admin.cookie, {
      ...TEXT,
      title: "两个标签",
      newTagNames: ["海报", "活动"],
    });
    const one = await createMaterial(admin.cookie, {
      ...TEXT,
      title: "一个标签",
      newTagNames: ["海报"],
    });

    const ids = (await get("/api/v1/materials?tagNames=海报,活动", admin.cookie))
      .json()
      .data.map((r: Material) => r.id);
    expect(ids).toEqual([both.id]);

    // 单名 = 等值（两个都命中）
    const single = (await get("/api/v1/materials?tagNames=海报", admin.cookie))
      .json()
      .data.map((r: Material) => r.id);
    expect(single).toContain(both.id);
    expect(single).toContain(one.id);

    const tagIdList = (await get("/api/v1/materials?tagNames=海报,活动", admin.cookie)).json().data;
    const [t1, t2] = tagIdList[0].tags.map((t: { id: number }) => t.id);
    const byIds = (await get(`/api/v1/materials?tagIds=${t1},${t2}`, admin.cookie))
      .json()
      .data.map((r: Material) => r.id);
    expect(byIds).toEqual([both.id]);

    const unknown = await get("/api/v1/materials?tagNames=海报,没有这个词", admin.cookie);
    expect(unknown.json().meta.total).toBe(0);

    expect((await get("/api/v1/materials?tagIds=abc", admin.cookie)).statusCode).toBe(422);
  });

  it("checksum / aiStatus 等值过滤", async () => {
    const admin = await loginAsRole("admin");
    const m = await createMaterial(admin.cookie, TEXT);
    const sha = "a".repeat(64);
    tmp.db.$client
      .prepare("UPDATE delivery_materials SET checksum = ?, ai_status = 'failed' WHERE id = ?")
      .run(sha, m.id);

    const bySha = await get(`/api/v1/materials?checksum=${sha}`, admin.cookie);
    expect(bySha.json().data.map((r: Material) => r.id)).toEqual([m.id]);
    const byShaUpper = await get(`/api/v1/materials?checksum=${"A".repeat(64)}`, admin.cookie);
    expect(byShaUpper.json().meta.total).toBe(0);

    const byStatus = await get("/api/v1/materials?aiStatus=failed", admin.cookie);
    expect(byStatus.json().data.map((r: Material) => r.id)).toEqual([m.id]);
    expect((await get("/api/v1/materials?aiStatus=bogus", admin.cookie)).statusCode).toBe(422);
  });
});
