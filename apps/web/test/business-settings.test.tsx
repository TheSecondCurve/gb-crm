// 业务设置页（K45/K50/K58）：客户/资料标签词表分域两卡片（admin 写、其余只读）。后台任务已移至系统设置页（K51）。
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp } from "./helpers";

interface Call {
  url: string;
  method: string;
  body?: string;
}

const tags = [
  { id: 1, name: "创业者", domain: "customer", scope: "identity", sort: 1, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null },
  { id: 2, name: "已成交", domain: "customer", scope: "stage", sort: 1, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null },
];

const materialTags = [
  { id: 11, name: "咨询复盘", domain: "material", scope: "other", sort: 1, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null },
];

function mockBusinessSettingsApi(me: typeof adminMe) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/tags")) {
      if (method === "GET") {
        // K58：词表按 domain 分域
        const data = url.includes("domain=material") ? materialTags : tags;
        return { status: 200, body: { data, meta: { page: 1, pageSize: 100, total: data.length } } };
      }
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return { status: 201, body: { data: { id: 99, name: body.name, domain: body.domain ?? "customer", scope: body.scope ?? "other", sort: 0, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null } } };
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

  it("K58 资料标签词表：独立卡片（无分类列）；创建带 domain=material 不带 scope；删除文案按域", async () => {
    const calls = mockBusinessSettingsApi(adminMe);
    renderApp("/business-settings");

    const card = (await screen.findByRole("heading", { name: "资料标签词表" })).closest(".card") as HTMLElement;
    expect(card).toBeTruthy();
    expect(await within(card).findByText("咨询复盘")).toBeTruthy();
    // 无「分类」列
    expect(within(card).queryByRole("columnheader", { name: "分类" })).toBeNull();

    // 创建：material 模式隐藏分类 select，body 带 domain=material 且不带 scope
    fireEvent.click(within(card).getByRole("button", { name: "新增资料标签" }));
    const dialog = screen.getByRole("dialog", { name: "新增资料标签" });
    expect(within(dialog).queryByLabelText("分类")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("标签名"), { target: { value: "行业案例" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/tags");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.body)) as Record<string, unknown>;
      expect(body.name).toBe("行业案例");
      expect(body.domain).toBe("material");
      expect("scope" in body).toBe(false);
    });

    // 删除：确认文案按域（已打标的资料）
    fireEvent.click(within(card).getByRole("button", { name: "删除" }));
    const confirm = screen.getByRole("dialog", { name: "删除标签" });
    expect(within(confirm).getByText(/已打标的资料将不再显示该标签/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/tags/11")).toBe(true),
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
