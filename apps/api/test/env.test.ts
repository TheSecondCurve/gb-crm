import { describe, expect, it } from "vitest";

import { parseAppEnv, parseScriptEnv } from "../src/env.js";

describe("env", () => {
  it("script env parses with defaults and does not require SESSION_SECRET", () => {
    const env = parseScriptEnv({});
    expect(env.DATABASE_PATH).toBe("./data/gb-crm.sqlite");
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe(3001);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.FEISHU_BASE_TOKEN).toBe("IWFEbuZcfalvQus6vkOcJXUjn2d");
  });

  it("app env requires SESSION_SECRET of at least 32 chars", () => {
    expect(() => parseAppEnv({})).toThrow();
    expect(() => parseAppEnv({ SESSION_SECRET: "short" })).toThrow();
    const env = parseAppEnv({ SESSION_SECRET: "x".repeat(32), PORT: "4000" });
    expect(env.SESSION_SECRET).toHaveLength(32);
    expect(env.PORT).toBe(4000);
  });
});
