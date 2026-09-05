import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp } from "./helpers";
import type { DealCommissionDto } from "../src/api/types";

const deliveryMs = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

/** 未配置的成交（套默认方案） */
const defaultRow: DealCommissionDto = {
  dealId: 1,
  customer: { id: 101, nickname: "张三", city: "上海" },
  product: { id: 201, name: "产品A" },
  owner: { id: 1, nickname: "老王" },
  stage: "paid",
  orderNo: "ORD-001",
  dealDate: deliveryMs(2026, 8, 22),
  deliveryDate: deliveryMs(2026, 9, 1),
  amountCents: 100000,
  afterTaxRatio: 0.9,
  baseAmountCents: 90000,
  isCustomized: false,
  items: [{ userId: 1, nickname: "老王", percentage: 0.1, amountCents: 9000 }],
  totalPercentage: 0.1,
  totalAmountCents: 9000,
};

/** 已配置的成交 */
const customRow: DealCommissionDto = {
  ...defaultRow,
  dealId: 2,
  customer: { id: 102, nickname: "李四", city: null },
  isCustomized: true,
  items: [
    { userId: 1, nickname: "老王", percentage: 0.06, amountCents: 5400 },
    { userId: 2, nickname: "小李", percentage: 0.04, amountCents: 3600 },
  ],
  totalPercentage: 0.1,
  totalAmountCents: 9000,
};

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockCommissionsApi(me: typeof adminMe, rows: DealCommissionDto[] = [defaultRow, customRow]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/users")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 1, username: "a", nickname: "老王", accountStatus: "enabled" },
            { id: 2, username: "b", nickname: "小李", accountStatus: "enabled" },
          ],
          meta: { page: 1, pageSize: 100, total: 2 },
        },
      };
    }
    if (url.startsWith("/api/v1/system/commission-default")) {
      if (method === "GET") {
        return {
          status: 200,
          body: {
            data: {
              rules: [
                { source: "owner", percentage: 0.02 },
                { source: "dealOwner", percentage: 0.04 },
              ],
            },
          },
        };
      }
      if (method === "PATCH") return { status: 200, body: { data: JSON.parse(init?.body ?? "{}") } };
    }
    if (url.startsWith("/api/v1/deals/commissions") && method === "GET") {
      return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
    }
    const putMatch = /\/api\/v1\/deals\/(\d+)\/commissions$/.exec(url);
    if (putMatch && method === "PUT") {
      return { status: 200, body: { data: { ...rows.find((r) => r.dealId === Number(putMatch[1]))!, isCustomized: true } } };
    }
  });
  return calls;
}

describe("成交分成页", () => {
  it("admin：渲染列表、默认/已配置徽章、分成明细与总金额", async () => {
    mockCommissionsApi(adminMe);
    renderApp("/deals/commissions");
    expect(await screen.findByText("张三")).toBeTruthy();
    expect(screen.getByText("李四")).toBeTruthy();
    // 成交产品/交付日期/负责人列
    expect(screen.getAllByText("产品A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-09-01").length).toBeGreaterThan(0);
    expect(screen.getAllByText("老王").length).toBeGreaterThan(0);
    // 未配置行：默认 badge + 负责人分成（比例+金额）
    expect(screen.getByText("默认")).toBeTruthy();
    expect(screen.getByText("10.0%(¥90.00)")).toBeTruthy();
    // 已配置行（状态下拉里也有一个「已配置」option，故用 getAllByText）
    expect(screen.getAllByText("已配置").length).toBeGreaterThan(0);
    expect(screen.getByText("6.0%(¥54.00)")).toBeTruthy();
    expect(screen.getByText("小李 4.0%(¥36.00)")).toBeTruthy();
    expect(screen.getAllByText("¥900.00").length).toBeGreaterThan(0); // 两行税后基数相同
    // admin 可见默认方案编辑器
    expect(screen.getByText("默认分成方案")).toBeTruthy();
  });

  it("状态筛选触发新 query", async () => {
    const calls = mockCommissionsApi(adminMe);
    renderApp("/deals/commissions");
    await screen.findByText("张三");

    fireEvent.change(screen.getByLabelText("分成状态"), { target: { value: "custom" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=custom"))).toBe(true));
  });

  it("日期范围筛选触发新 query", async () => {
    const calls = mockCommissionsApi(adminMe);
    renderApp("/deals/commissions");
    await screen.findByText("张三");

    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-08-01" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("startDate="))).toBe(true));
  });

  it("admin：编辑分成 → PUT /deals/:id/commissions", async () => {
    const calls = mockCommissionsApi(adminMe);
    renderApp("/deals/commissions");
    await screen.findByText("张三");

    fireEvent.click(screen.getAllByRole("button", { name: "配置" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: /配置分成/ });
    // 预填当前成交人（老王）——option 文本为「老王(#1)」
    expect(within(dialog).getByText(/老王/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && c.url === "/api/v1/deals/1/commissions");
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put?.body))).toEqual({ items: [{ userId: 1, percentage: 0.1 }] });
    });
  });

  it("assistant：只读，无配置按钮/无默认方案编辑器", async () => {
    mockCommissionsApi(assistantMe);
    renderApp("/deals/commissions");
    expect(await screen.findByText("张三")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "配置" })).toBeNull();
    expect(screen.queryByText("默认分成方案")).toBeNull();
  });
});
