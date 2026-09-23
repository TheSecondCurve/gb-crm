// 认证与会话：登录失败提示、登录落地、登出、未登录守卫、会话持久化。
import { test, expect, login, logout, E2E_ADMIN } from "../fixtures";

test("错误密码：登录页展示服务端错误提示（role=alert）", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(E2E_ADMIN.username);
  await page.getByLabel("密码").fill("wrong-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/用户名或密码错误|登录失败/);
  await expect(page).toHaveURL(/\/login/);
});

test("admin 登录落地客户页，退出后回登录页", async ({ adminPage }) => {
  await adminPage.goto("/");
  await expect(adminPage).toHaveURL(/\/customers/);
  await expect(adminPage.locator(".app-header")).toBeVisible();
  await logout(adminPage);
});

test("未登录访问业务深层链接 → 重定向 /login", async ({ page }) => {
  await page.goto("/deliveries");
  await expect(page).toHaveURL(/\/login/);
  // 登录成功后进入应用
  await login(page, E2E_ADMIN.username, E2E_ADMIN.password);
});

test("登录态跨刷新保持（httpOnly cookie 会话）", async ({ adminPage }) => {
  await adminPage.goto("/deals");
  // 等首屏渲染完成再刷新，避免与应用初始化竞态
  await expect(adminPage.locator(".app-header")).toBeVisible();
  await adminPage.reload();
  await expect(adminPage).toHaveURL(/\/deals/);
  await expect(adminPage.locator(".app-header")).toBeVisible();
});
