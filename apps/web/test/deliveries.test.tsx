import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { DeliveryDto } from "../src/api/types";

const delivery: DeliveryDto = {
  id: 1,
  deliveryTypeId: 11,
  deliveryType: { id: 11, name: "圈子全年交付" },
  customers: [
    { id: 101, nickname: "张三" },
    { id: 102, nickname: "李四" },
  ],
  remark: "备注甲",
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

function mockDeliveriesApi(me: Me, rows: DeliveryDto[] = [delivery]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    // 交付类型下拉
    if (url.startsWith("/api/v1/delivery-types")) {
      return {
        status: 200,
        body: {
          data: [{ id: 11, name: "圈子全年交付" }],
          meta: { page: 1, pageSize: 100, total: 1 },
        },
      };
    }
    // 客户搜索 / 成交（按产品类型 merge）
    if (url.startsWith("/api/v1/customers")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 101, nickname: "张三" },
            { id: 102, nickname: "李四" },
          ],
          meta: { page: 1, pageSize: 100, total: 2 },
        },
      };
    }
    if (url.startsWith("/api/v1/deals")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 201, orderNo: "ORD-1", customer: { id: 101, nickname: "张三" } },
            { id: 202, orderNo: "ORD-2", customer: { id: 103, nickname: "王五" } },
          ],
          meta: { page: 1, pageSize: 100, total: 2 },
        },
      };
    }
    if (url.startsWith("/api/v1/deliveries")) {
      if (method === "GET") {
        return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
      }
      if (method === "POST") return { status: 201, body: { data: { ...delivery, id: 99 } } };
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { data: { ...delivery, ...patch, updatedAt: 2001 } } };
      }
      if (method === "DELETE") return { status: 204 };
    }
  });
  return calls;
}

describe("交付管理页（交付单列表）", () => {
  it("渲染列表：类型名 + 客户数；assistant 只读仍可见详情", async () => {
    mockDeliveriesApi(adminMe);
    renderApp("/deliveries");
    expect(await screen.findByText("圈子全年交付")).toBeTruthy();
    expect(screen.getByText("2 人")).toBeTruthy();
    expect(screen.getByText("备注甲")).toBeTruthy();
  });

  it("新增交付：选类型 + 手动选客户 + 按产品类型 merge → POST customerIds 合并", async () => {
    const calls = mockDeliveriesApi(adminMe);
    renderApp("/deliveries");
    await screen.findByText("圈子全年交付");

    fireEvent.click(screen.getByRole("button", { name: "新增交付" }));
    const dialog = screen.getByRole("dialog", { name: "新增交付" });

    // 类型下拉（options 异步加载，先等 option 出现）
    await within(dialog).findByRole("option", { name: "圈子全年交付" });
    fireEvent.change(within(dialog).getByLabelText("交付类型"), { target: { value: "11" } });
    // 手动选择客户「李四」
    fireEvent.click(await within(dialog).findByLabelText("李四"));
    // 按产品类型 merge：选 c_consulting → 候选（张三/王五）→ 勾选王五
    fireEvent.change(within(dialog).getByLabelText("按产品类型从成交合并"), { target: { value: "c_consulting" } });
    fireEvent.click(await within(dialog).findByLabelText("王五"));

    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/deliveries");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.body)) as { deliveryTypeId: number; customerIds: number[] };
      expect(body.deliveryTypeId).toBe(11);
      expect(body.customerIds.sort()).toEqual([102, 103].sort());
    });
  });

  it("assistant：无新增/删除按钮；详情入口可见", async () => {
    mockDeliveriesApi(assistantMe);
    renderApp("/deliveries");
    await screen.findByText("圈子全年交付");
    expect(screen.queryByRole("button", { name: "新增交付" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(screen.getByRole("button", { name: "详情" })).toBeTruthy();
  });
});
