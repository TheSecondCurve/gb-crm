// e2e 公共夹具。
// - 种子常量同源 re-export（单一来源在 apps/api/scripts/e2e-seed-data.ts，种子脚本与用例共用，防字面量漂移）。
// - 登录限流 10 次/分钟/IP：每个角色按 worker 只登录一次（storageState 复用），
//   需要「真实再走一遍登录」的用例（登录失败/停用拦截/登出守卫）仍用 login() 助手。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base, type Browser, type Page } from "@playwright/test";

import { E2E_ADMIN, E2E_ASSISTANT, E2E_OPERATOR } from "../apps/api/scripts/e2e-seed-data.js";

const e2eRoot = path.dirname(fileURLToPath(import.meta.url));

export * from "../apps/api/scripts/e2e-seed-data.js";

export { expect };

type WorkerFixtures = {
  adminStorage: string;
  assistantStorage: string;
  operatorStorage: string;
};
type TestFixtures = {
  adminPage: Page;
  assistantPage: Page;
  operatorPage: Page;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // worker 级：登录一次，storageState 落盘 e2e/.tmp/（gitignored）
  adminStorage: [
    async ({ browser }, use, workerInfo) => {
      await use(await loginOnce(browser, workerInfo.workerIndex, "admin", "admin", "admin-e2e-password"));
    },
    { scope: "worker" },
  ],
  assistantStorage: [
    async ({ browser }, use, workerInfo) => {
      await use(
        await loginOnce(browser, workerInfo.workerIndex, "assistant", "assistant", "assistant-e2e-pass"),
      );
    },
    { scope: "worker" },
  ],
  operatorStorage: [
    async ({ browser }, use, workerInfo) => {
      await use(
        await loginOnce(browser, workerInfo.workerIndex, "operator", "operator", "operator-e2e-pass"),
      );
    },
    { scope: "worker" },
  ],

  // 会话自愈：同 worker 所有上下文共享一份 storageState（同一 session 行）。
  // 任一用例 logout / 改密 / 停用都会把这个共享 session 作废，后续用例会连锁 401。
  // 每个测试上下文创建后先探活 /auth/me，失效则在本上下文内重新登录（拿到新 session）。
  adminPage: async ({ browser, adminStorage }, use) => {
    const ctx = await browser.newContext({ storageState: adminStorage });
    try {
      const page = await ctx.newPage();
      await ensureAuthed(page, E2E_ADMIN.username, E2E_ADMIN.password);
      await use(page);
    } finally {
      await ctx.close();
    }
  },
  assistantPage: async ({ browser, assistantStorage }, use) => {
    const ctx = await browser.newContext({ storageState: assistantStorage });
    try {
      const page = await ctx.newPage();
      await ensureAuthed(page, E2E_ASSISTANT.username, E2E_ASSISTANT.password);
      await use(page);
    } finally {
      await ctx.close();
    }
  },
  operatorPage: async ({ browser, operatorStorage }, use) => {
    const ctx = await browser.newContext({ storageState: operatorStorage });
    try {
      const page = await ctx.newPage();
      await ensureAuthed(page, E2E_OPERATOR.username, E2E_OPERATOR.password);
      await use(page);
    } finally {
      await ctx.close();
    }
  },
});

/** storageState 里的共享 session 可能已被 logout/改密作废 → 探活并必要时真实重登 */
async function ensureAuthed(page: Page, username: string, password: string): Promise<void> {
  const res = await page.request.get("/api/v1/auth/me");
  if (res.status() !== 200) await login(page, username, password);
}

async function loginOnce(
  browser: Browser,
  workerIndex: number,
  key: string,
  username: string,
  password: string,
): Promise<string> {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto("/login");
    await page.getByLabel("用户名").fill(username);
    await page.getByLabel("密码").fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.locator(".app-header")).toBeVisible();
    const dir = path.join(e2eRoot, ".tmp");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `auth-${key}-${workerIndex}.json`);
    await ctx.storageState({ path: file });
    return file;
  } finally {
    await ctx.close();
  }
}

/** UI 登录（走真实登录页）：仅用于必须真实登录流程的用例（失败/拦截/登出） */
export async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".app-header")).toBeVisible();
}

/** 顶部右上角退出登录，断言回到登录页 */
export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Toast 容器（role=status）内断言指定文案出现 */
export function toast(page: Page) {
  return page.locator(".toast-list");
}

export async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  await expect(toast(page).getByText(text)).toBeVisible();
}

/**
 * 按昵称单元格精确匹配表格行。
 * 不要用 getByRole("row", { name: /昵称/ })——「e2e种子客户」是「e2e种子客户二」的子串，会撞歧义。
 */
export function rowByNickname(page: Page, nickname: string) {
  return page.getByRole("row").filter({
    has: page.locator('[data-cell$=":nickname"]', {
      hasText: new RegExp(`^\\s*${nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`),
    }),
  });
}
