// K49 admin「扮演用户（act as user）」：右上角菜单 → 切换身份弹窗 → 扮演徽标 → 退出扮演。
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { adminMe, assistantMe, impersonatingMe, mockFetch, renderApp, type Me } from "./helpers";

const targets = [
  { id: 2, username: "assistant", nickname: "兼职助手", systemRole: "assistant" },
  { id: 3, username: "ops", nickname: "团队运营", systemRole: "operator" },
];

/** 可变 me：扮演 start/stop 后 /auth/me 返回不同身份 */
function mockImpersonationApi(start: Me) {
  let currentMe: Me = start;
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: currentMe } };
    if (url === "/api/v1/customers" || url === "/api/v1/tags") {
      return { status: 200, body: { data: [], meta: { page: 1, pageSize: 25, total: 0 } } };
    }
    if (url === "/api/v1/auth/impersonate/targets") return { status: 200, body: { data: targets } };
    if (url === "/api/v1/auth/impersonate/2" && method === "POST") {
      currentMe = impersonatingMe;
      return { status: 204 };
    }
    if (url === "/api/v1/auth/impersonate/stop" && method === "POST") {
      currentMe = adminMe;
      return { status: 204 };
    }
  });
}

describe("K49 扮演用户（act as user）", () => {
  it("admin：菜单 → 切换身份 → 选目标 → 扮演徽标 → 退出扮演恢复", async () => {
    mockImpersonationApi(adminMe);
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });

    // 右上角用户菜单
    fireEvent.click(screen.getByRole("button", { name: /管理员/ }));
    fireEvent.click(screen.getByRole("button", { name: "切换身份（扮演用户）" }));

    // 弹窗列出候选目标（昵称 + 用户名/角色）
    expect(await screen.findByRole("dialog", { name: "切换身份（扮演用户）" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /兼职助手/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /团队运营/ })).toBeTruthy();

    // 点目标 → 扮演生效：头部出现「扮演中」徽标，不再有切换入口
    fireEvent.click(screen.getByRole("button", { name: /兼职助手/ }));
    expect(await screen.findByText(/扮演中：兼职助手/)).toBeTruthy();
    expect(screen.queryByText("切换身份（扮演用户）")).toBeNull();

    // 退出扮演 → 恢复 admin 身份
    fireEvent.click(screen.getByRole("button", { name: "退出扮演" }));
    await screen.findByRole("button", { name: /管理员/ });
    expect(screen.queryByText(/扮演中/)).toBeNull();
  });

  it("assistant：右上角无「切换身份」入口（矩阵仅 admin）", async () => {
    mockImpersonationApi(assistantMe);
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });

    expect(screen.getByText("兼职助手")).toBeTruthy(); // 纯文本昵称，无下拉
    expect(screen.queryByText("切换身份（扮演用户）")).toBeNull();
  });
});
