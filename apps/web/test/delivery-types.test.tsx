import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { DeliveryTypeDto } from "../src/api/types";

const type: DeliveryTypeDto = {
  id: 1,
  name: "圈子全年交付",
  kind: "circle",
  status: "active",
  description: "全年交付",
  defaultTasks: "拉群\n商品发货",
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockTypesApi(me: Me, rows: DeliveryTypeDto[] = [type]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/delivery-types")) {
      if (method === "GET") {
        return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
      }
      if (method === "POST") return { status: 201, body: { data: { ...type, id: 99, name: "新类型" } } };
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { data: { ...type, ...patch, updatedAt: 2001 } } };
      }
      if (method === "DELETE") return { status: 204 };
    }
  });
  return calls;
}

describe("交付类型页", () => {
  it("渲染列表：名称 + 默认动作模板；q 搜索", async () => {
    const calls = mockTypesApi(adminMe);
    renderApp("/delivery-types");
    expect(await screen.findByText("圈子全年交付")).toBeTruthy();
    expect(screen.getByText(/拉群/)).toBeTruthy(); // 多行文本 normalize 为空格

    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "圈子" } });
    await waitFor(() =>
      expect(calls.some((c) => c.method === "GET" && decodeURIComponent(c.url).includes("q=圈子"))).toBe(true),
    );
  });

  it("新增：填名称 → POST；删除 → ConfirmDialog → DELETE", async () => {
    const calls = mockTypesApi(adminMe);
    renderApp("/delivery-types");
    await screen.findByText("圈子全年交付");

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    const dialog = screen.getByRole("dialog", { name: "新增交付类型" });
    fireEvent.change(within(dialog).getByLabelText("类型名称"), { target: { value: "线上连麦" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/delivery-types");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toEqual({ name: "线上连麦" });
    });

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const delDialog = screen.getByRole("dialog", { name: "删除交付类型" });
    fireEvent.click(within(delDialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/delivery-types/1")).toBe(true),
    );
  });

  it("assistant：只读无新增/删除", async () => {
    mockTypesApi(assistantMe);
    renderApp("/delivery-types");
    await screen.findByText("圈子全年交付");
    expect(screen.queryByRole("button", { name: "新增" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });
});
