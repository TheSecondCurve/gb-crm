// 客户信息：搜索/标签筛选/新增/修改弹窗/行内编辑持久化/删除/分页/导出 Excel。
import { test, expect, expectToast, rowByNickname, E2E_CUSTOMER_NICKNAME, E2E_TAG_NAME, E2E_PAGINATION_PREFIX } from "../fixtures";

test.beforeEach(async ({ adminPage }) => {
  await adminPage.goto("/customers");
  await expect(adminPage).toHaveURL(/\/customers/);
});

test("搜索过滤（300ms debounce，expect 自动轮询）", async ({ adminPage: page }) => {
  await page.getByPlaceholder("搜索客户…").fill(E2E_CUSTOMER_NICKNAME);
  await expect(rowByNickname(page, E2E_CUSTOMER_NICKNAME)).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(E2E_PAGINATION_PREFIX) })).toHaveCount(0);

  await page.getByPlaceholder("搜索客户…").fill("绝不存在的客户xyz");
  // admin 有空态副提示「点右上角新增」，通用空态文案是「暂无数据」
  await expect(page.getByText("暂无数据")).toBeVisible();
});

test("标签筛选下拉：选中种子标签只剩种子客户", async ({ adminPage: page }) => {
  await page.getByLabel("标签筛选").selectOption({ label: E2E_TAG_NAME });
  await expect(rowByNickname(page, E2E_CUSTOMER_NICKNAME)).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(E2E_PAGINATION_PREFIX) })).toHaveCount(0);
});

test("新增客户：弹窗必填昵称 → 列表出现", async ({ adminPage: page }) => {
  await page.getByRole("button", { name: "新增" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("新增客户");
  await dialog.getByLabel("昵称", { exact: true }).fill("e2e新建客户");
  await dialog.getByLabel("城市", { exact: true }).fill("上海");
  await dialog.getByRole("button", { name: "创建" }).click();
  await expectToast(page, "已创建客户");
  await expect(page.getByRole("row", { name: /e2e新建客户/ })).toBeVisible();
});

test("修改弹窗全字段编辑：改城市 → 保存生效", async ({ adminPage: page }) => {
  const row = page.getByRole("row", { name: /e2e新建客户/ });
  await row.getByRole("button", { name: "修改" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("修改客户：e2e新建客户");
  await dialog.getByLabel("城市", { exact: true }).fill("北京");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expectToast(page, "已保存");
  await expect(page.getByRole("row", { name: /e2e新建客户/ }).locator('[data-cell$=":city"]')).toHaveText("北京");
});

test("双击行内编辑昵称 → 刷新后仍在（OCC 队列持久化）", async ({ adminPage: page }) => {
  await page.getByPlaceholder("搜索客户…").fill(E2E_CUSTOMER_NICKNAME);
  const cell = page.locator('[data-cell$=":nickname"]').first();
  await expect(cell).toContainText(E2E_CUSTOMER_NICKNAME);
  const original = (await cell.innerText()).trim(); // 记下原名，测完恢复，避免跨 spec 污染
  await page.getByPlaceholder("搜索客户…").fill("");

  await cell.dblclick();
  const editor = page.getByRole("textbox", { name: "昵称" });
  await editor.fill("e2e改名客户");
  await editor.press("Enter");
  await expect(cell).toContainText("e2e改名客户");
  // 刷新后持久化（改名后行按 id 沉底，重新搜索定位）
  await page.reload();
  await page.getByPlaceholder("搜索客户…").fill("e2e改名客户");
  const renamed = page.locator('[data-cell$=":nickname"]').first();
  await expect(renamed).toContainText("e2e改名客户");
  // 恢复原名：materials 等 spec 断言种子客户与资料的关联 chip
  await renamed.dblclick();
  await page.getByRole("textbox", { name: "昵称" }).fill(original);
  await page.getByRole("textbox", { name: "昵称" }).press("Enter");
  await expect(renamed).toContainText(original);
});

test("删除客户：确认框 → toast → 行消失（软删不在列表显示）", async ({ adminPage: page }) => {
  await page.getByRole("row", { name: /e2e新建客户/ }).getByRole("button", { name: "删除" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("确定删除客户「e2e新建客户」吗？");
  await dialog.getByRole("button", { name: "删除" }).click();
  await expectToast(page, "已删除");
  await expect(page.getByRole("row", { name: /e2e新建客户/ })).toHaveCount(0);
});

test("分页：30+ 客户跨页，翻页与 pageSize 切换生效", async ({ adminPage: page }) => {
  const pager = page.locator(".pagination");
  // 2 锚点 + 30 分页用客户（新建/删除在同一文件内平衡）
  await expect(pager).toContainText("共 32 条");
  // 默认排序 updatedAt desc + id desc：分页030（id 最大）在第 1 页
  await expect(page.getByRole("row", { name: /e2e分页客户030/ })).toBeVisible();
  await pager.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByRole("row", { name: /e2e分页客户001/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /e2e分页客户030/ })).toHaveCount(0);
  // pageSize 100 → 一页全装下
  await pager.getByLabel("每页条数").selectOption("100");
  await expect(page.getByRole("row", { name: /e2e分页客户030/ })).toBeVisible();
  await expect(pager.getByRole("button", { name: "2" })).toHaveCount(0);
});

test("导出 Excel：触发下载且文件名正确", async ({ adminPage: page }) => {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 Excel" }).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toMatch(/\.xlsx$/); // 实际命名：客户信息-YYYYMMDD.xlsx
});
