// 「我的运营」一级菜单：我的客户（ownerId=当前用户）/ 我的成交（ownerId=当前用户）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

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
  originStory: null,
  notes: null,
  customerType: "customer",
  wechatOpenid: null,
  lastFollowedAt: null,
  socialAccounts: [],
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
}

function mockCustomersApi(me: Me, rows: CustomerDto[] = [customer]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/customers")) {
      return {
        status: 200,
        body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } },
      };
    }
  });
  return calls;
}

function mockDealsApi(me: Me, rows: DealDto[] = [deal]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/deals")) {
      return {
        status: 200,
        body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } },
      };
    }
  });
  return calls;
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

  it("我的成交：列表带 ownerId=当前用户（operator id=3），无「新增」按钮", async () => {
    const calls = mockDealsApi(operatorMe);
    renderApp("/my/deals");
    await screen.findByRole("heading", { name: "我的成交" });
    expect(await screen.findByText("D-001")).toBeTruthy();
    expect(calls.some((c) => c.method === "GET" && c.url.includes("ownerId=3"))).toBe(true);
    expect(screen.queryByRole("button", { name: "新增" })).toBeNull();
  });
});
