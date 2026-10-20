// 资料专区：FTS 搜索、新建文本资料（EntityPicker 挂客户）、multipart 文件上传、
// 文件专区视图、查看弹窗、删除。
import { test, expect, expectToast, E2E_CUSTOMER_NICKNAME, E2E_MATERIAL_TITLE } from "../fixtures";

test.beforeEach(async ({ adminPage }) => {
  await adminPage.goto("/materials");
  await expect(adminPage).toHaveURL(/\/materials/);
});

test("列表显示种子资料（标题 + 关联客户 chip）", async ({ adminPage: page }) => {
  const row = page.getByRole("row", { name: new RegExp(E2E_MATERIAL_TITLE) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(E2E_CUSTOMER_NICKNAME);
});

test("FTS 全文搜索：命中与不命中", async ({ adminPage: page }) => {
  await page.getByPlaceholder("搜索资料/交付名…").fill("咨询纪要");
  await expect(page.getByRole("row", { name: new RegExp(E2E_MATERIAL_TITLE) })).toBeVisible();
  await page.getByPlaceholder("搜索资料/交付名…").fill("绝不存在的资料xyz");
  await expect(page.getByText("暂无资料")).toBeVisible();
});

test("新建文本资料：标题 + 内容 + 关联客户 → 创建后进入全文编辑页", async ({ adminPage: page }) => {
  await page.getByRole("button", { name: "新增资料" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/标题/).fill("e2e新资料");
  await dialog.getByLabel(/内容/).fill("e2e 新资料正文");
  // EntityPicker 关联客户
  await dialog.getByLabel("搜索客户").fill(E2E_CUSTOMER_NICKNAME);
  await dialog.getByRole("option", { name: E2E_CUSTOMER_NICKNAME, exact: true }).click();
  await dialog.getByRole("button", { name: "创建" }).click();
  await expectToast(page, "已创建资料");
  // 文本类创建后直接进入全文编辑器
  await expect(page).toHaveURL(/\/materials\/\d+\/edit/);
  await expect(page.locator("h1")).toContainText("e2e新资料");
});

test("上传文件资料：multipart 真上传 → 列表与文件专区可见", async ({ adminPage: page }) => {
  await page.getByRole("button", { name: "新增资料" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/资料类型/).selectOption("file");
  await dialog.getByLabel(/标题/).fill("e2e文件资料");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "e2e-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("e2e upload content"),
  });
  await dialog.getByRole("button", { name: "创建" }).click();
  await expectToast(page, "已创建资料");
  // 浏览视图出现文件名
  await expect(page.getByRole("row", { name: /e2e文件资料/ })).toContainText("e2e-upload.txt");
  // 文件专区 album 可见
  await page.getByRole("tab", { name: "文件专区" }).click();
  await expect(page.getByText("e2e文件资料")).toBeVisible();
});

test("查看弹窗与删除资料", async ({ adminPage: page }) => {
  const row = page.getByRole("row", { name: /e2e文件资料/ });
  await row.getByRole("button", { name: "查看" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("e2e文件资料");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await row.getByRole("button", { name: "删除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
  await expectToast(page, "已删除");
  await expect(page.getByRole("row", { name: /e2e文件资料/ })).toHaveCount(0);
});
