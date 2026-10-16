import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, emptyList, mockFetch, renderApp } from "./helpers";

/** 手机断点 matchMedia stub（K67）：jsdom 无 matchMedia，桌面态测试依赖其缺席（useMediaQuery 恒 false） */
function stubMobileMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("767"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

/** 行结构不标 CustomerDto：mock body 本就是 unknown，避免耦合在途的字段增删 */
const customer = {
  id: 1,
  nickname: "张三",
  realName: null,
  title: null,
  phone: "13800000000",
  wechat: null,
  country: null,
  city: "上海",
  industry: null,
  originStory: null,
  notes: null,
  customerType: "customer",
  wechatOpenid: null,
  lastFollowedAt: null,
  socialAccounts: [],
  tags: [],
  owner: { id: 1, nickname: "老王" },
  sourceChannels: [],
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

function mockMeAndLists(rows: unknown[] = []) {
  mockFetch((url) => {
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
    if (url.startsWith("/api/v1/tags")) {
      return { status: 200, body: { data: [], meta: { page: 1, pageSize: 100, total: 0 } } };
    }
    if (url.startsWith("/api/v1/customers")) {
      return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
    }
    if (url.startsWith("/api/v1/products")) return emptyList();
    return undefined;
  });
}

describe("移动端响应式（K67）", () => {
  it("手机断点：折叠按钮变抽屉开关，点遮罩收起", async () => {
    stubMobileMatchMedia();
    mockMeAndLists();
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });

    expect(document.querySelector("aside.sidebar-drawer-open")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    expect(document.querySelector("aside.sidebar-drawer-open")).toBeTruthy();
    expect(document.querySelector(".sidebar-mask")).toBeTruthy();

    fireEvent.click(document.querySelector(".sidebar-mask")!);
    expect(document.querySelector("aside.sidebar-drawer-open")).toBeNull();
    expect(document.querySelector(".sidebar-mask")).toBeNull();
  });

  it("手机抽屉：路由变更自动收起", async () => {
    stubMobileMatchMedia();
    mockMeAndLists();
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });

    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    expect(document.querySelector("aside.sidebar-drawer-open")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "产品目录" }));
    await waitFor(() => expect(document.querySelector("aside.sidebar-drawer-open")).toBeNull());
    expect(document.querySelector(".sidebar-mask")).toBeNull();
  });

  it("顶栏搜索按钮打开快速搜索，Esc 关闭", async () => {
    mockMeAndLists([{ ...customer }]);
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });

    fireEvent.click(screen.getByRole("button", { name: "搜索客户" }));
    expect(await screen.findByRole("dialog", { name: "快速搜索" })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "快速搜索" })).toBeNull();
  });

  it("DataGrid 有行尾操作列时打 has-actions 标记（移动端右冻结的挂钩）", async () => {
    mockMeAndLists([{ ...customer }]);
    renderApp("/customers");
    await screen.findByText("张三");

    const table = document.querySelector("table.data-grid-table");
    expect(table?.classList.contains("has-actions")).toBe(true);
  });

  it("重度工具页手机端显示桌面建议提示条，可关闭并记忆", async () => {
    stubMobileMatchMedia();
    mockFetch((url) => {
      if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
      if (url === "/api/v1/deliveries/1") {
        return {
          status: 200,
          body: { data: { id: 1, name: "交付一", customers: [], deliveryType: null } },
        };
      }
      if (url === "/api/v1/deliveries/1/items") {
        return { status: 200, body: { data: [] } };
      }
      return undefined;
    });
    renderApp("/deliveries/1/matrix");

    const hint = await screen.findByRole("note");
    expect(hint.textContent).toContain("桌面端");
    fireEvent.click(within(hint).getByRole("button", { name: "知道了" }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(localStorage.getItem("gb-crm:desktop-hint-dismissed")).toBe("1");
  });
});
