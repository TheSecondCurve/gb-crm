// 钱链路端到端：默认分成方案 → 成交分红池 → 配置 payout → 新建发放批次（自动纳入待发）→
// 批次详情（人员汇总/明细金额）→ 锁定 → 标记已发 → 导出 xlsx。
// 锚点数据：ORD-002 = ¥1000 × 税后 1 × 总比例 10% → 分红池 ¥100。
import { test, expect, expectToast, E2E_DEAL2_ORDER_NO } from "../fixtures";

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.beforeEach(async ({ adminPage }) => {
  await adminPage.goto("/deals/commissions");
  await expect(adminPage).toHaveURL(/\/deals\/commissions/);
});

test("默认分成方案：总比例 10% + 成交负责人 100% 规则保存生效，ORD-002 分红池 ¥100", async ({ adminPage: page }) => {
  const card = page.locator(".card", { hasText: "默认分成方案" });
  await card.getByRole("button", { name: "编辑" }).click();
  await card.getByLabel("总比例(%)").fill("10");
  // 成交负责人/客户归属人「总是参与」但无规则时比例为 0 → 必须显式加一行成交负责人 100%
  await card.getByRole("button", { name: "加一行" }).click();
  const ruleRow = card.locator("tbody tr").last();
  await ruleRow.locator("select").first().selectOption("dealOwner");
  await ruleRow.locator('input[type="number"]').fill("100");
  await card.getByRole("button", { name: "保存方案" }).click();
  await expectToast(page, "已保存默认分成方案");

  const row = page.getByRole("row", { name: new RegExp(E2E_DEAL2_ORDER_NO) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/¥100/); // 分红池列：100000 × 1 × 0.1
});

test("配置 payout：ORD-002 加第 1 期 100%（今日）→ 行内显示待发", async ({ adminPage: page }) => {
  const row = page.getByRole("row", { name: new RegExp(E2E_DEAL2_ORDER_NO) });
  await row.getByRole("button", { name: "配置 payout" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "加第 1 期" }).click();
  await dialog.getByLabel("第 1 期支付日期").fill(fmt(new Date()));
  // 比例默认 100；保存
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expectToast(page, "已保存 payout");
  await expect(row).toContainText("1期");
  await expect(row).toContainText("待发");
});

test("新建发放批次：自动纳入范围内待发 payout，明细与人员汇总金额正确", async ({ adminPage: page }) => {
  const now = new Date();
  const monthStart = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0));

  await page.goto("/deals/payout-batches");
  await page.getByRole("button", { name: "新建批次" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("批次名").fill("e2e发放批次");
  await dialog.getByLabel("开始日期").fill(monthStart);
  await dialog.getByLabel("结束日期").fill(monthEnd);
  await dialog.getByRole("button", { name: "创建" }).click();
  await expectToast(page, "已创建发放批次");
  await expect(page).toHaveURL(/\/deals\/payout-batches\/\d+/);

  // 明细 1 条，金额 ¥100；人员汇总有运营姐
  const detail = page.locator(".card", { hasText: "发放明细" });
  await expect(detail).toContainText(/¥100/);
  await expect(detail).toContainText("第1期");
  const summary = page.locator(".card", { hasText: "人员汇总" });
  await expect(summary).toContainText("运营姐");
  await expect(summary).toContainText(/¥100/);
});

test("锁定 → 标记已发：状态机推进 + 确认框文案 + 金额快照保留", async ({ adminPage: page }) => {
  await page.goto("/deals/payout-batches");
  await page.getByRole("link", { name: /e2e发放批次/ }).click();
  await expect(page).toHaveURL(/\/deals\/payout-batches\/\d+/);

  // 锁定
  await page.getByRole("button", { name: "锁定批次" }).click();
  await expect(page.getByRole("dialog")).toContainText("锁定后不可增删明细");
  await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
  await expectToast(page, "已锁定");
  await expect(page.locator("h2").first()).toContainText("已锁定");

  // 标记已发
  await page.getByRole("button", { name: "标记已发" }).click();
  await expect(page.getByRole("dialog")).toContainText("操作不可撤销");
  await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
  await expectToast(page, /已标记 1 条为已发/);
  await expect(page.locator("h2").first()).toContainText("已发放");
  // 金额快照仍在
  await expect(page.locator(".card", { hasText: "发放明细" })).toContainText(/¥100/);
});

test("批次导出 xlsx：非草稿状态可下载", async ({ adminPage: page }) => {
  await page.goto("/deals/payout-batches");
  await page.getByRole("link", { name: /e2e发放批次/ }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出 xlsx" }).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toMatch(/\.xlsx$/); // 实际命名：分成发放-<批次名>.xlsx
});
