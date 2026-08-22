import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { DeliveryDto } from "../src/api/types";
import { dateToEpochMs } from "../src/columns/common";

const delivery: DeliveryDto = {
  id: 1,
  deliveryTypeId: 11,
  deliveryType: { id: 11, name: "圈子全年交付", kind: "circle" },
  customers: [
    { id: 101, nickname: "张三" },
    { id: 102, nickname: "李四" },
  ],
  startsAt: 1700000000000,
  endsAt: null,
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

interface DealRow {
  id: number;
  orderNo: string;
  customer: { id: number; nickname: string };
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
    // 客户搜索 / 成交（按意向产品 merge）
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
    // 意向产品搜索
    if (url.startsWith("/api/v1/products")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 7, name: "咨询包年" },
            { id: 8, name: "陪跑课" },
          ],
          meta: { page: 1, pageSize: 100, total: 2 },
        },
      };
    }
    if (url.startsWith("/api/v1/deals")) {
      const qs = new URL(url, "http://localhost");
      const productId = qs.searchParams.get("productId");
      const page = Number(qs.searchParams.get("page") ?? "1");
      const all: DealRow[] = [
        { id: 201, orderNo: "ORD-1", customer: { id: 101, nickname: "张三" } },
        { id: 202, orderNo: "ORD-2", customer: { id: 103, nickname: "王五" } },
        { id: 203, orderNo: "ORD-3", customer: { id: 102, nickname: "李四" } },
        { id: 204, orderNo: "ORD-4", customer: { id: 104, nickname: "赵六" } },
      ];
      // 产品 7（咨询包年）：150 条成交分页返回（page1 前两条 + page2 陈七，模拟翻页拉全）
      const rows =
        productId === "7"
          ? page === 2
            ? [{ id: 205, orderNo: "ORD-5", customer: { id: 105, nickname: "陈七" } }]
            : all.slice(0, 2)
          : productId === "8"
            ? all.slice(2, 4)
            : all.slice(0, 2);
      const total = productId === "7" ? 150 : rows.length;
      return {
        status: 200,
        body: { data: rows, meta: { page, pageSize: 100, total } },
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

  it("新增交付：选类型 + 手动选客户 + 按意向产品 merge → POST customerIds 合并", async () => {
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
    // 按意向产品 merge：搜索产品 → 选中「咨询包年」→ 候选（张三/王五）→ 勾选王五
    fireEvent.change(within(dialog).getByPlaceholderText("搜索意向产品…"), {
      target: { value: "咨询" },
    });
    fireEvent.click(await within(dialog).findByLabelText("咨询包年"));
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

  it("新增交付：可不选客户，起止日期经日历输入后以 epoch ms 提交", async () => {
    const calls = mockDeliveriesApi(adminMe);
    renderApp("/deliveries");
    await screen.findByText("圈子全年交付");

    fireEvent.click(screen.getByRole("button", { name: "新增交付" }));
    const dialog = screen.getByRole("dialog", { name: "新增交付" });

    await within(dialog).findByRole("option", { name: "圈子全年交付" });
    fireEvent.change(within(dialog).getByLabelText("交付类型"), { target: { value: "11" } });
    fireEvent.change(within(dialog).getByLabelText("开始日期"), { target: { value: "2026-08-01" } });
    fireEvent.change(within(dialog).getByLabelText("结束日期"), { target: { value: "2026-08-31" } });
    // 不选任何客户直接创建
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/deliveries");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.body)) as {
        deliveryTypeId: number;
        customerIds: number[];
        startsAt: number | null;
        endsAt: number | null;
      };
      expect(body.deliveryTypeId).toBe(11);
      expect(body.customerIds).toEqual([]);
      expect(body.startsAt).toBe(dateToEpochMs("2026-08-01"));
      expect(body.endsAt).toBe(dateToEpochMs("2026-08-31"));
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

  it("修改交付：取消唯一关联客户后保存 → PATCH 带 updatedAt 且 customerIds=[] 合法提交", async () => {
    const single = { ...delivery, customers: [{ id: 101, nickname: "张三" }] };
    const calls = mockDeliveriesApi(adminMe, [single]);
    renderApp("/deliveries");
    await screen.findByText("圈子全年交付");

    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    const dialog = screen.getByRole("dialog", { name: /修改交付/ });

    // 取消唯一的关联客户（弹窗预填勾选「张三」）
    fireEvent.click(await within(dialog).findByLabelText("张三"));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const patchCall = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deliveries/1");
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(String(patchCall?.body)) as { customerIds: number[]; updatedAt: number };
      expect(body.customerIds).toEqual([]);
      expect(body.updatedAt).toBe(single.updatedAt);
    });
  });

  it("按意向产品 merge：多选产品分页拉全候选客户，可一键合并全部成交", async () => {
    const calls = mockDeliveriesApi(adminMe);
    renderApp("/deliveries");
    await screen.findByText("圈子全年交付");

    fireEvent.click(screen.getByRole("button", { name: "新增交付" }));
    const dialog = screen.getByRole("dialog", { name: "新增交付" });

    await within(dialog).findByRole("option", { name: "圈子全年交付" });
    fireEvent.change(within(dialog).getByLabelText("交付类型"), { target: { value: "11" } });

    // 搜索并多选两个意向产品
    fireEvent.change(within(dialog).getByPlaceholderText("搜索意向产品…"), {
      target: { value: "咨询" },
    });
    const p7 = await within(dialog).findByLabelText("咨询包年");
    const p8 = within(dialog).getByLabelText("陪跑课");
    fireEvent.click(p7);
    fireEvent.click(p8);

    // 候选分页拉全：产品 7 含第二页的「陈七」，产品 8 含「赵六」（等待全部加载完成）
    await within(dialog).findByLabelText("赵六");
    expect(within(dialog).getByLabelText("陈七")).toBeTruthy();

    // 一键合并全部成交客户
    fireEvent.click(within(dialog).getByRole("button", { name: "合并全部成交" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/deliveries");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.body)) as { customerIds: number[] };
      expect(body.customerIds.sort()).toEqual([101, 102, 103, 104, 105].sort());
    });
  });
});
