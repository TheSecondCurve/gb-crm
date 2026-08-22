import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { DeliverableDto } from "../src/api/types";

const deliverable: DeliverableDto = {
  id: 1,
  dealId: 101,
  productId: 201,
  status: "delivering",
  planDeliverDate: null,
  actualDeliverDate: null,
  expiryDate: null,
  description: null,
  deliveryUrl: null,
  deal: { id: 101, orderNo: "ORD-001", customer: { id: 1001, nickname: "张三" } },
  product: { id: 201, name: "圈子产品" },
  tasks: [
    { id: 1, content: "拉群", done: true, doneAt: 1000, doneBy: null, updatedAt: 1500 },
    { id: 2, content: "商品发货", done: false, doneAt: null, doneBy: null, updatedAt: 1500 },
    { id: 3, content: "开课提醒", done: false, doneAt: null, doneBy: null, updatedAt: 1500 },
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

function mockDeliverablesApi(me: Me, rows: DeliverableDto[] = [deliverable]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    // 关系选项 loader（成交/产品）
    if (url.startsWith("/api/v1/deals")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 101, orderNo: "ORD-001", customer: { id: 1001, nickname: "张三" } },
            { id: 102, orderNo: "ORD-002", customer: { id: 1002, nickname: "李四" } },
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
            { id: 201, name: "圈子产品" },
            { id: 202, name: "1v1咨询" },
          ],
          meta: { page: 1, pageSize: 100, total: 2 },
        },
      };
    }
    if (url.startsWith("/api/v1/deliverables")) {
      if (method === "GET") {
        return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
      }
      if (method === "POST" && url.endsWith("/tasks")) {
        return { status: 201, body: { data: { id: 9, content: "x", done: false, doneAt: null, doneBy: null, updatedAt: 2000 } } };
      }
      if (method === "POST") {
        return { status: 201, body: { data: { ...deliverable, id: 99 } } };
      }
      if (method === "PATCH" && /\/tasks\/\d+$/.test(url)) {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { data: { ...deliverable.tasks[0], ...patch, updatedAt: 2001 } } };
      }
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { data: { ...deliverable, ...patch, updatedAt: 2001 } } };
      }
      if (method === "DELETE") return { status: 204 };
    }
  });
  return calls;
}

function cell(rowId: number, colKey: string): HTMLElement {
  const el = document.querySelector(`[data-cell="${rowId}:${colKey}"]`);
  if (!el) throw new Error(`cell ${rowId}:${colKey} not found`);
  return el as HTMLElement;
}

describe("交付管理页", () => {
  it("渲染列表：成交列（订单号·客户）、产品、动作进度 1/3、状态 badge", async () => {
    mockDeliverablesApi(adminMe);
    renderApp("/deliverables");
    expect(await screen.findByText("ORD-001 · 张三")).toBeTruthy();
    expect(screen.getByText("圈子产品")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.getAllByText("交付中").length).toBeGreaterThan(0); // badge + 过滤下拉 option
  });

  it("状态过滤下拉触发新 query", async () => {
    const calls = mockDeliverablesApi(adminMe);
    renderApp("/deliverables");
    await screen.findByText(/ORD-001/);

    fireEvent.change(screen.getByLabelText("状态筛选"), { target: { value: "delivered" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=delivered"))).toBe(true));
  });

  it("新增：表单必选成交 → POST dealId（动作模板由服务端预填，前端不带 tasks）", async () => {
    const calls = mockDeliverablesApi(adminMe);
    renderApp("/deliverables");
    await screen.findByText(/ORD-001/);

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    const dialog = screen.getByRole("dialog", { name: "新增交付项" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.click(await within(dialog).findByLabelText("ORD-001 · 张三"));
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/deliverables");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toEqual({ dealId: 101 });
    });
  });

  it("动作弹窗：打勾 → PATCH /tasks/:id 带 { done, updatedAt }", async () => {
    const calls = mockDeliverablesApi(adminMe);
    renderApp("/deliverables");
    await screen.findByText(/ORD-001/);

    fireEvent.click(screen.getByRole("button", { name: "动作" }));
    const dialog = screen.getByRole("dialog", { name: /动作清单/ });
    fireEvent.click(within(dialog).getByLabelText("商品发货"));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deliverables/1/tasks/2");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ done: true, updatedAt: 1500 });
    });
  });

  it("assistant：只读整表，无新增/删除/动作按钮", async () => {
    mockDeliverablesApi(assistantMe);
    renderApp("/deliverables");
    await screen.findByText(/ORD-001/);

    expect(screen.queryByRole("button", { name: "新增" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(screen.queryByRole("button", { name: "动作" })).toBeNull();
    fireEvent.doubleClick(cell(1, "status"));
    expect(cell(1, "status").querySelector("select")).toBeNull();
  });

  it("删除：ConfirmDialog → DELETE → 列表刷新", async () => {
    const calls = mockDeliverablesApi(adminMe);
    renderApp("/deliverables");
    await screen.findByText(/ORD-001/);

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除交付项" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/deliverables/1")).toBe(true),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/deliverables")).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });
});
