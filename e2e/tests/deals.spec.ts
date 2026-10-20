// 成交记录：列表渲染、弹窗新建（RelationPicker 选客户/产品）、行内改阶段、阶段筛选。
import { test, expect, expectToast, E2E_CUSTOMER_NICKNAME_2, E2E_DEAL2_ORDER_NO } from "../fixtures";

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.beforeEach(async ({ adminPage }) => {
  await adminPage.goto("/deals");
  await expect(adminPage).toHaveURL(/\/deals/);
});

test("列表显示种子成交（订单号 + 阶段徽章）", async ({ adminPage: page }) => {
  const row = page.getByRole("row", { name: new RegExp(E2E_DEAL2_ORDER_NO) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("已付款");
});

test("新建成交：弹窗选客户/产品 + 金额 + 成交日期 → 列表出现", async ({ adminPage: page }) => {
  await page.getByRole("button", { name: "新增" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("新增成交记录");

  // 三个 RelationPicker（客户/意向产品/负责人）结构相同，按表单列顺序取 .form-picker nth。
  // 不能用 getByText("客户").locator("..")：选项加载前匹配到字段 div，加载后父级升级为整个表单。
  const pickers = dialog.locator(".form-picker");
  await pickers.nth(0).getByPlaceholder("搜索…").fill(E2E_CUSTOMER_NICKNAME_2);
  await pickers.nth(0).getByRole("radio", { name: E2E_CUSTOMER_NICKNAME_2, exact: true }).check();
  // 意向产品
  await pickers.nth(1).getByPlaceholder("搜索…").fill("e2e种子产品");
  await pickers.nth(1).getByRole("radio", { name: /e2e种子产品/ }).check();

  await dialog.getByLabel("金额（元）").fill("500");
  await dialog.getByLabel("成交日期").fill(today());
  await dialog.getByLabel("订单号").fill("E2E-ORD-003");
  await dialog.getByRole("button", { name: "创建" }).click();
  await expectToast(page, "已创建成交记录");
  await expect(page.getByRole("row", { name: /E2E-ORD-003/ })).toBeVisible();
});

// 用种子成交 ORD-001（阶段=赠送）做行内编辑，独立于新建用例，可单独重跑
test("行内改阶段：双击阶段格 → 选「已关闭」→ 徽章即时更新", async ({ adminPage: page }) => {
  const row = page.getByRole("row", { name: /E2E-ORD-001/ });
  await row.locator('[data-cell$=":stage"]').dblclick();
  // 编辑器是原生 select（role=combobox，aria-label=列名），异步挂载由 selectOption 自动等待
  await page.getByRole("combobox", { name: "阶段", exact: true }).selectOption("closed");
  await expect(row.locator('[data-cell$=":stage"]')).toContainText("已关闭");
});

test("阶段筛选：选已关闭只剩 ORD-001，恢复全部两条可见", async ({ adminPage: page }) => {
  // 自含前置：先把 ORD-001 改成已关闭（与本文件其它用例解耦，可单独重跑）
  const row1 = page.getByRole("row", { name: /E2E-ORD-001/ });
  await row1.locator('[data-cell$=":stage"]').dblclick();
  await page.getByRole("combobox", { name: "阶段", exact: true }).selectOption("closed");
  await expect(row1.locator('[data-cell$=":stage"]')).toContainText("已关闭");
  // 筛选
  await page.getByLabel("阶段筛选").selectOption("closed");
  await expect(page.getByRole("row", { name: /E2E-ORD-001/ })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(E2E_DEAL2_ORDER_NO) })).toHaveCount(0);
  await page.getByLabel("阶段筛选").selectOption("");
  await expect(page.getByRole("row", { name: new RegExp(E2E_DEAL2_ORDER_NO) })).toBeVisible();
});
