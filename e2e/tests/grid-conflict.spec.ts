// 行级 OCC 冲突 UX：两个浏览器上下文改同一行，后到者收到 409 toast 并被服务端版本替换。
import { test, expect, E2E_ADMIN, E2E_CUSTOMER_NICKNAME_2 } from "../fixtures";

test("双上下文编辑同一昵称：后到者 409 toast「该行已被他人更新」，行内容以先提交者为准", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  try {
    const openTarget = async (page: import("@playwright/test").Page) => {
      await page.goto("/login");
      await page.getByLabel("用户名").fill(E2E_ADMIN.username);
      await page.getByLabel("密码").fill(E2E_ADMIN.password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page.locator(".app-header")).toBeVisible();
      await page.getByPlaceholder("搜索客户…").fill(E2E_CUSTOMER_NICKNAME_2);
      const cell = page.locator('[data-cell$=":nickname"]').first();
      await expect(cell).toContainText(E2E_CUSTOMER_NICKNAME_2);
      return cell;
    };

    // B 先加载（拿到旧行版本），随后 A 提交修改，B 再基于旧版本提交 → 409
    const cellB = await openTarget(pageB);
    const cellA = await openTarget(pageA);

    await cellA.dblclick();
    const editorA = pageA.getByRole("textbox", { name: "昵称" });
    await editorA.fill("e2e冲突先改");
    await editorA.press("Enter");
    await expect(cellA).toContainText("e2e冲突先改");

    await cellB.dblclick();
    const editorB = pageB.getByRole("textbox", { name: "昵称" });
    await editorB.fill("e2e冲突后改");
    await editorB.press("Enter");

    // 409：toast 提示 + 整行替换为服务端（A 提交）版本
    await expect(pageB.locator(".toast-list")).toContainText("该行已被他人更新");
    await expect(cellB).toContainText("e2e冲突先改");
    await expect(cellB).not.toContainText("e2e冲突后改");
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
