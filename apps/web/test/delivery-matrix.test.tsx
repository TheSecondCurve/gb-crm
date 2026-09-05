import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { DeliverableDto, DeliveryDto, DeliveryTaskDto } from "../src/api/types";

const delivery: DeliveryDto = {
  id: 1,
  deliveryTypeId: 11,
  deliveryType: { id: 11, name: "圈子全年交付", kind: "circle" },
  name: null,
  customers: [
    { id: 101, nickname: "张三" },
    { id: 102, nickname: "李四" },
    { id: 103, nickname: "王五" }, // 后加入的客户：无任何任务记录
  ],
  startsAt: null,
  endsAt: null,
  remark: null,
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

function task(id: number, customerId: number, nickname: string, done: boolean, remark: string | null): DeliveryTaskDto {
  return { id, customer: { id: customerId, nickname }, content: "x", done, doneAt: null, doneBy: null, remark, updatedAt: 1500 };
}

const pullGroup: DeliverableDto = {
  id: 31,
  deliveryId: 1,
  content: "拉群",
  dimension: "customer",
  description: null,
  deliveryUrl: null,
  startsAt: null,
  endsAt: null,
  tasks: [
    task(11, 101, "张三", true, "已进群"),
    task(12, 102, "李四", false, null),
  ],
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

const shipGroup: DeliverableDto = {
  id: 32,
  deliveryId: 1,
  content: "商品发货",
  dimension: "customer",
  description: null,
  deliveryUrl: null,
  startsAt: null,
  endsAt: null,
  tasks: [
    task(13, 101, "张三", false, null),
    task(14, 102, "李四", false, null),
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

function mockMatrixApi(me: Me, items: DeliverableDto[] = [pullGroup, shipGroup]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url === "/api/v1/deliveries/1") return { status: 200, body: { data: delivery } };
    if (url.startsWith("/api/v1/deliveries/1/items")) {
      if (method === "GET") return { status: 200, body: { data: items } };
      if (method === "POST" && url.endsWith("/tasks")) {
        const body = JSON.parse(String(init?.body)) as { content: string; customerId: number };
        return {
          status: 201,
          body: {
            data: {
              id: 99,
              customer: { id: body.customerId, nickname: "王五" },
              content: body.content,
              done: false,
              doneAt: null,
              doneBy: null,
              remark: null,
              updatedAt: 1600,
            },
          },
        };
      }
      if (method === "PATCH") return { status: 200, body: { data: {} } };
    }
  });
  return calls;
}

describe("交付状态矩阵页（客户维度）", () => {
  it("渲染 客户×交付项 矩阵：完成/未完成/备注角标；后加客户无记录=未完成", async () => {
    mockMatrixApi(adminMe);
    renderApp("/deliveries/1/matrix");
    await screen.findByText("拉群");

    // 列头与行头
    expect(screen.getByText("商品发货")).toBeTruthy();
    expect(screen.getByText("张三")).toBeTruthy();
    expect(screen.getByText("李四")).toBeTruthy();
    expect(screen.getByText("王五")).toBeTruthy();

    // 张三·拉群：完成 + 备注角标（data-remark 供 hover 展示）
    const zhangCell = screen.getByLabelText("张三 · 拉群");
    expect(zhangCell.textContent).toContain("✓ 完成");
    expect(zhangCell.dataset.remark).toBe("已进群");

    // 李四·拉群：未完成，无备注
    const liCell = screen.getByLabelText("李四 · 拉群");
    expect(liCell.textContent).toContain("未完成");
    expect(liCell.dataset.remark).toBeUndefined();

    // 王五（后加入）：两格均未完成且无任务记录
    expect(screen.getByLabelText("王五 · 拉群").className).toContain("matrix-cell-empty");
    expect(screen.getByLabelText("王五 · 商品发货").className).toContain("matrix-cell-empty");

    // 列进度（拉群 1/2）与行尾完成数（张三 1/2）
    expect(screen.getAllByText("1/2").length).toBe(2);
  });

  it("单击未完成格 → PATCH task done 带 updatedAt", async () => {
    const calls = mockMatrixApi(adminMe);
    renderApp("/deliveries/1/matrix");
    await screen.findByText("拉群");

    fireEvent.click(screen.getByLabelText("张三 · 商品发货"));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deliveries/1/items/32/tasks/13");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ done: true, updatedAt: 1500 });
    });
  });

  it("双击格 → 内联编辑备注，blur 提交 PATCH remark", async () => {
    const calls = mockMatrixApi(adminMe);
    renderApp("/deliveries/1/matrix");
    await screen.findByText("拉群");

    const cell = screen.getByLabelText("李四 · 拉群");
    fireEvent.doubleClick(cell);
    const input = screen.getByPlaceholderText("备注");
    fireEvent.change(input, { target: { value: "已电话联系" } });
    fireEvent.blur(input);

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deliveries/1/items/31/tasks/12");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ remark: "已电话联系", updatedAt: 1500 });
    });
  });

  it("无记录格（后加客户）点击 → 创建任务并标记完成（POST + PATCH done）", async () => {
    const calls = mockMatrixApi(adminMe);
    renderApp("/deliveries/1/matrix");
    await screen.findByText("拉群");

    fireEvent.click(screen.getByLabelText("王五 · 拉群"));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/deliveries/1/items/31/tasks");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toEqual({ content: "拉群", customerId: 103 });
    });
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deliveries/1/items/31/tasks/99");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ done: true, updatedAt: 1600 });
    });
  });

  it("assistant 只读：点击格不发 PATCH", async () => {
    const calls = mockMatrixApi(assistantMe);
    renderApp("/deliveries/1/matrix");
    await screen.findByText("拉群");

    fireEvent.click(screen.getByLabelText("张三 · 商品发货"));
    fireEvent.doubleClick(screen.getByLabelText("李四 · 拉群"));
    await new Promise((r) => setTimeout(r, 400)); // 等单击延迟窗口
    expect(calls.every((c) => c.method !== "PATCH")).toBe(true);
  });
});
