// K62 二期决策台 Web：四页渲染 + 结论行 + 客户名深潜 + 侧栏入口。
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { adminMe, emptyList, mockFetch, renderApp } from "./helpers";

const geoBody = {
  data: {
    windowDays: 90,
    total: 2,
    conclusion: "上海：1 位暖客户、1 条活跃需求、从未办过场次——建议排期",
    cities: [
      {
        city: "上海",
        customers: 1,
        warm: 1,
        hot: 0,
        paidTotalCents: 500000,
        activeNeeds: 1,
        renewals: 0,
        eventAttendance: 0,
        customerIds: [11],
        sample: ["王总"],
      },
    ],
  },
  meta: { calibre: {} },
};

const ladderBody = {
  data: {
    windowDays: 90,
    conclusion: "1 位客户站在升级门口（有明确意向信号），最高梯级待升级 圈子×1",
    rungs: [
      { key: "none", label: "未成交", count: 1, sample: [], customerIds: [], upgradeReadyCount: 0, upgradeReady: [] },
      { key: "circle", label: "圈子", count: 1, sample: [], customerIds: [11], upgradeReadyCount: 1, upgradeReady: [{ customerId: 11, nickname: "王总", nextLabel: "多类复购", evidence: "对私董有意向", topic: "私董" }] },
    ],
    staleTagCount: 1,
    staleTagCandidates: [{ customerId: 12, nickname: "只贴标签", stageTags: ["意向客户"] }],
  },
  meta: { calibre: {} },
};

const intentBody = {
  data: {
    windowDays: 90,
    total: 1,
    conclusion: "当前最热的需求主题是「私董」（1 条活跃意向、覆盖 1 城）；其中 1 位已有成交记录——交叉销售窗口",
    crossSellCount: 1,
    topics: [{ topic: "私董", count: 1, cityCount: 1 }],
    rows: [
      { customerId: 11, nickname: "王总", type: "intent", typeLabel: "明确意向", topic: "私董", content: "想了解私董", sourceAt: 1790000000000, temperature: 52, city: "上海", crossSell: true, mentionCount: 1 },
    ],
  },
  meta: { calibre: {} },
};

const guardBody = {
  data: {
    windowDays: 90,
    total: 2,
    highCount: 1,
    sleepingWhaleValueCents: 2000000,
    conclusion: "2 条待干预（紧急 1），其中沉睡金主在册价值 ¥20,000",
    items: [
      { kind: "sleeping_whale", kindLabel: "沉睡金主", urgency: "high", customerId: 11, nickname: "王总", reason: "累计已付 ¥20,000，温度 3°，无触点记录", action: "安排唤醒触达（专属话术）", at: 0 },
      { kind: "renewal_window", kindLabel: "续费窗口", urgency: "mid", customerId: 12, nickname: "陈小姐", reason: "《3 期圈子》15 天后到期", action: "谈续费", at: 1790500000000 },
    ],
  },
  meta: { calibre: {} },
};

const depthBody = {
  data: {
    customer: { id: 11, nickname: "王总", city: "上海", customerType: "customer", ownerName: "管理员" },
    temperature: 52,
    temperatureBand: "warm",
    temperatureSeries: [{ at: 1, temp: 10 }, { at: 2, temp: 52 }],
    paidTotalCents: 1200000,
    ladder: "圈子",
    signalTypes: ["intent"],
    signals: [],
  },
  meta: { calibre: {} },
};

function mockAll() {
  mockFetch((url) => {
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
    if (url.startsWith("/api/v1/insights/geo")) return { status: 200, body: geoBody };
    if (url.startsWith("/api/v1/insights/ladder")) return { status: 200, body: ladderBody };
    if (url.startsWith("/api/v1/insights/intent")) return { status: 200, body: intentBody };
    if (url.startsWith("/api/v1/insights/guard")) return { status: 200, body: guardBody };
    if (url.startsWith("/api/v1/insights/customers/11/depth")) return { status: 200, body: depthBody };
    return emptyList();
  });
}

describe("决策台四页", () => {
  it("选址台：结论行 + 城市卡 + 点客户名深潜", async () => {
    mockAll();
    renderApp("/insights/geo");
    expect(await screen.findByRole("heading", { name: "选址台" })).toBeTruthy();
    expect(await screen.findByText(/从未办过场次——建议排期/)).toBeTruthy();
    expect(screen.getByText("上海")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "王总" }));
    const drawer = await screen.findByRole("dialog", { name: "客户深潜" });
    await waitFor(() => {
      expect(drawer.textContent).toContain("52°");
    });
  });

  it("阶梯台：升级就绪 + 标签过期候选", async () => {
    mockAll();
    renderApp("/insights/ladder");
    const headline = await screen.findByTestId("decision-headline");
    expect(headline.textContent).toContain("站在升级门口");
    expect(screen.getByText("→ 多类复购")).toBeTruthy();
    expect(screen.getByText(/标签过期候选/)).toBeTruthy();
  });

  it("意图台：topic 芯片 + 清单 + 交叉销售徽标", async () => {
    mockAll();
    renderApp("/insights/intent");
    expect(await screen.findByText(/最热的需求主题是「私董」/)).toBeTruthy();
    expect(screen.getByText("交叉销售")).toBeTruthy();
    expect(screen.getByText("想了解私董")).toBeTruthy();
  });

  it("守护台：队列 + 紧急在前 + 建议动作", async () => {
    mockAll();
    renderApp("/insights/guard");
    expect(await screen.findByText(/沉睡金主在册价值 ¥20,000/)).toBeTruthy();
    expect(screen.getByText("谈续费")).toBeTruthy();
    const kinds = await screen.findAllByText(/沉睡金主|续费窗口/);
    expect(kinds.length).toBeGreaterThanOrEqual(2);
  });

  it("侧栏出现四张决策台入口", async () => {
    mockAll();
    renderApp("/insights");
    expect(await screen.findByRole("link", { name: "选址台" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "阶梯台" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "意图台" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "守护台" })).toBeTruthy();
  });
});
