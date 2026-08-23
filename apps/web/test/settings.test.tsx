// 系统设置页（K46/K50/K51）：LLM 打标配置（仅 admin）+ 后台任务 tab（全角色，?tab=jobs）。
// 标签词表在「业务设置」页（/business-settings，K50）。
import { canAllowedPageKeys } from "@gb-crm/shared";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp } from "./helpers";
import type { BackgroundJobDto } from "../src/api/types";

interface Call {
  url: string;
  method: string;
  body?: string;
}

const jobs: BackgroundJobDto[] = [
  {
    id: 1,
    type: "customer-tags-generate-all",
    typeLabel: "全量生成客户标签",
    params: {},
    status: "succeeded",
    progress: { processed: 2, total: 2, succeeded: 2, failed: 0 },
    result: { total: 2, succeeded: 2, failed: 0, failures: [] },
    error: null,
    trigger: "manual",
    triggerSpec: null,
    createdBy: { id: 1, nickname: "管理员" },
    createdAt: 1000,
    startedAt: 1000,
    finishedAt: 2000,
  },
  {
    id: 2,
    type: "customer-tags-generate-all",
    typeLabel: "全量生成客户标签",
    params: {},
    status: "partial",
    progress: { processed: 2, total: 2, succeeded: 1, failed: 1 },
    result: {
      total: 2,
      succeeded: 1,
      failed: 1,
      failures: [{ customerId: 1, nickname: "张三", message: "LLM 服务返回 500" }],
    },
    error: null,
    trigger: "manual",
    triggerSpec: null,
    createdBy: { id: 1, nickname: "管理员" },
    createdAt: 3000,
    startedAt: 3000,
    finishedAt: 4000,
  },
];

function mockSettingsApi(me: typeof adminMe, jobRows = jobs) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/system/ai-config")) {
      return {
        status: 200,
        body: {
          data: { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKeySet: true, apiKeyMasked: "sk-a…5678" },
        },
      };
    }
    if (url.startsWith("/api/v1/background-jobs")) {
      if (url.includes("/cancel")) {
        return { status: 200, body: { data: { ...jobRows[0], status: "cancelled" } } };
      }
      const detail = url.match(/\/api\/v1\/background-jobs\/(\d+)$/);
      if (detail) {
        return { status: 200, body: { data: jobRows.find((j) => j.id === Number(detail[1])) } };
      }
      return { status: 200, body: { data: jobRows, meta: { page: 1, pageSize: 50, total: jobRows.length } } };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return calls;
}

describe("系统设置页", () => {
  it("LLM 配置：预填当前配置；保存 PATCH 只带变更键（apiKey 留空不发）", async () => {
    const calls = mockSettingsApi(adminMe);
    renderApp("/settings");

    // admin 默认落在「LLM 打标配置」tab
    const tab = await screen.findByRole("tab", { name: "LLM 打标配置" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
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

  it("assistant：可访问系统设置（后台任务 tab），无 LLM 打标配置", async () => {
    mockSettingsApi(assistantMe, []);
    renderApp("/settings");

    const tab = await screen.findByRole("tab", { name: "后台任务" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "LLM 打标配置" })).toBeNull();
    expect(await screen.findByText("暂无后台任务")).toBeTruthy();
  });

  it("后台任务 tab：?tab=jobs 渲染列表（状态/进度/触发/创建人）", async () => {
    mockSettingsApi(adminMe);
    renderApp("/settings?tab=jobs");

    const tab = await screen.findByRole("tab", { name: "后台任务" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findAllByText("全量生成客户标签")).toHaveLength(2);
    // 状态徽章（filter 下拉里也有同名 option，用数量断言徽章存在）
    expect(screen.getAllByText("成功").length).toBeGreaterThan(0);
    expect(screen.getAllByText("部分失败").length).toBeGreaterThan(0);
    expect(screen.getAllByText("手动").length).toBe(2);
    expect(screen.getAllByText("管理员").length).toBeGreaterThanOrEqual(2); // 表内 2 行 + 顶栏用户菜单
  });

  it("详情弹窗：展示失败明细（客户/原因）与耗时", async () => {
    mockSettingsApi(adminMe);
    renderApp("/settings?tab=jobs");
    const detailButtons = await screen.findAllByRole("button", { name: "详情" });

    fireEvent.click(detailButtons[1]!); // 第 2 行 partial
    const dialog = await screen.findByRole("dialog", { name: /任务详情 #2/ });
    expect(within(dialog).getByText("失败明细（1）")).toBeTruthy();
    expect(within(dialog).getByText("张三")).toBeTruthy();
    expect(within(dialog).getByText("LLM 服务返回 500")).toBeTruthy();
    expect(within(dialog).getByText("1.0s")).toBeTruthy(); // 4000-3000
  });

  it("取消任务：确认后 POST /background-jobs/:id/cancel", async () => {
    const calls = mockSettingsApi(adminMe, [
      { ...jobs[0]!, status: "queued", progress: { processed: 0, total: 2, succeeded: 0, failed: 0 }, startedAt: null, finishedAt: null },
      ...jobs.slice(1),
    ]);
    renderApp("/settings?tab=jobs");
    // 等列表真正加载（「排队中」会命中状态下拉 option，须等行内按钮出现）
    await screen.findAllByRole("button", { name: "详情" });

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const confirm = screen.getByRole("dialog", { name: "取消任务" });
    fireEvent.click(within(confirm).getByRole("button", { name: "取消任务" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/background-jobs/1/cancel")).toBe(true),
    );
  });

  it("admin：角色权限 tab 可勾选收缩并保存（operator 允许集内）", async () => {
    const calls: Call[] = [];
    mockFetch((url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body });
      if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
      if (url === "/api/v1/system/page-access") {
        return {
          status: 200,
          body: {
            data: {
              roles: {
                operator: {
                  allowed: canAllowedPageKeys("operator"),
                  enabled: ["my-customers", "customers"],
                },
                assistant: {
                  allowed: canAllowedPageKeys("assistant"),
                  enabled: canAllowedPageKeys("assistant"),
                },
              },
            },
          },
        };
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderApp("/settings?tab=roles");
    const cb = await screen.findByRole("checkbox", { name: "团队运营可访问客户信息" });
    expect(cb).toBeTruthy();
    fireEvent.click(cb); // 取消勾选客户信息

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const p = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/system/page-access");
      expect(p).toBeTruthy();
      expect(JSON.parse(String(p?.body))).toEqual({
        roles: { operator: ["my-customers"], assistant: canAllowedPageKeys("assistant") },
      });
    });
  });

  it("有执行中任务时自动轮询（3s 内再次请求列表）", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockSettingsApi(adminMe, [
        { ...jobs[0]!, status: "running", progress: { processed: 1, total: 2, succeeded: 1, failed: 0 }, startedAt: 1000, finishedAt: null },
        ...jobs.slice(1),
      ]);
      renderApp("/settings?tab=jobs");
      // 无真实计时器下驱动初始查询完成（轮询微任务直到「执行中」出现）
      await act(async () => {
        for (let i = 0; i < 50 && !document.body.textContent?.includes("执行中"); i += 1) {
          vi.advanceTimersByTime(0);
          await Promise.resolve();
        }
      });
      expect(screen.getByText("执行中")).toBeTruthy();

      const listGets = () =>
        calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/background-jobs")).length;
      const before = listGets();
      await act(async () => {
        vi.advanceTimersByTime(3200);
        await Promise.resolve();
      });
      expect(listGets()).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
