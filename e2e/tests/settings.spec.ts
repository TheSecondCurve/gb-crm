// 系统设置：admin 全 tab 可见、LLM 配置保存与持久化、operator 仅后台任务 tab（页面级权限配置的第二层）。
import { test, expect, expectToast } from "../fixtures";

test("admin：全部设置 tab 可见", async ({ adminPage: page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings/);
  const tabs = page.getByRole("tablist", { name: "系统设置" });
  for (const name of ["LLM 打标配置", "角色权限", "远程备份", "资料存储", "工作台分发", "后台任务", "定时任务"]) {
    await expect(tabs.getByRole("tab", { name })).toBeVisible();
  }
});

test("LLM 打标配置：保存 provider/baseUrl/model，刷新后仍在（apiKey 掩码不回显）", async ({ adminPage: page }) => {
  await page.goto("/settings?tab=llm");
  const form = page.locator("form.settings-form");
  await form.getByLabel(/供应商/).fill("deepseek");
  await form.getByLabel("Base URL").fill("https://api.deepseek.com/v1");
  await form.getByLabel("模型").fill("deepseek-chat");
  await form.getByRole("button", { name: "保存配置" }).click();
  await expectToast(page, "已保存 LLM 配置");

  await page.reload();
  const form2 = page.locator("form.settings-form");
  await expect(form2.getByLabel(/供应商/)).toHaveValue("deepseek");
  await expect(form2.getByLabel("Base URL")).toHaveValue("https://api.deepseek.com/v1");
  await expect(form2.getByLabel("模型")).toHaveValue("deepseek-chat");
});

test("operator：系统设置仅「后台任务」tab，直链 ?tab=llm 也被收敛", async ({ operatorPage: page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings/);
  const tabs = page.getByRole("tablist", { name: "系统设置" });
  await expect(tabs.getByRole("tab", { name: "后台任务" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "LLM 打标配置" })).toHaveCount(0);
  await expect(tabs.getByRole("tab", { name: "定时任务" })).toHaveCount(0);

  // 直链攻击面：?tab=llm 无效回退默认 tab（仍是 jobs）
  await page.goto("/settings?tab=llm");
  await expect(page.getByRole("tab", { name: "后台任务" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("form.settings-form")).toHaveCount(0);
});

test("operator 访问系统配置 API 被 403（前端之外的服务端闸门）", async ({ operatorPage: page }) => {
  const res = await page.request.get("/api/v1/system/ai-config");
  expect(res.status()).toBe(403);
});
