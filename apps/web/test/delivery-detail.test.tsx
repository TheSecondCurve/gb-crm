import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { DeliverableDto, DeliveryDto } from "../src/api/types";
import { dateToEpochMs } from "../src/columns/common";

const delivery: DeliveryDto = {
  id: 1,
  deliveryTypeId: 11,
  deliveryType: { id: 11, name: "圈子全年交付", kind: "circle" },
  customers: [
    { id: 101, nickname: "张三" },
    { id: 102, nickname: "李四" },
  ],
  startsAt: null,
  endsAt: null,
  remark: "备注甲",
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

const item: DeliverableDto = {
  id: 21,
  deliveryId: 1,
  content: "拉群",
  dimension: "customer",
  description: null,
  deliveryUrl: null,
  startsAt: null,
  endsAt: null,
  tasks: [
    { id: 1, customer: { id: 101, nickname: "张三" }, content: "拉群", done: true, doneAt: 1000, doneBy: null, remark: "已进群", updatedAt: 1500 },
    { id: 2, customer: { id: 101, nickname: "张三" }, content: "商品发货", done: false, doneAt: null, doneBy: null, remark: null, updatedAt: 1500 },
    { id: 3, customer: { id: 102, nickname: "李四" }, content: "拉群", done: false, doneAt: null, doneBy: null, remark: null, updatedAt: 1500 },
    { id: 4, customer: { id: 102, nickname: "李四" }, content: "商品发货", done: false, doneAt: null, doneBy: null, remark: null, updatedAt: 1500 },
  ],
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

function mockDetailApi(me: Me, items: DeliverableDto[] = [item]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
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
    if (url.startsWith("/api/v1/delivery-types")) {
      return {
        status: 200,
        body: { data: [{ id: 11, name: "圈子全年交付" }], meta: { page: 1, pageSize: 100, total: 1 } },
      };
    }
    if (url === "/api/v1/deliveries/1") {
      if (method === "PATCH") return { status: 200, body: { data: { ...delivery, remark: "新备注", updatedAt: 2001 } } };
      return { status: 200, body: { data: delivery } };
    }
    if (url.startsWith("/api/v1/deliveries/1/items")) {
      if (method === "GET") return { status: 200, body: { data: items } };
      if (method === "POST" && url.endsWith("/tasks")) {
        return { status: 201, body: { data: { id: 99, customer: { id: 101, nickname: "张三" }, content: "x", done: false, doneAt: null, doneBy: null, remark: null, updatedAt: 1600 } } };
      }
      if (method === "POST") return { status: 201, body: { data: { ...item, id: 99, content: "新交付项" } } };
      if (method === "PATCH" && /\/tasks\/\d+$/.test(url)) {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { data: { ...item.tasks[2], ...patch, updatedAt: 1600 } } };
      }
      if (method === "PATCH") return { status: 200, body: { data: { ...item, content: "改名", updatedAt: 2001 } } };
      if (method === "DELETE") return { status: 204 };
    }
  });
  return calls;
}

describe("交付单详情页", () => {
  it("渲染：类型/客户 chips/交付项进度（1/4）；assistant 只读", async () => {
    mockDetailApi(assistantMe);
    renderApp("/deliveries/1");
    await screen.findByText("拉群");
    expect(screen.getAllByText("圈子全年交付").length).toBeGreaterThan(0); // 页头 + 信息卡
    expect(screen.getByText("张三")).toBeTruthy();
    expect(screen.getByText("1/4")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新增交付项" })).toBeNull();
  });

  it("页头提供甘特图 / 状态矩阵入口（所有人可见）", async () => {
    mockDetailApi(assistantMe);
    renderApp("/deliveries/1");
    await screen.findByText("拉群");
    expect(screen.getByRole("button", { name: "甘特图" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "状态矩阵" })).toBeTruthy();
  });

  it("新增交付项：客户维度默认全选 → POST dimension=customer 不带 customerIds", async () => {
    const calls = mockDetailApi(adminMe);
    renderApp("/deliveries/1");
    await screen.findByText("拉群");

    fireEvent.click(screen.getByRole("button", { name: "新增交付项" }));
    const dialog = screen.getByRole("dialog", { name: "新增交付项" });
    fireEvent.change(within(dialog).getByLabelText("交付项标题"), { target: { value: "开课提醒" } });
    fireEvent.change(within(dialog).getByLabelText("维度"), { target: { value: "customer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/deliveries/1/items");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.body)) as Record<string, unknown>;
      expect(body.content).toBe("开课提醒");
      expect(body.dimension).toBe("customer");
      expect(body.customerIds).toBeUndefined(); // 默认全选 = 省略
    });
  });

  it("新增交付项（项目维度）：可填起止日期 → POST 带 startsAt/endsAt", async () => {
    const calls = mockDetailApi(adminMe);
    renderApp("/deliveries/1");
    await screen.findByText("拉群");

    fireEvent.click(screen.getByRole("button", { name: "新增交付项" }));
    const dialog = screen.getByRole("dialog", { name: "新增交付项" });
    fireEvent.change(within(dialog).getByLabelText("交付项标题"), { target: { value: "开营仪式" } });
    // 默认维度 project → 起止日期字段可见
    fireEvent.change(within(dialog).getByLabelText("开始日期"), { target: { value: "2026-08-10" } });
    fireEvent.change(within(dialog).getByLabelText("结束日期"), { target: { value: "2026-08-12" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/deliveries/1/items");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.body)) as Record<string, unknown>;
      expect(body.dimension).toBe("project");
      expect(body.startsAt).toBe(dateToEpochMs("2026-08-10"));
      expect(body.endsAt).toBe(dateToEpochMs("2026-08-12"));
    });
  });

  it("修改交付项（项目维度）：可编辑起止日期 → PATCH 带 startsAt 与 updatedAt", async () => {
    const pItem: DeliverableDto = {
      ...item,
      id: 41,
      content: "开营仪式",
      dimension: "project",
      startsAt: null,
      endsAt: null,
      tasks: item.tasks.map((t) => ({ ...t, customer: null })),
    };
    const calls = mockDetailApi(adminMe, [pItem]);
    renderApp("/deliveries/1");
    await screen.findByText("开营仪式");

    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    const dialog = screen.getByRole("dialog", { name: /修改交付项/ });
    fireEvent.change(within(dialog).getByLabelText("开始日期"), { target: { value: "2026-09-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deliveries/1/items/41");
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch?.body)) as Record<string, unknown>;
      expect(body.startsAt).toBe(dateToEpochMs("2026-09-01"));
      expect(body.updatedAt).toBe(2000);
    });
  });

  it("ItemModal：客户维度按客户分组，打勾只 PATCH 该任务（张三 的拉群）", async () => {
    const calls = mockDetailApi(adminMe);
    renderApp("/deliveries/1");
    await screen.findByText("拉群");

    fireEvent.click(screen.getByRole("button", { name: "动作" }));
    const dialog = screen.getByRole("dialog", { name: /动作清单/ });
    // 客户分组标题可见（张三 / 李四）
    expect(within(dialog).getByText("张三")).toBeTruthy();
    expect(within(dialog).getByText("李四")).toBeTruthy();

    // 打勾「张三」组的「商品发货」（该任务未完成）
    const zhangGroup = within(dialog).getByText("张三").closest(".task-group") as HTMLElement;
    fireEvent.click(within(zhangGroup).getByLabelText("商品发货"));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deliveries/1/items/21/tasks/2");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ done: true, updatedAt: 1500 });
    });
  });
});
