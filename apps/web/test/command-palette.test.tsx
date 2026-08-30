import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, mockFetch, renderApp } from "./helpers";

/** 通用 mock：auth/me、客户列表、标签词表、客户总览；返回被请求的 URL + 精简 overview */
function mockCtx() {
  const calls: string[] = [];
  mockFetch((url) => {
    calls.push(url);
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
    if (url.startsWith("/api/v1/tags")) {
      return { status: 200, body: { data: [], meta: { page: 1, pageSize: 100, total: 0 } } };
    }
    // 快速搜索：pageSize=8 返回一条客户
    if (url.includes("pageSize=8")) {
      return {
        status: 200,
        body: {
          data: [{ id: 1, nickname: "张三", phone: "13800000000", wechat: null, city: "上海" }],
          meta: { page: 1, pageSize: 8, total: 1 },
        },
      };
    }
    if (url.includes("/customers/1/overview")) {
      return {
        status: 200,
        body: {
          data: {
            customer: null,
            stats: { dealCount: 0, paidTotalCents: 0, lastDealAt: null, materialCount: 0, maintenanceRecordCount: 0 },
            deals: [],
            circles: [],
            materials: [],
            maintenanceRecords: [],
          },
        },
      };
    }
    if (url.startsWith("/api/v1/customers")) {
      return { status: 200, body: { data: [], meta: { page: 1, pageSize: 25, total: 0 } } };
    }
    return undefined;
  });
  return calls;
}

describe("全局快速搜索（Cmd/Ctrl+K）", () => {
  it("Ctrl+K 打开、输入查询、回车进入客户总览", async () => {
    const calls = mockCtx();
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });

    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "快速搜索" });
    const input = within(dialog).getByLabelText("快速搜索");

    fireEvent.change(input, { target: { value: "张" } });
    await waitFor(() =>
      expect(calls.some((u) => u.includes("pageSize=8") && decodeURIComponent(u).includes("q=张"))).toBe(true),
    );

    const option = await screen.findByRole("option", { name: /张三/ });
    fireEvent.click(option);

    await waitFor(() => expect(calls.some((u) => u.includes("/customers/1/overview"))).toBe(true));
  });

  it("Esc 关闭弹层", async () => {
    mockCtx();
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });

    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "快速搜索" })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "快速搜索" })).toBeNull();
  });
});
