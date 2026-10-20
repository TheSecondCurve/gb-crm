// UI 层权限（can() 之上）：菜单显隐、PageGuard 路由守卫、渠道密钥列按角色脱敏。
// 注意 assistant 有 customers.update（可 PATCH 标量）但无 create/delete/updateOwners——
// 写按钮显隐按 can() 矩阵逐格断言，不做笼统假设。
import { test, expect, login, logout, E2E_ASSISTANT, E2E_CHANNEL_NAME, E2E_CHANNEL_ACCOUNT_ID } from "../fixtures";

test("assistant 落地客户页（homePath customers 优先），无团队成员/授权管理菜单", async ({ assistantPage }) => {
  await assistantPage.goto("/");
  await expect(assistantPage).toHaveURL(/\/customers/);
  await expect(assistantPage.getByRole("link", { name: "团队成员" })).toHaveCount(0);
  await expect(assistantPage.getByRole("link", { name: "授权管理" })).toHaveCount(0);
});

test("assistant 直访 /users 被 PageGuard 弹回第一张可看菜单页", async ({ assistantPage }) => {
  await assistantPage.goto("/users");
  await expect(assistantPage).not.toHaveURL(/\/users/);
  await expect(assistantPage).toHaveURL(/\/my\/customers/);
});

test("渠道密钥列：admin 可见明文，assistant 只见「—」", async ({ adminPage }) => {
  await adminPage.goto("/channels");
  const row = adminPage.getByRole("row", { name: new RegExp(E2E_CHANNEL_NAME) });
  await expect(row.locator('[data-cell$=":accountId"]')).toHaveText(E2E_CHANNEL_ACCOUNT_ID);
  await logout(adminPage);

  // 同一页转 assistant 登录：GET 密钥字段为 null，渲染「—」
  await login(adminPage, E2E_ASSISTANT.username, E2E_ASSISTANT.password);
  await adminPage.goto("/channels");
  const aRow = adminPage.getByRole("row", { name: new RegExp(E2E_CHANNEL_NAME) });
  await expect(aRow.locator('[data-cell$=":accountId"]')).toHaveText("—");
});

test("assistant 写按钮按 can() 逐格：无新增/删除，行内修改与批量打标可用（有 update 无 create）", async ({
  assistantPage,
}) => {
  await assistantPage.goto("/customers");
  await expect(assistantPage.getByRole("button", { name: "新增" })).toHaveCount(0);
  await expect(assistantPage.getByRole("button", { name: "删除" })).toHaveCount(0);
  // customers.update → 全量生成标签 / 行内修改在；create → 新增不在
  await expect(assistantPage.getByRole("button", { name: "全量生成标签" })).toBeVisible();
  await expect(assistantPage.getByRole("button", { name: "修改" }).first()).toBeVisible();
});
