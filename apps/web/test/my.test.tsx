// 「我的运营」一级菜单：我的客户（ownerId=当前用户）/ 我的成交（ownerId=当前用户）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, operatorMe, renderApp, type Me } from "./helpers";
import type { CustomerDto, DealDto } from "../src/api/types";

const customer: CustomerDto = {
  id: 1,
  nickname: "张三",
  realName: null,
  title: null,
  phone: "13800000000",
  wechat: null,
  country: null,
  city: "上海",
  industry: null,
  originStory: null,
  notes: null,
  customerType: "customer",
  wechatOpenid: null,
  lastFollowedAt: null,
  socialAccounts: [],
  tags: [],
  owner: { id: 1, nickname: "管理员" },
  sourceChannels: [],
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

const deal: DealDto = {
  id: 1,
  customerId: 1,
  productId: null,
  ownerId: 3,
  stage: "gift",
  orderNo: "D-001",
  paymentRemark: null,
  dealDate: 1000,
  deliveryDate: null,
  amountCents: null,
  afterTaxRatio: null,
  customer: { id: 1, nickname: "张三", city: null },
  product: null,
  owner: { id: 3, nickname: "团队运营" },
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

function mockCustomersApi(me: Me, rows: CustomerDto[] = [customer]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/customers")) {
      // K50：行级 AI 打标（静态段优先）
      if (url.includes("/tags/generate")) {
        return { status: 200, body: { data: customer } };
      }
      return {
        status: 200,
        body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } },
      };
    }
    if (url.startsWith("/api/v1/background-jobs")) {
      if (method === "GET") {
        return { status: 200, body: { data: [], meta: { page: 1, pageSize: 50, total: 0 } } };
      }
      return { status: 201, body: { data: { id: 1, type: "customer-tags-generate-all", status: "queued" } } };
    }
  });
  return calls;
}

function mockDealsApi(me: Me, rows: DealDto[] = [deal]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/deals")) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { data: { ...deal, ...patch, updatedAt: 2001 } } };
      }
      return {
        status: 200,
        body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } },
      };
    }
  });
  return calls;
}

function cell(rowId: number, colKey: string): HTMLElement {
  const el = document.querySelector(`[data-cell="${rowId}:${colKey}"]`);
  if (!el) throw new Error(`cell ${rowId}:${colKey} not found`);
  return el as HTMLElement;
}

describe("我的运营菜单", () => {
  it("admin 侧栏看到「我的客户」「我的成交」入口", async () => {
    mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });
    expect(screen.getByRole("link", { name: "我的客户" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "我的成交" })).toBeTruthy();
  });

  it("assistant 也能看到「我的运营」入口（无权限门槛）", async () => {
    mockCustomersApi(assistantMe);
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });
    expect(screen.getByRole("link", { name: "我的客户" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "我的成交" })).toBeTruthy();
  });

  it("侧栏「我的客户」点击进入 /my/customers，列表带 ownerId=当前用户", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });

    fireEvent.click(screen.getByRole("link", { name: "我的客户" }));
    await screen.findByRole("heading", { name: "我的客户" });
    expect(await screen.findByText("张三")).toBeTruthy();
    expect(calls.some((c) => c.method === "GET" && c.url.includes("ownerId=1"))).toBe(true);
  });

  it("我的客户：直连 /my/customers 请求带 ownerId=当前用户，无「新增」按钮", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/my/customers");
    await screen.findByRole("heading", { name: "我的客户" });
    expect(await screen.findByText("张三")).toBeTruthy();
    expect(calls.some((c) => c.method === "GET" && c.url.includes("ownerId=1"))).toBe(true);
    expect(screen.queryByRole("button", { name: "新增" })).toBeNull();
  });

  it("我的客户：导出 Excel href 带 ownerId", async () => {
    const hrefs: string[] = [];
    const spy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        hrefs.push(this.href);
      });
    try {
      mockCustomersApi(adminMe);
      renderApp("/my/customers");
      await screen.findByRole("heading", { name: "我的客户" });

      fireEvent.click(screen.getByRole("button", { name: "导出 Excel" }));
      expect(decodeURIComponent(hrefs.at(-1) ?? "")).toContain("ownerId=1");
    } finally {
      spy.mockRestore();
    }
  });

  it("我的客户：行操作「AI 生成标签」→ POST /customers/:id/tags/generate（K50）", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/my/customers");
    await screen.findByRole("heading", { name: "我的客户" });
    expect(await screen.findByText("张三")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "AI 生成标签" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/customers/1/tags/generate")).toBe(
        true,
      ),
    );
  });

  it("我的客户：「全量生成标签」确认后创建后台任务（params 带 ownerId=当前用户）并跳转", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/my/customers");
    await screen.findByRole("heading", { name: "我的客户" });
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "全量生成标签" }));
    const dialog = screen.getByRole("dialog", { name: "全量生成标签" });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建任务" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/background-jobs");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toEqual({
        type: "customer-tags-generate-all",
        params: { ownerId: 1 },
      });
    });
  });

  it("我的成交：列表带 ownerId=当前用户（operator id=3），无「新增」按钮", async () => {
    const calls = mockDealsApi(operatorMe);
    renderApp("/my/deals");
    await screen.findByRole("heading", { name: "我的成交" });
    expect(await screen.findByText("D-001")).toBeTruthy();
    expect(calls.some((c) => c.method === "GET" && c.url.includes("ownerId=3"))).toBe(true);
    expect(screen.queryByRole("button", { name: "新增" })).toBeNull();
  });

  it("我的成交：行内编辑金额 → PATCH 提交分整数（number，K13）", async () => {
    const calls = mockDealsApi(operatorMe);
    renderApp("/my/deals");
    await screen.findByRole("heading", { name: "我的成交" });
    await screen.findByText("D-001");

    fireEvent.doubleClick(cell(1, "amountCents"));
    const input = cell(1, "amountCents").querySelector("input")!;
    fireEvent.change(input, { target: { value: "500.6" } });
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deals/1");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ amountCents: 50060, updatedAt: 2000 });
    });
  });
});
