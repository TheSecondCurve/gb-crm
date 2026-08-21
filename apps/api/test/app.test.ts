import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { testEnv } from "./helpers/auth.js";
import { createTmpDb, type TmpDb } from "./helpers/tmp-db.js";

let tmp: TmpDb;

beforeEach(() => {
  tmp = createTmpDb();
});

afterEach(() => {
  tmp.cleanup();
});

describe("app shell", () => {
  it("GET /api/v1/health 免登录，返回 { data: { ok: true } }", async () => {
    const app = buildApp({ env: testEnv(), db: tmp.db, gcProbability: 0 });
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { ok: true } });
      // helmet 安全头已生效
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      await app.close();
    }
  });

  it("未登录访问 /api/v1/** → 401 UNAUTHORIZED 信封", async () => {
    const app = buildApp({ env: testEnv(), db: tmp.db, gcProbability: 0 });
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/users" });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    } finally {
      await app.close();
    }
  });

  it("非 /api 路径 → 404 NOT_FOUND 信封", async () => {
    const app = buildApp({ env: testEnv(), db: tmp.db, gcProbability: 0 });
    try {
      const res = await app.inject({ method: "GET", url: "/anything" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "资源不存在" } });
    } finally {
      await app.close();
    }
  });
});
