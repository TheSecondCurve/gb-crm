// K62 三期 Web：缘分清单（配对卡 + 关联召回徽标 + 深潜）+ 洞察词表（健康度 + 同义合并操作）。
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { adminMe, emptyList, mockFetch, renderApp } from "./helpers";

const matchBody = {
  data: {
    windowDays: 90,
    total: 1,
    conclusion: "1 对撮合建议；「小红书运营」供需两头连上了（1 对，含词表关联召回）——凑一桌条件成熟",
    topics: [{ topic: "小红书运营", needCount: 1, supplyCount: 0, cityCount: 1 }],
    pairs: [
      {
        needCustomerId: 11,
        needNickname: "王总",
        supplyCustomerId: 12,
        supplyNickname: "陈小姐",
        topic: "小红书运营",
        viaRelated: true,
        score: 2.7,
        sameCity: true,
        sharedDeliveries: 0,
        needEvidence: "找小红书运营资源，团队无人懂",
        supplyEvidence: "开小红书代运营工作室",
      },
    ],
  },
  meta: { calibre: {} },
};

const topicsBody = {
  data: [
    { id: 1, name: "小红书运营", enabled: 1, signalCount: 3, needCount: 2, supplyCount: 1, relatedNames: ["小红书代运营"] },
    { id: 2, name: "小红书代运营", enabled: 1, signalCount: 1, needCount: 0, supplyCount: 1, relatedNames: ["小红书运营"] },
  ],
  meta: { page: 1, pageSize: 100, total: 2 },
};

const depthBody = {
  data: {
    customer: { id: 11, nickname: "王总", city: "上海", customerType: "customer", ownerName: null },
    temperature: 40,
    temperatureBand: "warm",
    temperatureSeries: [{ at: 1, temp: 5 }, { at: 2, temp: 40 }],
    paidTotalCents: 0,
    ladder: "未成交",
    signalTypes: ["need"],
    signals: [],
  },
  meta: { calibre: {} },
};

function mockAll() {
  mockFetch((url, init) => {
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
    if (url.startsWith("/api/v1/insights/match")) return { status: 200, body: matchBody };
    if (url.startsWith("/api/v1/insights/topics") && init?.method === "POST") {
      return { status: 200, body: { data: { id: 2, intoId: 1, merged: true } } };
    }
    if (url.startsWith("/api/v1/insights/topics")) return { status: 200, body: topicsBody };
    if (url.startsWith("/api/v1/insights/customers/11/depth")) return { status: 200, body: depthBody };
    return emptyList();
  });
}

describe("缘分清单", () => {
  it("配对卡 + 关联召回徽标 + 建议动作 + 点客户名深潜", async () => {
    mockAll();
    renderApp("/insights/match");
    expect(await screen.findByText(/凑一桌条件成熟/)).toBeTruthy();
    expect(screen.getByText("经词表关联")).toBeTruthy();
    expect(screen.getByText(/一对一引荐/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "王总" }));
    const drawer = await screen.findByRole("dialog", { name: "客户深潜" });
    await waitFor(() => {
      expect(drawer.textContent).toContain("40°");
    });
  });
});

describe("洞察词表", () => {
  it("健康度表格 + related 边 + 同义合并操作成功提示", async () => {
    mockAll();
    renderApp("/insights/topics");
    expect(await screen.findAllByText("小红书运营")).not.toHaveLength(0);
    expect(screen.getAllByText("小红书代运营").length).toBeGreaterThan(0);
    // 选目标词并合并（每行各有一个合并按钮，取第二个非禁用的）
    fireEvent.change(screen.getByLabelText("合并 小红书代运营 到"), { target: { value: "1" } });
    const mergeButtons = screen.getAllByRole("button", { name: "合并" });
    const enabled = mergeButtons.find((b) => !b.hasAttribute("disabled"));
    expect(enabled).toBeTruthy();
    fireEvent.click(enabled!);
    await waitFor(() => {
      expect(screen.getByText(/已合并：历史信号与关联边已改指目标词/)).toBeTruthy();
    });
  });

  it("侧栏出现「缘分清单」「洞察词表」入口", async () => {
    mockAll();
    renderApp("/insights");
    expect(await screen.findByRole("link", { name: "缘分清单" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "洞察词表" })).toBeTruthy();
  });
});
