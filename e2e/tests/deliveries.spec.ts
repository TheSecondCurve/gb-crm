// 交付管理：列表渲染、新建交付单、详情页动作打勾（进度推进）、圈子工作台、甘特/矩阵页渲染。
import { test, expect, expectToast, E2E_DELIVERY_TYPE, E2E_DELIVERABLE_CONTENT } from "../fixtures";

test.beforeEach(async ({ adminPage }) => {
  await adminPage.goto("/deliveries");
  await expect(adminPage).toHaveURL(/\/deliveries/);
});

test("列表显示种子圈子交付（类型 + 客户数）", async ({ adminPage: page }) => {
  const row = page.getByRole("row", { name: /e2e 交付备注/ });
  await expect(row).toContainText("2 人");
});

test("新建交付单：选类型 + 交付名 → 列表出现", async ({ adminPage: page }) => {
  await page.getByRole("button", { name: "新增交付" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("交付类型").selectOption({ label: E2E_DELIVERY_TYPE });
  await dialog.getByLabel("交付名").fill("e2e新交付");
  await dialog.getByRole("button", { name: "创建" }).click();
  await expectToast(page, "已创建交付");
  await expect(page.getByRole("row", { name: /e2e新交付/ })).toBeVisible();
});

test("详情页：客户维度交付项打勾推进进度（1/4 → 2/4）", async ({ adminPage: page }) => {
  await page.getByRole("row", { name: /e2e 交付备注/ }).getByRole("button", { name: "详情" }).click();
  await expect(page).toHaveURL(/\/deliveries\/\d+/);
  const itemRow = page.locator(".item-row", { hasText: E2E_DELIVERABLE_CONTENT });
  await expect(itemRow).toContainText("打勾 1/4");

  await itemRow.getByRole("button", { name: "动作" }).click();
  const dialog = page.getByRole("dialog");
  const todo = dialog.getByRole("checkbox", { name: "商品发货" }).first();
  // 受控 checkbox：点击后需等 PATCH 往返才翻转，check() 会误判「状态未变」→ 用 click + 自动等待断言
  await todo.click();
  await expect(todo).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await expect(itemRow).toContainText("打勾 2/4");
});

test("圈子工作台：基本信息/客户全量表/交付项/甘特与时序 todo", async ({ adminPage: page }) => {
  await page.getByRole("row", { name: /e2e 交付备注/ }).getByRole("button", { name: "圈子工作台" }).click();
  await expect(page).toHaveURL(/\/deliveries\/\d+\/circle/);

  await expect(page.getByText(`圈子工作台 · ${E2E_DELIVERY_TYPE}`)).toBeVisible();
  await expect(page.getByText("圈子基本信息")).toBeVisible();
  await expect(page.getByText("2 人", { exact: true })).toBeVisible();
  await expect(page.getByText("未排期")).toBeVisible();
  await expect(page.getByRole("button", { name: "导出 Excel" })).toBeVisible();
  // 客户全量表 2 行（首个用例可能改过其中一个昵称 → 只断行数）
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(2);

  await page.getByRole("tab", { name: /交付工作项/ }).click();
  await expect(page.getByText(E2E_DELIVERABLE_CONTENT)).toBeVisible();
  await expect(page.getByText(/项目交付项甘特/)).toBeVisible();
  await expect(page.getByText(/时序 todo/)).toBeVisible();
});

test("甘特页与矩阵页：从详情页直达并渲染", async ({ adminPage: page }) => {
  await page.getByRole("row", { name: /e2e 交付备注/ }).getByRole("button", { name: "详情" }).click();
  await page.getByRole("button", { name: "甘特图" }).click();
  await expect(page).toHaveURL(/\/deliveries\/\d+\/gantt/);
  await expect(page.getByText(/甘特/).first()).toBeVisible();
  // 甘特页只有「返回详情」，矩阵入口在详情页
  await page.getByRole("button", { name: /返回详情/ }).click();
  await expect(page).toHaveURL(/\/deliveries\/\d+/);
  await page.getByRole("button", { name: "状态矩阵" }).click();
  await expect(page).toHaveURL(/\/deliveries\/\d+\/matrix/);
  await expect(page.getByText(/矩阵/).first()).toBeVisible();
});
