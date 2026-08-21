import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("app shell", () => {
  it("GET /api/v1/health returns { data: { ok: true } }", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { ok: true } });
    } finally {
      await app.close();
    }
  });
});
