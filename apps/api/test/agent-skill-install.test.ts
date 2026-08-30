import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { renderSkillInstallScript } from "../src/modules/agent/skill-install.js";
import { seedUser, testEnv } from "./helpers/auth.js";
import { createTmpDb, type TmpDb } from "./helpers/tmp-db.js";

let tmp: TmpDb;
let clock: { t: number };
let app: FastifyInstance;

beforeEach(() => {
  tmp = createTmpDb();
  clock = { t: 1_800_000_000_000 };
  app = buildApp({ env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0 });
});

afterEach(async () => {
  await app.close();
  tmp.cleanup();
});

describe("渠道 A：/agent/skill/gb-crm/* 下发", () => {
  it("install.sh：200 + shell 类型 + 注入 Host 作 baseUrl + 指向 skill 端点", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent/skill/gb-crm/install.sh",
      headers: { host: "crm.internal:3001" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/x-shellscript");
    expect(res.body).toContain("http://crm.internal:3001");
    expect(res.body).toContain("/agent/skill/gb-crm"); // SKILL_BASE 来源
    expect(res.body).toContain("gb-crm.py");
    expect(res.body).toContain("/agent/login.sh");
  });

  it("非法 Host 不写入脚本（防注入），回退本地默认", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent/skill/gb-crm/install.sh",
      headers: { host: "evil.com; rm -rf /" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("rm -rf");
    expect(res.body).toContain("http://127.0.0.1:3001");
  });

  it("renderSkillInstallScript 拒绝非 http(s) URL", () => {
    const script = renderSkillInstallScript("javascript:alert(1)");
    expect(script).toContain("http://127.0.0.1:3001");
    expect(script).not.toContain("javascript:");
  });

  it("SKILL.md：200 + markdown 类型 + 含技能标识", async () => {
    const res = await app.inject({ method: "GET", url: "/agent/skill/gb-crm/SKILL.md" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body).toContain("gb-crm");
  });

  it("scripts/gb-crm.py：200 + python 类型 + 含凭证路径", async () => {
    const res = await app.inject({ method: "GET", url: "/agent/skill/gb-crm/scripts/gb-crm.py" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/x-python");
    expect(res.body).toContain("credentials.json");
  });

  it("端到端：安装器在临时 HOME 里安装 skill 并授权（用户名/密码）", async () => {
    await seedUser(tmp.db);
    const listening = buildApp({
      env: testEnv(),
      db: tmp.db,
      now: () => clock.t,
      gcProbability: 0,
    });
    await listening.listen({ host: "127.0.0.1", port: 0 });
    const addr = listening.server.address();
    if (addr === null || typeof addr === "string") throw new Error("expected tcp address");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gb-crm-skill-home-"));

    try {
      const script = await listening.inject({
        method: "GET",
        url: "/agent/skill/gb-crm/install.sh",
        headers: { host: `127.0.0.1:${addr.port}` },
      });
      const installerPath = path.join(home, "install.sh");
      fs.writeFileSync(installerPath, script.body, { mode: 0o700 });

      // 非交互：用 env 给用户名/密码/范围；HOME 指向临时目录
      const { stdout } = await execFileAsync("sh", [installerPath], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          GB_CRM_USERNAME: "alice",
          GB_CRM_PASSWORD: "password123",
          GB_CRM_SCOPE: "read",
          http_proxy: "",
          https_proxy: "",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          NO_PROXY: "*",
        },
        encoding: "utf8",
        timeout: 30_000,
      });

      const skillDir = path.join(home, ".agents", "skills", "gb-crm");
      expect(stdout).toContain("skill 已安装");
      const sk = fs.statSync(path.join(skillDir, "SKILL.md"));
      expect(sk.isFile()).toBe(true);
      expect(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8")).toContain("gb-crm");
      const py = path.join(skillDir, "scripts", "gb-crm.py");
      expect(fs.existsSync(py)).toBe(true);
      expect(fs.statSync(py).mode & 0o111).not.toBe(0); // 可执行

      // 授权凭证已写入
      const cred = JSON.parse(fs.readFileSync(path.join(home, ".gb-crm", "credentials.json"), "utf8")) as {
        baseUrl: string;
        token: string;
        scope: string;
        username: string;
      };
      expect(cred).toMatchObject({ baseUrl, scope: "read", username: "alice" });
      expect(cred.token).toMatch(/^gbcrm_ro_[0-9a-f]{64}$/);
      expect(fs.statSync(path.join(home, ".gb-crm", "credentials.json")).mode & 0o777).toBe(0o600);

      // 用该凭证能调 /auth/me
      const me = await listening.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${cred.token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().data.username).toBe("alice");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      await listening.close();
    }
  });
});
