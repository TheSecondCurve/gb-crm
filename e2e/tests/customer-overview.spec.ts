// 客户总览：统计卡、消费记录、维护记录 CRUD、标签挂载/自定义标签、AI 打标未配置报错。
import { test, expect, expectToast, rowByNickname, E2E_CUSTOMER_NICKNAME, E2E_DEAL2_ORDER_NO, E2E_TAG_NAME } from "../fixtures";

async function gotoOverview(page: import("@playwright/test").Page) {
  await page.goto("/customers");
  await page.getByPlaceholder("搜索客户…").fill(E2E_CUSTOMER_NICKNAME);
  await rowByNickname(page, E2E_CUSTOMER_NICKNAME).getByRole("button", { name: "总览" }).click();
  await expect(page).toHaveURL(/\/customers\/\d+/);
  await expect(page.locator("h1")).toContainText(E2E_CUSTOMER_NICKNAME);
}

test("统计卡与消费记录：成交笔数 2 / 累计实付 ¥1000 / 订单号可见", async ({ adminPage: page }) => {
  await gotoOverview(page);
  const stats = page.locator(".stats-grid");
  await expect(stats).toContainText("成交笔数");
  await expect(stats.locator(".stat-value").nth(0)).toHaveText("2");
  await expect(stats.locator(".stat-value").nth(1)).toHaveText(/1000/); // 累计实付（元），centsToYuan 输出 "1000.00"
  const dealsCard = page.locator(".card", { hasText: "消费记录" });
  await expect(dealsCard).toContainText(E2E_DEAL2_ORDER_NO);
  // 总览消费记录卡片直接渲染枚举原值（badge(d.stage)），不是中文 label
  await expect(dealsCard).toContainText("paid");
});

test("种子标签挂载展示，可移除后重挂", async ({ adminPage: page }) => {
  await gotoOverview(page);
  // 种子客户带词表标签
  await expect(page.locator(".chip", { hasText: E2E_TAG_NAME })).toBeVisible();
  // 移除（PATCH tagIds 数组语义）。移除后该标签会出现在下方「添加标签」区，
  // 所以不能用裸 .chip 计数，改断言移除按钮消失 + 添加区出现可选 chip。
  await page.getByRole("button", { name: `移除标签 ${E2E_TAG_NAME}` }).click();
  await expectToast(page, "已保存标签");
  await expect(page.getByRole("button", { name: `移除标签 ${E2E_TAG_NAME}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(E2E_TAG_NAME) }).first()).toBeVisible();
  // 从「添加标签」区重挂
  await page.getByRole("button", { name: E2E_TAG_NAME }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expectToast(page, "已保存标签");
  await expect(page.locator(".chip", { hasText: E2E_TAG_NAME })).toBeVisible();
});

test("自定义标签：输入新词 → 自动建词并挂载", async ({ adminPage: page }) => {
  await gotoOverview(page);
  await page.getByPlaceholder("输入自定义标签名…").fill("e2e自定义标签");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expectToast(page, /已添加自定义标签|已复用同名标签/);
  await expect(page.locator(".chip", { hasText: "e2e自定义标签" })).toBeVisible();
});

test("维护记录：新增跟进记录 → 列表出现 → 删除", async ({ adminPage: page }) => {
  await gotoOverview(page);
  const card = page.locator(".card", { hasText: "维护记录" });
  await card.getByRole("button", { name: "新增记录" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("新增维护记录");
  await dialog.getByLabel("类型").selectOption("follow_up");
  await dialog.getByLabel("内容").fill("e2e 电话跟进：约下周复购沟通");
  await dialog.getByRole("button", { name: "创建" }).click(); // 新建模式提交按钮文案是「创建」
  await expectToast(page, "已新增记录");
  const recordRow = page.locator(".item-row", { hasText: "e2e 电话跟进" });
  await expect(recordRow).toBeVisible();
  await expect(recordRow).toContainText("跟进");
  // 删除
  await recordRow.getByRole("button", { name: "删除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
  await expectToast(page, "已删除记录");
  await expect(page.locator(".item-row", { hasText: "e2e 电话跟进" })).toHaveCount(0);
});

test("AI 生成标签：LLM 未配置时给出错误 toast（不静默失败）", async ({ adminPage: page }) => {
  // 先清空 LLM 配置：settings.spec 可能已保存过配置，不能依赖「恰好未配置」的初始态
  const clear = await page.request.patch("/api/v1/system/ai-config", {
    data: { provider: null, baseUrl: null, model: null },
  });
  expect(clear.status()).toBe(200);
  await gotoOverview(page);
  await page.getByRole("button", { name: "AI 生成标签" }).click();
  await expect(page.locator(".toast-list .toast").first()).toBeVisible();
});
