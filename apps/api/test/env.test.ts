import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseAppEnv, parseScriptEnv } from "../src/env.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("env", () => {
  it("script env parses with defaults and does not require SESSION_SECRET", () => {
    const env = parseScriptEnv({});
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe(3001);
    expect(env.COOKIE_SECURE).toBe(false);
  });

  it("resolves relative DATABASE_PATH against the repo root, not the cwd", () => {
    // 本地 dev 脚本的 cwd 是 apps/api，默认 ./data 也必须落到仓库根的 data/ 下
    const env = parseScriptEnv({});
    expect(path.isAbsolute(env.DATABASE_PATH)).toBe(true);
    expect(env.DATABASE_PATH).toBe(path.join(repoRoot, "data", "gb-crm.sqlite"));

    const custom = parseScriptEnv({ DATABASE_PATH: "./tmp/x.sqlite" });
    expect(custom.DATABASE_PATH).toBe(path.join(repoRoot, "tmp", "x.sqlite"));
  });

  it("keeps absolute DATABASE_PATH and :memory: untouched", () => {
    expect(parseScriptEnv({ DATABASE_PATH: "/data/gb-crm.sqlite" }).DATABASE_PATH).toBe(
      "/data/gb-crm.sqlite",
    );
    expect(parseScriptEnv({ DATABASE_PATH: ":memory:" }).DATABASE_PATH).toBe(":memory:");
  });

  it("app env requires SESSION_SECRET of at least 32 chars", () => {
    expect(() => parseAppEnv({})).toThrow();
    expect(() => parseAppEnv({ SESSION_SECRET: "short" })).toThrow();
    const env = parseAppEnv({ SESSION_SECRET: "x".repeat(32), PORT: "4000" });
    expect(env.SESSION_SECRET).toHaveLength(32);
    expect(env.PORT).toBe(4000);
  });
});
