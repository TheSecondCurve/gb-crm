// 系统设置页（K45/K46）：LLM 配置保存 / 标签词表 CRUD / 非 admin 无权限。
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

function mockSettingsApi(me: typeof adminMe) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/system/ai-config")) {
      if (method === "GET") {
        return {
          status: 200,
          body: {
            data: { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKeySet: true, apiKeyMasked: "sk-a…5678" },
          },
        };
      }
      return {
        status: 200,
        body: { data: { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKeySet: true, apiKeyMasked: "sk-a…5678" } },
      };
    }
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

describe("系统设置页", () => {
  it("LLM 配置：预填当前配置；保存 PATCH 只带变更键（apiKey 留空不发）", async () => {
    const calls = mockSettingsApi(adminMe);
    renderApp("/settings");

    expect(await screen.findByText("LLM 打标配置")).toBeTruthy();
    // 配置加载后自动预填（等值出现，而非渲染瞬间）
    expect(
      (await screen.findByDisplayValue("https://api.deepseek.com/v1")) as HTMLInputElement,
    ).toBeTruthy();
    expect((await screen.findByDisplayValue("deepseek-chat")) as HTMLInputElement).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("如 deepseek-chat"), { target: { value: "deepseek-reasoner" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/system/ai-config");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ model: "deepseek-reasoner" });
    });
  });

  it("标签词表：新增（POST）→ 修改（PATCH）→ 删除（DELETE）", async () => {
    const calls = mockSettingsApi(adminMe);
    renderApp("/settings");
    await screen.findByText("标签词表");

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

  it("assistant：无权限访问（不显示配置与词表）", async () => {
    mockSettingsApi(assistantMe);
    renderApp("/settings");
    expect(await screen.findByText("没有权限访问系统设置")).toBeTruthy();
    expect(screen.queryByText("LLM 打标配置")).toBeNull();
    expect(screen.queryByText("标签词表")).toBeNull();
  });
});
