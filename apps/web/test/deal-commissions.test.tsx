import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp } from "./helpers";
import type { DealCommissionDto } from "../src/api/types";

const deliveryMs = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

/** 未配置的成交（套默认方案）：成交负责人=老王、客户归属人=小李 */
const defaultRow: DealCommissionDto = {
  dealId: 1,
  customer: { id: 101, nickname: "张三", city: "上海", owner: { id: 2, nickname: "小李" } },
  customerOwner: { id: 2, nickname: "小李" },
  product: { id: 201, name: "产品A" },
  owner: { id: 1, nickname: "老王" },
  stage: "paid",
  orderNo: "ORD-001",
  dealDate: deliveryMs(2026, 8, 22),
  deliveryDate: deliveryMs(2026, 9, 1),
  amountCents: 100000,
  afterTaxRatio: 0.9,
  totalRatio: 0.1,
  dealCommissionRatio: null,
  productCommissionRatio: null,
  baseAmountCents: 90000,
  poolAmountCents: 9000,
  isCustomized: false,
  items: [
    { userId: 1, nickname: "老王", percentage: 0.06, amountCents: 540 },
    { userId: 2, nickname: "小李", percentage: 0.04, amountCents: 360 },
  ],
  totalPercentage: 0.1,
  totalAmountCents: 900,
  payouts: [],
};

/** 已配置的成交：成交负责人=老王、客户归属人=小李 */
const customRow: DealCommissionDto = {
  ...defaultRow,
  dealId: 2,
  customer: { id: 102, nickname: "李四", city: null, owner: { id: 2, nickname: "小李" } },
  customerOwner: { id: 2, nickname: "小李" },
  isCustomized: true,
  payouts: [
    { seq: 1, payoutDate: deliveryMs(2026, 9, 1), rate: 0.5, amountCents: 4500, status: "pending", paidAt: null },
  ],
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
              totalRatio: 0.05,
              rules: [
                { source: "dealOwner", percentage: 0.02 },
                { source: "owner", percentage: 0.02 },
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
    const payoutPutMatch = /\/api\/v1\/deals\/(\d+)\/payouts$/.exec(url);
    if (payoutPutMatch && method === "PUT") {
      return {
        status: 200,
        body: {
          data: (JSON.parse(init?.body ?? "{}") as { payouts: { seq: number; payoutDate: number; rate: number }[] })
            .payouts.map((p) => ({
              seq: p.seq,
              payoutDate: p.payoutDate,
              rate: p.rate,
              amountCents: 4500,
              status: "pending",
              paidAt: null,
            })),
        },
      };
    }
    const payoutPatchMatch = /\/api\/v1\/deals\/(\d+)\/payouts\/(\d+)$/.exec(url);
    if (payoutPatchMatch && method === "PATCH") {
      const body = JSON.parse(init?.body ?? "{}") as { status: "pending" | "paid" };
      return {
        status: 200,
        body: {
          data: {
            seq: Number(payoutPatchMatch[2]),
            payoutDate: deliveryMs(2026, 9, 1),
            rate: 0.5,
            amountCents: 4500,
            status: body.status,
            paidAt: body.status === "paid" ? deliveryMs(2026, 10, 1) : null,
          },
        },
      };
    }
  });
  return calls;
}

describe("成交分成页", () => {
  it("admin：渲染列表、默认/已配置徽章、双人/总比例/分红池/分成明细与 payout", async () => {
    mockCommissionsApi(adminMe);
    renderApp("/deals/commissions");
    expect(await screen.findByText("张三")).toBeTruthy();
    expect(screen.getByText("李四")).toBeTruthy();
    // 成交产品/交付日期/负责人/客户归属人列
    expect(screen.getAllByText("产品A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-09-01").length).toBeGreaterThan(0);
    expect(screen.getAllByText("老王").length).toBeGreaterThan(0);
    expect(screen.getAllByText("小李").length).toBeGreaterThan(0); // 客户归属人 + 参与方
    // 总比例 / 分红池 / 税后基数（两行相同）
    expect(screen.getAllByText("10.0%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥90.00").length).toBeGreaterThan(0); // 分红池
    expect(screen.getAllByText("¥900.00").length).toBeGreaterThan(0); // 税后基数
    // 未配置行：默认 badge + 负责人分成 + 其他参与方
    expect(screen.getByText("默认")).toBeTruthy();
    expect(screen.getAllByText("6.0%(¥5.40)").length).toBeGreaterThan(0); // 负责人分成
    expect(screen.getAllByText("小李 4.0%(¥3.60)").length).toBeGreaterThan(0); // 其他参与方
    // 已配置行：payout 显示（金额=分红池×rate=¥45.00 待发）
    expect(screen.getAllByText("已配置").length).toBeGreaterThan(0);
    expect(screen.getByText(/2026-09-01 50\.0%\(¥45\.00 待发\)/)).toBeTruthy();
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

    fireEvent.change(screen.getByLabelText("成交日期开始"), { target: { value: "2026-08-01" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("startDate="))).toBe(true));
  });

  it("默认按交付日期不为空过滤；切换交付日期空否触发新 query", async () => {
    const calls = mockCommissionsApi(adminMe);
    renderApp("/deals/commissions");
    await screen.findByText("张三");

    // 默认条件：交付日期不为空
    expect(calls.some((c) => c.url.includes("deliveryStatus=notEmpty"))).toBe(true);

    // 切到「未填」
    fireEvent.change(screen.getByLabelText("交付日期空否"), { target: { value: "empty" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("deliveryStatus=empty"))).toBe(true));

    // 设置交付日期范围
    fireEvent.change(screen.getByLabelText("交付日期开始"), { target: { value: "2026-09-01" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("deliveryStartDate="))).toBe(true));
  });

  it("payout 状态过滤触发新 query", async () => {
    const calls = mockCommissionsApi(adminMe);
    renderApp("/deals/commissions");
    await screen.findByText("张三");

    fireEvent.change(screen.getByLabelText("payout 状态"), { target: { value: "pending" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("payoutStatus=pending"))).toBe(true));
  });

  it("admin：payout 状态切换 → PATCH /deals/:id/payouts/:seq", async () => {
    const calls = mockCommissionsApi(adminMe);
    renderApp("/deals/commissions");
    await screen.findByText("张三");

    fireEvent.click(screen.getAllByRole("button", { name: "切换第 1 期状态" })[0]!);
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deals/2/payouts/1");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ status: "paid" });
    });
  });

  it("admin：配置 payout → PUT /deals/:id/payouts", async () => {
    const calls = mockCommissionsApi(adminMe);
    renderApp("/deals/commissions");
    await screen.findByText("张三");

    fireEvent.click(screen.getAllByRole("button", { name: "配置 payout" })[1]!);
    const dialog = await screen.findByRole("dialog", { name: /配置 payout/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && c.url === "/api/v1/deals/2/payouts");
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put?.body))).toEqual({
        payouts: [{ seq: 1, payoutDate: deliveryMs(2026, 9, 1), rate: 0.5 }],
      });
    });
  });

  it("admin：编辑分成 → PUT /deals/:id/commissions", async () => {
    const calls = mockCommissionsApi(adminMe);
    renderApp("/deals/commissions");
    await screen.findByText("张三");

    fireEvent.click(screen.getAllByRole("button", { name: "配置分成" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: /配置分成/ });
    // 预填当前成交人（老王 + 小李）——option 文本为「老王(#1)」「小李(#2)」
    expect(within(dialog).getAllByText(/老王/).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(/小李/).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && c.url === "/api/v1/deals/1/commissions");
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put?.body))).toEqual({
        items: [
          { userId: 1, percentage: 0.06 },
          { userId: 2, percentage: 0.04 },
        ],
      });
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
