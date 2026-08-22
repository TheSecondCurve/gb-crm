import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { DeliverableDto, DeliveryDto } from "../src/api/types";
import { dateToEpochMs, epochMsToDate } from "../src/columns/common";

const COL_W = 28;

const d1 = dateToEpochMs("2026-08-01") as number;
const d3 = dateToEpochMs("2026-08-03") as number;
const d10 = dateToEpochMs("2026-08-10") as number;
const d12 = dateToEpochMs("2026-08-12") as number;

const delivery: DeliveryDto = {
  id: 1,
  deliveryTypeId: 11,
  deliveryType: { id: 11, name: "圈子全年交付" },
  customers: [
    { id: 101, nickname: "张三" },
    { id: 102, nickname: "李四" },
  ],
  startsAt: null,
  endsAt: null,
  remark: null,
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

function projectItem(id: number, content: string, startsAt: number | null, endsAt: number | null): DeliverableDto {
  return {
    id,
    deliveryId: 1,
    content,
    dimension: "project",
    description: null,
    deliveryUrl: null,
    startsAt,
    endsAt,
    tasks: [],
    createdAt: 1000,
    updatedAt: 2000,
    createdBy: null,
    updatedBy: null,
  };
}

const projectA = { ...projectItem(21, "项目A", d1, d3), tasks: [
  { id: 1, customer: null, content: "拉群", done: true, doneAt: 1000, doneBy: null, remark: null, updatedAt: 1500 },
  { id: 2, customer: null, content: "发货", done: false, doneAt: null, doneBy: null, remark: null, updatedAt: 1500 },
] };
const projectB = projectItem(22, "项目B", d10, d12);
const projectC = projectItem(23, "未排期项", null, null);

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockGanttApi(me: Me, items: DeliverableDto[] = [projectA, projectB, projectC]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url === "/api/v1/deliveries/1") return { status: 200, body: { data: delivery } };
    if (url.startsWith("/api/v1/deliveries/1/items")) {
      if (method === "GET") return { status: 200, body: { data: items } };
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 201, body: { data: { ...projectA, id: 99, ...body } } };
      }
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const itemId = Number(url.split("/").at(-1));
        const target = items.find((i) => i.id === itemId) ?? projectA;
        return { status: 200, body: { data: { ...target, ...patch, updatedAt: 2001 } } };
      }
      if (method === "DELETE") return { status: 204 };
    }
  });
  return calls;
}

describe("交付甘特图页（项目维度）", () => {
  it("渲染时间轴：已排期项条块按日期定位，未排期项列下区", async () => {
    mockGanttApi(adminMe);
    renderApp("/deliveries/1/gantt");
    const barA = await screen.findByLabelText("项目A 排期条");

    // 表头月份 + 日期
    expect(screen.getByText("8月")).toBeTruthy();
    expect(screen.getByTitle(epochMsToDate(d1))).toBeTruthy();

    // 条块 A：从 8/1 起，跨度 8/1~8/3（2 天 + 右缘 1 天 = 3 格宽）
    expect(barA.style.left).toBe("0px");
    expect(barA.style.width).toBe(`${3 * COL_W}px`);

    // 条块 B：从 8/10 起，left = 9 天 × 28
    const barB = screen.getByLabelText("项目B 排期条") as HTMLElement;
    expect(barB.style.left).toBe(`${9 * COL_W}px`);
    expect(barB.style.width).toBe(`${3 * COL_W}px`);

    // 未排期项在下方列表
    expect(screen.getByText("未排期（1）")).toBeTruthy();
    expect(screen.getByText("未排期项")).toBeTruthy();
  });

  it("行内编辑起止日期 → PATCH 带 updatedAt；新增项目交付项 → POST dimension=project", async () => {
    const calls = mockGanttApi(adminMe);
    renderApp("/deliveries/1/gantt");
    await screen.findByLabelText("项目A 排期条");

    // 改项目A 开始日期
    fireEvent.change(screen.getByLabelText("项目A 开始日期"), { target: { value: "2026-08-05" } });
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deliveries/1/items/21");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ startsAt: dateToEpochMs("2026-08-05"), updatedAt: 2000 });
    });

    // 新增项目交付项
    fireEvent.click(screen.getByRole("button", { name: "新增项目交付项" }));
    const dialog = screen.getByRole("dialog", { name: "新增项目交付项" });
    fireEvent.change(within(dialog).getByLabelText("交付项标题"), { target: { value: "新项目" } });
    fireEvent.change(within(dialog).getByLabelText("开始日期"), { target: { value: "2026-09-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/deliveries/1/items");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.body)) as Record<string, unknown>;
      expect(body.content).toBe("新项目");
      expect(body.dimension).toBe("project");
      expect(body.startsAt).toBe(dateToEpochMs("2026-09-01"));
    });
  });

  it("删除项目交付项 → 确认后 DELETE", async () => {
    const calls = mockGanttApi(adminMe);
    renderApp("/deliveries/1/gantt");
    await screen.findByLabelText("项目A 排期条");

    fireEvent.click(screen.getByRole("button", { name: "删除 项目A" }));
    const dialog = screen.getByRole("dialog", { name: "删除交付项" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/deliveries/1/items/21")).toBe(true);
    });
  });

  it("assistant 只读：无新增/删除/日期编辑，只读展示日期", async () => {
    mockGanttApi(assistantMe);
    renderApp("/deliveries/1/gantt");
    await screen.findByLabelText("项目A 排期条");

    expect(screen.queryByRole("button", { name: "新增项目交付项" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除 项目A" })).toBeNull();
    expect(screen.queryByLabelText("项目A 开始日期")).toBeNull();
    expect(screen.getByText(`${epochMsToDate(d1)} ~ ${epochMsToDate(d3)}`)).toBeTruthy();
  });
});
