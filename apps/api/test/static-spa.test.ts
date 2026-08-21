// static-spa（K20）：production 托管 web dist；非 /api 且非静态文件的 GET → index.html。
// 用临时目录模拟 dist，避免依赖 apps/web 真实构建产物。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loginAs, seedUser, testEnv } from "./helpers/auth.js";
import { createTmpDb, type TmpDb } from "./helpers/tmp-db.js";

let tmp: TmpDb;
let distDir: string;

beforeEach(() => {
  tmp = createTmpDb();
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-crm-dist-"));
  fs.mkdirSync(path.join(distDir, "assets"));
  fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><html><body>gb-crm</body></html>");
  fs.writeFileSync(path.join(distDir, "assets", "xx.js"), "console.log('xx');\n");
});

afterEach(() => {
  tmp.cleanup();
  fs.rmSync(distDir, { recursive: true, force: true });
});

const prodEnv = () => testEnv({ NODE_ENV: "production" });

describe("static-spa（production）", () => {
  it("GET /customers（非 /api、非静态文件）→ 200 index.html", async () => {
    const app = buildApp({ env: prodEnv(), db: tmp.db, webDist: distDir, gcProbability: 0 });
    try {
      const res = await app.inject({ method: "GET", url: "/customers" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("gb-crm");
    } finally {
      await app.close();
    }
  });

  it("GET / 与已存在的静态文件 /assets/xx.js → 按文件提供", async () => {
    const app = buildApp({ env: prodEnv(), db: tmp.db, webDist: distDir, gcProbability: 0 });
    try {
      const root = await app.inject({ method: "GET", url: "/" });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain("gb-crm");

      const js = await app.inject({ method: "GET", url: "/assets/xx.js" });
      expect(js.statusCode).toBe(200);
      expect(js.body).toContain("console.log('xx')");
      expect(js.headers["content-type"]).toContain("javascript");
    } finally {
      await app.close();
    }
  });

  it("GET /api/v1/nope（已登录）→ 404 JSON 错误信封，不是 html", async () => {
    const app = buildApp({ env: prodEnv(), db: tmp.db, webDist: distDir, gcProbability: 0 });
    try {
      await seedUser(tmp.db);
      const cookie = await loginAs(app, "alice", "password123");
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/nope",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "资源不存在" } });
      // 未登录时 /api/* 由 session-auth 拦为 401，同样不是 html
      const anon = await app.inject({ method: "GET", url: "/api/v1/nope" });
      expect(anon.statusCode).toBe(401);
      expect(anon.headers["content-type"]).toContain("application/json");
    } finally {
      await app.close();
    }
  });

  it("POST /customers（非 GET）不 fallback → 404 JSON 信封", async () => {
    const app = buildApp({ env: prodEnv(), db: tmp.db, webDist: distDir, gcProbability: 0 });
    try {
      const res = await app.inject({ method: "POST", url: "/customers" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json().error.code).toBe("NOT_FOUND");
    } finally {
      await app.close();
    }
  });

  it("GET /agent/login.sh 是已注册路由，不 fallback 成 index.html", async () => {
    const app = buildApp({ env: prodEnv(), db: tmp.db, webDist: distDir, gcProbability: 0 });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/agent/login.sh",
        headers: { host: "crm.internal:3001" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/x-shellscript");
      expect(res.body).toContain("http://crm.internal:3001");
      expect(res.body).not.toContain("gb-crm</body>");
    } finally {
      await app.close();
    }
  });

  it("非 production 不注册静态托管：GET /customers 仍是 404 JSON 信封", async () => {
    const app = buildApp({ env: testEnv(), db: tmp.db, gcProbability: 0 });
    try {
      const res = await app.inject({ method: "GET", url: "/customers" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    } finally {
      await app.close();
    }
  });
});
