// 业务设置页（K50/K51）：tab「客户标签词表」CRUD（admin）/ assistant 只读；tab「后台任务」列表/详情/取消。
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp } from "./helpers";
import type { BackgroundJobDto } from "../src/api/types";

interface Call {
  url: string;
  method: string;
  body?: string;
}

const tags = [
  { id: 1, name: "创业者", scope: "identity", sort: 1, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null },
  { id: 2, name: "已成交", scope: "stage", sort: 1, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null },
];

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

function mockBusinessSettingsApi(me: typeof adminMe, jobRows = jobs) {
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

describe("业务设置页", () => {
  it("admin：渲染 tab「客户标签词表」+ 词表 CRUD（新增 → 修改 → 删除）", async () => {
    const calls = mockBusinessSettingsApi(adminMe);
    renderApp("/business-settings");

    expect(await screen.findByRole("heading", { name: "业务设置" })).toBeTruthy();
    // tab 存在且选中
    const tab = screen.getByRole("tab", { name: "客户标签词表" });
    expect(tab.getAttribute("aria-selected")).toBe("true");

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

    expect(await screen.findByRole("tab", { name: "客户标签词表" })).toBeTruthy();
    expect(await screen.findByText("创业者")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新增标签" })).toBeNull();
    expect(screen.queryByRole("button", { name: "修改" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("后台任务 tab：?tab=jobs 渲染列表（状态/进度/触发/创建人）", async () => {
    mockBusinessSettingsApi(adminMe);
    renderApp("/business-settings?tab=jobs");

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
    mockBusinessSettingsApi(adminMe);
    renderApp("/business-settings?tab=jobs");
    const detailButtons = await screen.findAllByRole("button", { name: "详情" });

    fireEvent.click(detailButtons[1]!); // 第 2 行 partial
    const dialog = await screen.findByRole("dialog", { name: /任务详情 #2/ });
    expect(within(dialog).getByText("失败明细（1）")).toBeTruthy();
    expect(within(dialog).getByText("张三")).toBeTruthy();
    expect(within(dialog).getByText("LLM 服务返回 500")).toBeTruthy();
    expect(within(dialog).getByText("1.0s")).toBeTruthy(); // 4000-3000
  });

  it("取消任务：确认后 POST /background-jobs/:id/cancel", async () => {
    const calls = mockBusinessSettingsApi(adminMe, [
      { ...jobs[0]!, status: "queued", progress: { processed: 0, total: 2, succeeded: 0, failed: 0 }, startedAt: null, finishedAt: null },
      ...jobs.slice(1),
    ]);
    renderApp("/business-settings?tab=jobs");
    // 等列表真正加载（「排队中」会命中状态下拉 option，须等行内按钮出现）
    await screen.findAllByRole("button", { name: "详情" });

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const confirm = screen.getByRole("dialog", { name: "取消任务" });
    fireEvent.click(within(confirm).getByRole("button", { name: "取消任务" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/background-jobs/1/cancel")).toBe(true),
    );
  });

  it("有执行中任务时自动轮询（3s 内再次请求列表）", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockBusinessSettingsApi(adminMe, [
        { ...jobs[0]!, status: "running", progress: { processed: 1, total: 2, succeeded: 1, failed: 0 }, startedAt: 1000, finishedAt: null },
        ...jobs.slice(1),
      ]);
      renderApp("/business-settings?tab=jobs");
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
