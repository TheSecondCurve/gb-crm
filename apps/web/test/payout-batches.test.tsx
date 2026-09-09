import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, operatorMe, renderApp } from "./helpers";
import type { PayoutBatchDetailDto, PayoutBatchRowDto } from "../src/api/types";

const dayMs = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

const draftRow: PayoutBatchRowDto = {
  id: 1,
  name: "发放 2026-09-01~2026-09-30",
  rangeStart: dayMs(2026, 9, 1),
  rangeEnd: dayMs(2026, 9, 30) + 86399999,
  status: "draft",
  itemCount: 2,
  totalAmountCents: 9000,
  lockedAt: null,
  paidAt: null,
  createdAt: dayMs(2026, 9, 1),
  updatedAt: dayMs(2026, 9, 1),
  createdBy: { id: 1, nickname: "管理员" },
};

const lockedRow: PayoutBatchRowDto = {
  ...draftRow,
  id: 2,
  name: "九月发放批次",
  status: "locked",
  lockedAt: dayMs(2026, 9, 2),
};

const paidRow: PayoutBatchRowDto = {
  ...draftRow,
  id: 3,
  name: "八月发放批次",
  status: "paid",
  lockedAt: dayMs(2026, 8, 2),
  paidAt: dayMs(2026, 8, 3),
};

const lockedDetail: PayoutBatchDetailDto = {
  batch: lockedRow,
  items: [
    {
      id: 11,
      dealId: 1,
      seq: 1,
      customer: { id: 101, nickname: "张三" },
      product: { id: 201, name: "产品A" },
      owner: { id: 1, nickname: "老王" },
      customerOwner: { id: 2, nickname: "小李" },
      dealDate: dayMs(2026, 8, 22),
      dealMonth: "2026-08",
      dealAmountCents: 100000,
      payoutDate: dayMs(2026, 9, 1),
      rate: 0.5,
      payoutAmountCents: 4500,
      payoutStatus: "pending",
      stale: false,
      shares: [
        { userId: 1, nickname: "老王", amountCents: 2700 },
        { userId: 2, nickname: "小李", amountCents: 1800 },
      ],
    },
  ],
  summary: [
    {
      userId: 1,
      nickname: "老王",
      totalAmountCents: 2700,
      byMonth: [{ month: "2026-08", amountCents: 2700 }],
      byProduct: [{ productId: 201, productName: "产品A", amountCents: 2700 }],
    },
    {
      userId: 2,
      nickname: "小李",
      totalAmountCents: 1800,
      byMonth: [{ month: "2026-08", amountCents: 1800 }],
      byProduct: [{ productId: 201, productName: "产品A", amountCents: 1800 }],
    },
  ],
};

const draftDetail: PayoutBatchDetailDto = { batch: draftRow, items: [], summary: [] };

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockPayoutApi(me: typeof adminMe) {
  const calls: Call[] = [];
  const rows = [draftRow, lockedRow, paidRow];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/payout-batches/candidates")) {
      return { status: 200, body: { data: [] } };
    }
    const detailMatch = /^\/api\/v1\/payout-batches\/(\d+)$/.exec(url);
    if (detailMatch && method === "GET") {
      const detail = Number(detailMatch[1]) === 2 ? lockedDetail : draftDetail;
      return { status: 200, body: { data: detail } };
    }
    const markPaidMatch = /^\/api\/v1\/payout-batches\/(\d+)\/mark-paid$/.exec(url);
    if (markPaidMatch && method === "POST") {
      return { status: 200, body: { data: lockedDetail, meta: { marked: 2, skipped: 0 } } };
    }
    if (url === "/api/v1/payout-batches" && method === "POST") {
      const body = JSON.parse(init?.body ?? "{}") as { name?: string; startDate: number; endDate: number };
      return {
        status: 200,
        body: {
          data: {
            ...draftDetail,
            batch: { ...draftRow, id: 9, name: body.name ?? "自动", rangeStart: body.startDate, rangeEnd: body.endDate },
          },
        },
      };
    }
    if (url.startsWith("/api/v1/payout-batches") && method === "GET") {
      return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
    }
  });
  return calls;
}

describe("分成发放（payout 批次）", () => {
  it("列表渲染：批次名/日期范围/状态 badge/金额/创建人", async () => {
    mockPayoutApi(adminMe);
    const { container } = renderApp("/deals/payout-batches");
    expect(await screen.findByText("九月发放批次")).toBeTruthy();
    expect(screen.getByText("八月发放批次")).toBeTruthy();
    // 日期范围与金额（元）
    expect(screen.getAllByText(/2026-09-01 ~ 2026-09-30/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥90.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("管理员").length).toBeGreaterThan(0);
    // 状态 badge（draft=muted / locked=plain / paid=accent）
    expect(container.querySelector(".badge.badge-muted")?.textContent).toBe("草稿");
    expect(container.querySelector(".badge.badge-accent")?.textContent).toBe("已发放");
    expect(screen.getAllByText("已锁定").length).toBeGreaterThan(0);
  });

  it("状态筛选触发新 query", async () => {
    const calls = mockPayoutApi(adminMe);
    renderApp("/deals/payout-batches");
    await screen.findByText("九月发放批次");

    fireEvent.change(screen.getByLabelText("状态筛选"), { target: { value: "locked" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=locked"))).toBe(true));
  });

  it("新建批次：提交 body 为名称 + 起止日期 epoch ms（止含当天 +86399999），随后跳转详情", async () => {
    const calls = mockPayoutApi(adminMe);
    renderApp("/deals/payout-batches");
    await screen.findByText("九月发放批次");

    fireEvent.click(screen.getByRole("button", { name: "新建批次" }));
    const dialog = await screen.findByRole("dialog", { name: "新建发放批次" });
    fireEvent.change(within(dialog).getByLabelText("批次名"), { target: { value: "九月发放" } });
    fireEvent.change(within(dialog).getByLabelText("开始日期"), { target: { value: "2026-09-01" } });
    fireEvent.change(within(dialog).getByLabelText("结束日期"), { target: { value: "2026-09-30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/payout-batches");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toEqual({
        name: "九月发放",
        startDate: dayMs(2026, 9, 1),
        endDate: dayMs(2026, 9, 30) + 86399999,
      });
    });
    // 跳转详情页（GET /payout-batches/9）
    await waitFor(() =>
      expect(calls.some((c) => c.method === "GET" && c.url === "/api/v1/payout-batches/9")).toBe(true),
    );
  });

  it("详情页：人员汇总按月列渲染 + 总计行；明细行展示分摊与 payout 状态", async () => {
    mockPayoutApi(operatorMe);
    renderApp("/deals/payout-batches/2");
    expect(await screen.findByText("人员汇总")).toBeTruthy();
    // 月份动态列 + 每人合计
    expect(screen.getByText("2026-08 成交")).toBeTruthy();
    expect(screen.getAllByText("¥27.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥18.00").length).toBeGreaterThan(0);
    // 总计行 = 27 + 18 = 45
    expect(screen.getByText("总计")).toBeTruthy();
    expect(screen.getAllByText("¥45.00").length).toBeGreaterThan(0);
    // 明细行：期次/比例/期金额/分摊/底层状态
    expect(screen.getByText("第1期")).toBeTruthy();
    expect(screen.getByText("50.0%")).toBeTruthy();
    expect(screen.getByText("老王 ¥27.00")).toBeTruthy();
    expect(screen.getByText("小李 ¥18.00")).toBeTruthy();
    expect(screen.getByText("待发")).toBeTruthy();
  });

  it("operator：可见写按钮（添加明细/锁定批次/删除批次/标记已发/解锁）", async () => {
    mockPayoutApi(operatorMe);
    renderApp("/deals/payout-batches/1");
    expect(await screen.findByText("人员汇总")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加明细" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "锁定批次" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除批次" })).toBeTruthy();
  });

  it("operator（locked 批次）：可见「标记已发/解锁」；确认后发出 POST mark-paid", async () => {
    const calls = mockPayoutApi(operatorMe);
    renderApp("/deals/payout-batches/2");
    expect(await screen.findByText("人员汇总")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "标记已发" }));
    const dialog = await screen.findByRole("dialog", { name: "确认操作" });
    expect(within(dialog).getByText(/全部待发 payout 将置为已发/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "POST" && c.url === "/api/v1/payout-batches/2/mark-paid"),
      ).toBe(true);
    });
    expect(await screen.findByText("已标记 2 条为已发")).toBeTruthy();
  });

  it("assistant：只读，所有写按钮隐藏", async () => {
    mockPayoutApi(assistantMe);
    renderApp("/deals/payout-batches/1");
    expect(await screen.findByText("人员汇总")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "添加明细" })).toBeNull();
    expect(screen.queryByRole("button", { name: "锁定批次" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除批次" })).toBeNull();
    expect(screen.queryByRole("button", { name: "标记已发" })).toBeNull();
    // 明细只读，无「移除」
    expect(screen.queryByRole("button", { name: "移除" })).toBeNull();
  });
});
