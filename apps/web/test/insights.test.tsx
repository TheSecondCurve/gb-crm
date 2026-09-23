// K62 透视台 Web：结论行/热度矩阵/格子→客户清单→深潜抽屉 + assistant 无入口（pageAccess）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { adminMe, assistantMe, emptyList, mockFetch, renderApp } from "./helpers";

const pivotBody = {
  data: {
    axes: { x: { key: "city", label: "城市" }, y: { key: "stageTag", label: "阶段标签" } },
    windowDays: 90,
    total: 2,
    rows: [
      {
        y: "意向客户",
        total: 1,
        cells: [
          { x: "上海", y: "意向客户", count: 1, customerIds: [11], sample: ["王总"] },
          { x: "成都", y: "意向客户", count: 0, customerIds: [], sample: [] },
        ],
      },
      {
        y: "未打标",
        total: 1,
        cells: [
          { x: "上海", y: "未打标", count: 0, customerIds: [], sample: [] },
          { x: "成都", y: "未打标", count: 1, customerIds: [12], sample: ["陈小姐"] },
        ],
      },
    ],
    columns: [
      { x: "上海", total: 1 },
      { x: "成都", total: 1 },
    ],
  },
  meta: { calibre: {}, windowDays: 90, generatedAt: 1 },
};

const depthBody = {
  data: {
    customer: { id: 11, nickname: "王总", city: "上海", customerType: "customer", ownerName: "管理员" },
    temperature: 52,
    temperatureBand: "warm",
    temperatureSeries: [
      { at: 1, temp: 10 },
      { at: 2, temp: 52 },
    ],
    paidTotalCents: 1200000,
    ladder: "咨询",
    signalTypes: ["need"],
    signals: [
      {
        id: 1,
        type: "need",
        typeLabel: "需求",
        topicName: "小红书运营",
        content: "找小红书运营资源，团队无人懂",
        sourceType: "maintenance_record",
        sourceAt: 1790000000000,
        mentionCount: 2,
        confidence: 0.9,
        status: "active",
        expiresAt: null,
      },
    ],
  },
  meta: { calibre: {} },
};

function mockInsights() {
  mockFetch((url) => {
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
    if (url.startsWith("/api/v1/insights/pivot")) return { status: 200, body: pivotBody };
    if (url.startsWith("/api/v1/insights/customers/11/depth")) return { status: 200, body: depthBody };
    return emptyList();
  });
}

describe("全景透视台", () => {
  it("admin：结论行 + 矩阵渲染；格子→客户清单→深潜抽屉", async () => {
    mockInsights();
    renderApp("/insights");
    expect(await screen.findByRole("heading", { name: "全景透视台" })).toBeTruthy();
    // 人话结论行（等数据就绪）
    expect(await screen.findByText(/2 位客户/)).toBeTruthy();
    // 热度格子（按 aria-label 找）
    const cell = screen.getByRole("button", { name: "意向客户 × 上海：1 位客户" });
    fireEvent.click(cell);
    expect(await screen.findByRole("dialog", { name: "客户清单：意向客户 × 上海" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "王总" }));
    const drawer = await screen.findByRole("dialog", { name: "客户深潜" });
    await waitFor(() => {
      expect(drawer.textContent).toContain("52°");
    });
    expect(drawer.textContent).toContain("找小红书运营资源");
    expect(drawer.textContent).toContain("¥12,000");
    expect(drawer.textContent).toContain("提及 2 次");
  });

  it("换轴触发重新请求（经/纬下拉）", async () => {
    const fetchSpy = vi.fn();
    mockFetch((url) => {
      if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
      fetchSpy(url);
      if (url.startsWith("/api/v1/insights/pivot")) return { status: 200, body: pivotBody };
      return emptyList();
    });
    renderApp("/insights");
    await screen.findByRole("heading", { name: "全景透视台" });
    await screen.findByText(/2 位客户/);
    fireEvent.change(screen.getByLabelText(/纬（行）/), { target: { value: "city" } });
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("y=city"));
    });
  });

  it("assistant：无「客户洞察」入口（can() 拒绝 insights）", async () => {
    mockFetch((url) => {
      if (url === "/api/v1/auth/me") return { status: 200, body: { data: assistantMe } };
      return emptyList();
    });
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });
    expect(screen.queryByRole("link", { name: "全景透视台" })).toBeNull();
  });

  it("admin 侧栏出现「全景透视台」入口（客户洞察组）", async () => {
    mockInsights();
    renderApp("/insights");
    expect(await screen.findByRole("heading", { name: "全景透视台" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "全景透视台" })).toBeTruthy();
  });
});

describe("AI 经营备忘（四期）", () => {
  it("点按钮 → POST /insights/summary → 展示备忘与来源徽标", async () => {
    mockFetch((url, init) => {
      if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
      if (url.startsWith("/api/v1/insights/summary") && init?.method === "POST") {
        return { status: 200, body: { data: { source: "llm", summary: "先唤醒沉睡客户，再跟进断线线索。", generatedAt: 1 } } };
      }
      if (url.startsWith("/api/v1/insights/pivot")) return { status: 200, body: pivotBody };
      return emptyList();
    });
    renderApp("/insights");
    await screen.findByText(/2 位客户/);
    fireEvent.click(screen.getByRole("button", { name: /AI 经营备忘/ }));
    const summary = await screen.findByTestId("ai-summary");
    expect(summary.textContent).toContain("先唤醒沉睡客户");
    expect(summary.textContent).toContain("AI 生成");
  });
});
