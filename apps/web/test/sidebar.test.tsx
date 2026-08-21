import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { adminMe, assistantMe, emptyList, mockFetch, renderApp } from "./helpers";

function mockMe(me: typeof adminMe) {
  mockFetch((url) => {
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/customers")) return emptyList();
  });
}

describe("侧栏", () => {
  it("admin 看到「团队成员」入口", async () => {
    mockMe(adminMe);
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });
    expect(screen.getByRole("link", { name: "团队成员" })).toBeTruthy();
  });

  it("assistant 看不到「团队成员」入口", async () => {
    mockMe(assistantMe);
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });
    expect(screen.queryByRole("link", { name: "团队成员" })).toBeNull();
    // 主数据入口仍在
    expect(screen.getByRole("link", { name: "渠道资产" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "产品目录" })).toBeTruthy();
  });

  it("折叠 toggle 生效并写入 localStorage", async () => {
    mockMe(adminMe);
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });

    const aside = document.querySelector("aside");
    expect(aside?.classList.contains("sidebar-hidden")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(aside?.classList.contains("sidebar-hidden")).toBe(true);
    expect(localStorage.getItem("gb-crm:sidebar-hidden")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "折叠侧栏" }));
    expect(aside?.classList.contains("sidebar-hidden")).toBe(false);
    expect(localStorage.getItem("gb-crm:sidebar-hidden")).toBe("0");
  });
});
