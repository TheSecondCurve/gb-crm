// 系统设置页（K46/K50）：LLM 配置保存；非 admin 无权限。标签词表已拆到「业务设置」页。
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp } from "./helpers";

interface Call {
  url: string;
  method: string;
  body?: string;
}

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

  it("assistant：无权限访问系统设置", async () => {
    mockSettingsApi(assistantMe);
    renderApp("/settings");
    expect(await screen.findByText("没有权限访问系统设置")).toBeTruthy();
    expect(screen.queryByText("LLM 打标配置")).toBeNull();
  });
});
