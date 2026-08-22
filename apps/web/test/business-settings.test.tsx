// 业务设置页（K45/K50）：客户标签词表（admin 写、其余只读）。后台任务已移至系统设置页（K51）。
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp } from "./helpers";

interface Call {
  url: string;
  method: string;
  body?: string;
}

const tags = [
  { id: 1, name: "创业者", scope: "identity", sort: 1, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null },
  { id: 2, name: "已成交", scope: "stage", sort: 1, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null },
];

function mockBusinessSettingsApi(me: typeof adminMe) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/tags")) {
      if (method === "GET") {
        return { status: 200, body: { data: tags, meta: { page: 1, pageSize: 100, total: tags.length } } };
      }
      if (method === "POST") {
        return { status: 201, body: { data: { id: 3, name: "新标签", scope: "other", sort: 0, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null } } };
      }
      if (method === "PATCH") return { status: 200, body: { data: tags[0] } };
      if (method === "DELETE") return { status: 204 };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return calls;
}

describe("业务设置页", () => {
  it("admin：渲染「客户标签词表」+ 词表 CRUD（新增 → 修改 → 删除）", async () => {
    const calls = mockBusinessSettingsApi(adminMe);
    renderApp("/business-settings");

    expect(await screen.findByRole("heading", { name: "业务设置" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "客户标签词表" })).toBeTruthy();

    // 新增
    fireEvent.click(screen.getByRole("button", { name: "新增标签" }));
    const dialog = screen.getByRole("dialog", { name: "新增标签" });
    fireEvent.change(within(dialog).getByLabelText("标签名"), { target: { value: "高意向" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/tags")).toBe(true),
    );

    // 修改（重名：创业者 → 改排序）
    fireEvent.click(screen.getAllByRole("button", { name: "修改" })[0]!);
    const editDialog = await screen.findByRole("dialog", { name: "修改标签：创业者" });
    fireEvent.change(within(editDialog).getByLabelText("排序"), { target: { value: "9" } });
    fireEvent.click(within(editDialog).getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/tags/1");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ sort: 9, updatedAt: 1 });
    });

    // 删除
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
    const confirm = screen.getByRole("dialog", { name: "删除标签" });
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/tags/1")).toBe(true),
    );
  });

  it("assistant：只读可见词表，无新增/修改/删除按钮", async () => {
    mockBusinessSettingsApi(assistantMe);
    renderApp("/business-settings");

    expect(await screen.findByRole("heading", { name: "客户标签词表" })).toBeTruthy();
    expect(await screen.findByText("创业者")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新增标签" })).toBeNull();
    expect(screen.queryByRole("button", { name: "修改" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });
});
