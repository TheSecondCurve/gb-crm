// 团队成员与全局能力：新建成员、停用后立即无法登录、设置密码、身份扮演（K49）、命令面板。
import { test, expect, login, logout, expectToast } from "../fixtures";

test("新建成员：弹窗填账号/昵称/密码/角色 → 列表出现", async ({ adminPage: page }) => {
  await page.goto("/users");
  await expect(page).toHaveURL(/\/users/);
  await page.getByRole("button", { name: "新增" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("新增成员");
  await dialog.getByLabel("用户名").fill("e2e新成员");
  await dialog.getByLabel("昵称").fill("e2e新成员昵称");
  await dialog.getByLabel("密码").fill("e2e-pass-9x");
  await dialog.getByLabel("系统角色").selectOption("operator");
  await dialog.getByRole("button", { name: "创建" }).click();
  await expectToast(page, "已创建成员");
  await expect(page.getByRole("row", { name: /e2e新成员昵称/ })).toBeVisible();
});

test("停用成员：账户状态改停用后该成员立即无法登录（会话与凭证被清）", async ({
  adminPage: page,
  browser,
}) => {
  await page.goto("/users");
  const row = page.getByRole("row", { name: /e2e新成员昵称/ });
  await row.getByRole("button", { name: "修改" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("账户状态").selectOption("disabled");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expectToast(page, "已保存");
  // 列表行被禁用样式标记
  await expect(row).toHaveClass(/row-disabled/);

  // 新上下文登录被拒不建会话
  const ctx = await browser.newContext();
  const page2 = await ctx.newPage();
  try {
    await page2.goto("/login");
    await page2.getByLabel("用户名").fill("e2e新成员");
    await page2.getByLabel("密码").fill("e2e-pass-9x");
    await page2.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page2.getByRole("alert")).toBeVisible();
    await expect(page2).toHaveURL(/\/login/);
  } finally {
    await ctx.close();
  }
});

test("设置密码：管理员给他人重设密码成功提示（用后恢复种子密码，避免跨 spec 污染）", async ({ adminPage: page }) => {
  await page.goto("/users");
  const setPassword = async (pwd: string) => {
    await page.getByRole("row", { name: /小助手/ }).getByRole("button", { name: "设置密码" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/新密码/).fill(pwd);
    await dialog.getByRole("button", { name: "确认" }).click();
    await expectToast(page, "密码已设置");
  };
  await setPassword("assistant-e2e-pass-v2");
  // 恢复种子常量里的原密码：其它 spec（rbac/settings）的 assistant 夹具还要用它登录
  await setPassword("assistant-e2e-pass");
});

test("身份扮演：admin 扮演 assistant → 菜单收窄 → 退出扮演还原", async ({ adminPage: page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "团队成员" })).toBeVisible();
  // 用户菜单 → 切换身份
  await page.getByRole("button", { name: /管理员/ }).click();
  await page.getByRole("button", { name: "切换身份（扮演用户）" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("切换身份（扮演用户）");
  await dialog.getByRole("button", { name: /小助手/ }).click();
  // 徽标：扮演中 + 被扮演者身份；权限收窄为 assistant
  const badge = page.locator(".impersonate-badge");
  await expect(badge).toContainText("扮演中：小助手");
  await expect(page.getByRole("link", { name: "团队成员" })).toHaveCount(0);
  // 退出扮演回到原身份
  await page.getByRole("button", { name: "退出扮演" }).click();
  await expect(badge).toHaveCount(0);
  await expect(page.getByRole("link", { name: "团队成员" })).toBeVisible();
});

test("命令面板：Ctrl+K 搜客户 → 回车进总览", async ({ adminPage: page }) => {
  await page.goto("/");
  // 等 React 挂载完（快捷键监听就绪）再按键
  await expect(page.locator(".app-header")).toBeVisible();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "快速搜索" });
  await expect(palette).toBeVisible();
  await palette.getByLabel("快速搜索").fill("e2e种子");
  const option = palette.getByRole("option", { name: /e2e种子客户/ }).first();
  await expect(option).toBeVisible();
  await palette.getByLabel("快速搜索").press("Enter");
  await expect(page).toHaveURL(/\/customers\/\d+/);
});

test("退出登录后受保护页再次访问被弹回登录页", async ({ assistantPage: page }) => {
  await page.goto("/");
  await logout(page);
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/login/);
});
