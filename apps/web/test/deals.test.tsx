import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { DealDto } from "../src/api/types";

const deliveryMs = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

const deal: DealDto = {
  id: 1,
  customerId: 101,
  productId: 201,
  ownerId: 1,
  stage: "paid",
  orderNo: "ORD-001",
  paymentRemark: null,
  dealDate: deliveryMs(2026, 8, 22),
  deliveryDate: deliveryMs(2026, 8, 22),
  amountCents: 39800,
  afterTaxRatio: 0.9306,
  customer: { id: 101, nickname: "张三", city: "上海" },
  product: { id: 201, name: "咨询产品" },
  owner: { id: 1, nickname: "老王" },
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockDealsApi(me: Me, rows: DealDto[] = [deal], failDelete = false) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    // 关系选项 loader（表单弹窗/单元格 relation-one：GET /customers /products /users）
    if (url.startsWith("/api/v1/users")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 1, nickname: "老王" },
            { id: 2, nickname: "小李" },
          ],
          meta: { page: 1, pageSize: 100, total: 2 },
        },
      };
    }
    if (url.startsWith("/api/v1/customers")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 101, nickname: "张三", city: "上海" },
            { id: 102, nickname: "李四", city: null },
          ],
          meta: { page: 1, pageSize: 100, total: 2 },
        },
      };
    }
    if (url.startsWith("/api/v1/products")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 201, name: "咨询产品" },
            { id: 202, name: "圈子订阅" },
          ],
          meta: { page: 1, pageSize: 100, total: 2 },
        },
      };
    }
    if (url.startsWith("/api/v1/deals")) {
      if (method === "GET") {
        return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
      }
      if (method === "POST") {
        return { status: 201, body: { data: { ...deal, id: 99 } } };
      }
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { data: { ...deal, ...patch, updatedAt: 2001 } } };
      }
      if (method === "DELETE") {
        return failDelete
          ? { status: 500, body: { error: { code: "INTERNAL", message: "服务器错误" } } }
          : { status: 204 };
      }
    }
  });
  return calls;
}

function cell(rowId: number, colKey: string): HTMLElement {
  const el = document.querySelector(`[data-cell="${rowId}:${colKey}"]`);
  if (!el) throw new Error(`cell ${rowId}:${colKey} not found`);
  return el as HTMLElement;
}

describe("成交记录页", () => {
  it("渲染列表：客户/意向产品/负责人/阶段 badge/客户城市", async () => {
    mockDealsApi(adminMe);
    renderApp("/deals");
    expect(await screen.findByText("张三")).toBeTruthy();
    expect(screen.getByText("咨询产品")).toBeTruthy();
    expect(screen.getByText("老王")).toBeTruthy();
    expect(screen.getAllByText("已付款").length).toBeGreaterThan(0); // badge（过滤下拉里也有同名 option）
    expect(screen.getByText("上海")).toBeTruthy(); // 客户城市只读列
  });

  it("q 搜索触发新 query", async () => {
    const calls = mockDealsApi(adminMe);
    renderApp("/deals");
    await screen.findByText("张三");

    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "ORD" } });
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "GET" && decodeURIComponent(c.url).includes("q=ORD")),
      ).toBe(true),
    );
  });

  it("阶段过滤下拉触发新 query", async () => {
    const calls = mockDealsApi(adminMe);
    renderApp("/deals");
    await screen.findByText("张三");

    fireEvent.change(screen.getByLabelText("阶段筛选"), { target: { value: "refunded" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("stage=refunded"))).toBe(true));
  });

  it("新增：表单必填客户，成交日期 YYYY-MM-DD → POST 为 epoch ms", async () => {
    const calls = mockDealsApi(adminMe);
    renderApp("/deals");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    const dialog = screen.getByRole("dialog", { name: "新增成交记录" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.click(await within(dialog).findByLabelText("张三")); // relation-one 单选客户
    fireEvent.change(within(dialog).getByLabelText("订单号"), { target: { value: "ORD-NEW" } });
    fireEvent.change(within(dialog).getByLabelText("成交日期"), {
      target: { value: "2026-08-22" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/deals");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toEqual({
        customerId: 101,
        orderNo: "ORD-NEW",
        dealDate: deliveryMs(2026, 8, 22),
      });
    });
  });

  it("交付日期编辑：YYYY-MM-DD → PATCH 为 epoch ms", async () => {
    const calls = mockDealsApi(adminMe);
    renderApp("/deals");
    await screen.findAllByText("2026-08-22"); // 成交日期 + 交付日期两列

    fireEvent.doubleClick(cell(1, "deliveryDate"));
    const input = cell(1, "deliveryDate").querySelector("input")!;
    expect(input.value).toBe("2026-08-22");
    fireEvent.change(input, { target: { value: "2026-09-01" } });
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deals/1");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({
        deliveryDate: deliveryMs(2026, 9, 1),
        updatedAt: 2000,
      });
    });
  });

  it("金额行内编辑：元字符串 → PATCH 为分整数（number，K13）", async () => {
    const calls = mockDealsApi(adminMe);
    renderApp("/deals");
    await screen.findByText("398.00");

    fireEvent.doubleClick(cell(1, "amountCents"));
    const input = cell(1, "amountCents").querySelector("input")!;
    expect(input.value).toBe("398.00");
    fireEvent.change(input, { target: { value: "500.6" } });
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deals/1");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ amountCents: 50060, updatedAt: 2000 });
    });
  });

  it("金额非法输入：toast 报错且不发 PATCH（不静默清库）", async () => {
    const calls = mockDealsApi(adminMe);
    renderApp("/deals");
    await screen.findByText("398.00");

    fireEvent.doubleClick(cell(1, "amountCents"));
    const input = cell(1, "amountCents").querySelector("input")!;
    fireEvent.change(input, { target: { value: "12a" } });
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => expect(screen.getByText("金额需为数字（元）")).toBeTruthy());
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("税后比例非法输入：toast 报错且不发 PATCH", async () => {
    const calls = mockDealsApi(adminMe);
    renderApp("/deals");
    await screen.findByText("0.9306");

    fireEvent.doubleClick(cell(1, "afterTaxRatio"));
    const input = cell(1, "afterTaxRatio").querySelector("input")!;
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => expect(screen.getByText("税后金额比例需为数字")).toBeTruthy());
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("新增：金额/税后比例经表单提交为 number（amountCents 分整数）", async () => {
    const calls = mockDealsApi(adminMe);
    renderApp("/deals");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    const dialog = screen.getByRole("dialog", { name: "新增成交记录" });

    fireEvent.click(await within(dialog).findByLabelText("张三"));
    fireEvent.change(within(dialog).getByLabelText("金额（元）"), { target: { value: "200.5" } });
    fireEvent.change(within(dialog).getByLabelText("税后金额比例"), { target: { value: "0.95" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/deals");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toEqual({
        customerId: 101,
        amountCents: 20050,
        afterTaxRatio: 0.95,
      });
    });
  });

  it("删除失败：toast 提示错误信息，确认框不卡死", async () => {
    const calls = mockDealsApi(adminMe, [deal], true);
    renderApp("/deals");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除成交记录" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.getByText("服务器错误")).toBeTruthy());
    expect(screen.getByRole("dialog", { name: "删除成交记录" })).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/deals/1")).toBe(true);
  });

  it("assistant：只读整表，无新增/删除", async () => {
    mockDealsApi(assistantMe);
    renderApp("/deals");
    await screen.findByText("张三");

    expect(screen.queryByRole("button", { name: "新增" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    fireEvent.doubleClick(cell(1, "orderNo"));
    expect(cell(1, "orderNo").querySelector("input")).toBeNull();
  });

  it("删除：ConfirmDialog → DELETE → 列表刷新", async () => {
    const calls = mockDealsApi(adminMe);
    renderApp("/deals");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除成交记录" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/deals/1")).toBe(true),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/deals")).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });
});
