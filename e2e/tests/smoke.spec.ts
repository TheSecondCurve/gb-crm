import { expect, test } from "@playwright/test";

// 种子账号/数据见 apps/api/scripts/e2e-seed.ts（run-server.sh 每次重建）
const ADMIN = { username: "admin", password: "admin-e2e-password" };
const ASSISTANT = { username: "assistant", password: "assistant-e2e-pass" };
const SEED_NICKNAME = "e2e种子客户";
const RENAMED = "e2e改名客户";
const DEAL_ORDER_NO = "E2E-ORD-001";

async function login(page: import("@playwright/test").Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/customers/);
}

test("admin：登录 → 客户可见 → 搜索 → 双击改昵称 → 刷新仍在", async ({ page }) => {
  await page.goto("/");
  // 未登录 → 重定向 /login
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("用户名").fill(ADMIN.username);
  await page.getByLabel("密码").fill(ADMIN.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/customers/);

  // 客户列表可见（SPA fallback 下刷新本页面也应可直达，这里先验证列表）
  const nicknameCell = page.locator('[data-cell$=":nickname"]').first();
  await expect(nicknameCell).toContainText(SEED_NICKNAME);

  // 搜索（300ms debounce，expect 自带轮询等待）
  await page.getByPlaceholder("搜索客户…").fill("e2e种子");
  await expect(nicknameCell).toContainText(SEED_NICKNAME);
  // 清空搜索再编辑，避免改名后不匹配过滤条件
  await page.getByPlaceholder("搜索客户…").fill("");
  await expect(nicknameCell).toContainText(SEED_NICKNAME);

  // 双击昵称格 → 行内编辑 → Enter 提交（PATCH 走行内队列）
  await nicknameCell.dblclick();
  const editor = page.getByRole("textbox", { name: "昵称" });
  await editor.fill(RENAMED);
  await editor.press("Enter");
  await expect(nicknameCell).toContainText(RENAMED);

  // 刷新仍在（持久化 + SPA fallback 可直达 /customers）
  await page.reload();
  await expect(page.locator('[data-cell$=":nickname"]').first()).toContainText(RENAMED);
});

test("assistant 登录看不到「团队成员」菜单", async ({ page }) => {
  await login(page, ASSISTANT.username, ASSISTANT.password);
  await expect(page.getByRole("link", { name: "客户信息" })).toBeVisible();
  await expect(page.getByRole("link", { name: "团队成员" })).toHaveCount(0);
});

test("admin：成交记录页可见种子成交（订单号 + 阶段徽章，K42）", async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);
  await page.getByRole("link", { name: "成交记录" }).click();
  await expect(page).toHaveURL(/\/deals/);

  const orderCell = page.locator('[data-cell$=":orderNo"]').first();
  await expect(orderCell).toContainText(DEAL_ORDER_NO);
  await expect(page.locator('[data-cell$=":stage"]').first()).toContainText("已付款");
});

test("admin：交付管理页可见种子交付单，详情页可见客户维度交付项（K44）", async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);
  await page.getByRole("link", { name: "交付管理" }).click();
  await expect(page).toHaveURL(/\/deliveries/);

  // 列表：类型名 + 客户数
  await expect(page.locator('[data-cell$=":deliveryType"]').first()).toContainText("e2e圈子交付");
  await expect(page.locator('[data-cell$=":customerCount"]').first()).toContainText("2 人");

  // 详情：客户维度交付项 + 动作进度（4 任务中 1 条已打勾）
  await page.getByRole("button", { name: "详情" }).first().click();
  await expect(page).toHaveURL(/\/deliveries\/\d+/);
  await expect(page.getByText("e2e拉群")).toBeVisible();
  await expect(page.getByText("1/4", { exact: true })).toBeVisible();
});

test("admin：圈子类交付 → 圈子工作台页（基本信息/客户表/导出/甘特与时序 todo）", async ({ page }) => {
  await login(page, ADMIN.username, ADMIN.password);
  await page.getByRole("link", { name: "交付管理" }).click();

  // 列表行操作提供「圈子工作台」入口（种子类型 kind=circle）
  await page.getByRole("button", { name: "圈子工作台" }).first().click();
  await expect(page).toHaveURL(/\/deliveries\/\d+\/circle/);

  // 基本信息：人数 / 周期状态（未排期）
  await expect(page.getByText("圈子工作台 · e2e圈子交付")).toBeVisible();
  await expect(page.getByText("圈子基本信息")).toBeVisible();
  await expect(page.getByText("2 人", { exact: true })).toBeVisible();
  await expect(page.getByText("未排期")).toBeVisible();
  await expect(page.getByText("e2e 交付备注")).toBeVisible();

  // 客户全量表（种子 2 客户；首个用例可能改过其中一个昵称 → 只断言行数）+ 导出 Excel
  await expect(page.getByRole("button", { name: "导出 Excel" })).toBeVisible();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(2);

  // 交付项 + 甘特 + 时序 todo
  await expect(page.getByText("e2e拉群")).toBeVisible();
  await expect(page.getByText(/项目交付项甘特/)).toBeVisible();
  await expect(page.getByText(/时序 todo/)).toBeVisible();
});
