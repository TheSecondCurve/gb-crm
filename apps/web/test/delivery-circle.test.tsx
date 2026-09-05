// 圈子类交付专项工作台页测试（/deliveries/:id/circle）：
// - 渲染：基本信息（人数/周期状态/动作进度）+ Tab 分区（圈子客户 / 交付工作项）；
//   客户全量表在「圈子客户」tab；交付项列表 + 甘特/时序 todo 在「交付工作项」tab；
// - 非圈子类守卫；添加客户（PATCH customerIds 并集 + OCC）；移除客户（PATCH 差集）；
// - 列设置：客户表字段自由显隐（localStorage 持久化），导出 Excel 跟随所选字段；
// - 客户维度交付项「动作」→ 弹出状态矩阵弹窗（格内打勾即改）；项目维度仍是动作清单弹窗。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { CustomerDto, DeliverableDto, DeliveryDto } from "../src/api/types";
import { dateToEpochMs } from "../src/columns/common";

const delivery: DeliveryDto = {
  id: 1,
  deliveryTypeId: 11,
  deliveryType: { id: 11, name: "圈子全年交付", kind: "circle" },
  name: null,
  customers: [
    { id: 101, nickname: "张三" },
    { id: 102, nickname: "李四" },
  ],
  startsAt: null,
  endsAt: null,
  remark: "年度陪跑圈子",
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

const customerBase = (id: number, nickname: string, extra: Partial<CustomerDto> = {}): CustomerDto => ({
  id,
  nickname,
  realName: null,
  title: null,
  phone: null,
  wechat: null,
  country: "中国",
  city: "杭州",
  industry: null,
  originStory: null,
  notes: null,
  customerType: "customer",
  wechatOpenid: null,
  lastFollowedAt: null,
  socialAccounts: [],
  tags: [],
  owner: null,
  sourceChannels: [],
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
  ...extra,
});

const customers: CustomerDto[] = [
  customerBase(101, "张三", {
    realName: "张伟",
    title: "主理人",
    phone: "13800000001",
    wechat: "wx_zhangsan",
    customerType: "partner",
    industry: "教育",
    owner: { id: 1, nickname: "运营-甲" },
    sourceChannels: [{ id: 7, name: "小红书" }],
    lastFollowedAt: 1700000000000,
  }),
  customerBase(102, "李四", { wechat: "wx_lisi" }),
];

const itemCustomer: DeliverableDto = {
  id: 21,
  deliveryId: 1,
  content: "拉群",
  dimension: "customer",
  description: null,
  deliveryUrl: null,
  startsAt: null,
  endsAt: null,
  tasks: [
    { id: 1, customer: { id: 101, nickname: "张三" }, content: "拉群", done: true, doneAt: 1000, doneBy: null, remark: null, updatedAt: 1500 },
    { id: 2, customer: { id: 101, nickname: "张三" }, content: "商品发货", done: false, doneAt: null, doneBy: null, remark: null, updatedAt: 1500 },
    { id: 3, customer: { id: 102, nickname: "李四" }, content: "拉群", done: false, doneAt: null, doneBy: null, remark: null, updatedAt: 1500 },
    { id: 4, customer: { id: 102, nickname: "李四" }, content: "商品发货", done: false, doneAt: null, doneBy: null, remark: null, updatedAt: 1500 },
  ],
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

const itemProject: DeliverableDto = {
  id: 41,
  deliveryId: 1,
  content: "开营仪式",
  dimension: "project",
  description: null,
  deliveryUrl: null,
  startsAt: dateToEpochMs("2026-08-10"),
  endsAt: dateToEpochMs("2026-08-12"),
  tasks: [
    { id: 10, customer: null, content: "预告", done: true, doneAt: 1000, doneBy: null, remark: null, updatedAt: 1500 },
    { id: 11, customer: null, content: "开场", done: false, doneAt: null, doneBy: null, remark: null, updatedAt: 1500 },
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

function mockCircleApi(me: Me, d: DeliveryDto = delivery, items: DeliverableDto[] = [itemCustomer, itemProject]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url === "/api/v1/deliveries/1") {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const ids = (patch.customerIds as number[]) ?? [];
        return { status: 200, body: { data: { ...d, customers: ids.map((cid: number) => ({ id: cid, nickname: `客户${cid}` })), updatedAt: 2001 } } };
      }
      return { status: 200, body: { data: d } };
    }
    if (url === "/api/v1/deliveries/1/items") {
      return { status: 200, body: { data: items } };
    }
    if (/^\/api\/v1\/deliveries\/1\/items\/\d+\/tasks\/\d+$/.test(url)) {
      if (method === "PATCH") return { status: 200, body: { data: {} } };
    }
    if (url === "/api/v1/deliveries/1/customers") {
      return { status: 200, body: { data: customers } };
    }
    // 添加客户弹窗的搜索（customerOptionsLoader）
    if (url.startsWith("/api/v1/customers?pageSize=100")) {
      return {
        status: 200,
        body: {
          data: [{ id: 103, nickname: "王五" }],
          meta: { page: 1, pageSize: 100, total: 1 },
        },
      };
    }
  });
  return calls;
}

/** 「交付工作项」tab 里按标题定位交付项行（甘特/todo 可能出现同名文本，取最近 .item-row） */
function itemRowOf(content: string): HTMLElement {
  const el = screen.getAllByText(content).find((n) => n.closest(".item-row"));
  if (!el) throw new Error(`no item-row for ${content}`);
  return el.closest(".item-row") as HTMLElement;
}

describe("圈子工作台页（/deliveries/:id/circle）", () => {
  it("渲染：基本信息 + Tab 分区；客户表在圈子客户 tab、甘特/todo 在交付工作项 tab；assistant 只读", async () => {
    mockCircleApi(assistantMe);
    renderApp("/deliveries/1/circle");
    await screen.findByText("圈子工作台 · 圈子全年交付");

    // 基本信息卡：人数 / 周期状态（无起止日期 → 未排期）/ 动作进度
    expect(screen.getByText("圈子基本信息")).toBeTruthy();
    expect(screen.getByText("2 人")).toBeTruthy();
    expect(screen.getByText("未排期")).toBeTruthy();
    expect(screen.getByText("2/6")).toBeTruthy(); // 动作进度（全部交付项：6 任务中 2 完成）
    expect(screen.getByText("年度陪跑圈子")).toBeTruthy();

    // Tab 结构：默认「圈子客户」
    const customersTab = screen.getByRole("tab", { name: /圈子客户/ });
    const workTab = screen.getByRole("tab", { name: /交付工作项/ });
    expect(customersTab.getAttribute("aria-selected")).toBe("true");
    expect(workTab.getAttribute("aria-selected")).toBe("false");

    // 圈子客户 tab：完整信息列
    expect(screen.getByText("张三")).toBeTruthy();
    expect(screen.getByText("张伟")).toBeTruthy();
    expect(screen.getByText("13800000001")).toBeTruthy();
    expect(screen.getByText("wx_zhangsan")).toBeTruthy();
    expect(screen.getAllByText("杭州").length).toBeGreaterThan(0);
    expect(screen.getByText("合作伙伴")).toBeTruthy();
    expect(screen.getByText("运营-甲")).toBeTruthy();
    expect(screen.getByText("小红书")).toBeTruthy();

    // 甘特 / 时序 todo / 交付项列表随 tab 隐藏
    expect(screen.queryByText(/项目交付项甘特/)).toBeNull();
    expect(screen.queryByText(/时序 todo/)).toBeNull();
    expect(screen.queryByText(/当前交付项/)).toBeNull();

    // 切到「交付工作项」：交付项列表 + 甘特 + 时序 todo；客户表隐藏
    fireEvent.click(workTab);
    expect(workTab.getAttribute("aria-selected")).toBe("true");
    expect(customersTab.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByText(/当前交付项/)).toBeTruthy();
    expect(screen.getAllByText("开营仪式").length).toBeGreaterThan(0);
    expect(screen.getByText(/项目交付项甘特/)).toBeTruthy();
    expect(screen.getByText(/时序 todo/)).toBeTruthy();
    expect(screen.queryByText("张伟")).toBeNull();

    // assistant 只读：无写操作按钮（修改交付在页头常驻，其余分属两个 tab）
    expect(screen.queryByRole("button", { name: "新增交付项" })).toBeNull();
    expect(screen.queryByRole("button", { name: "修改交付" })).toBeNull();
    fireEvent.click(customersTab);
    expect(screen.queryByRole("button", { name: "添加客户" })).toBeNull();
    expect(screen.queryByRole("button", { name: "移除" })).toBeNull();
    expect(screen.getByRole("button", { name: "导出 Excel" })).toBeTruthy();
  });

  it("守卫：非圈子类交付直达 → 提示不可用", async () => {
    const other = { ...delivery, deliveryType: { id: 11, name: "1v1咨询", kind: "activity" } };
    mockCircleApi(assistantMe, other, []);
    renderApp("/deliveries/1/circle");
    await screen.findByText("该交付不是圈子类交付，无法使用圈子工作台");
  });

  it("添加客户：搜索多选 → PATCH customerIds 并集 + updatedAt（OCC）", async () => {
    const calls = mockCircleApi(adminMe);
    renderApp("/deliveries/1/circle");
    await screen.findByText("圈子工作台 · 圈子全年交付");

    fireEvent.click(screen.getByRole("button", { name: "添加客户" }));
    const dialog = screen.getByRole("dialog", { name: "添加圈子客户" });
    fireEvent.change(within(dialog).getByPlaceholderText("搜索客户…"), { target: { value: "王五" } });
    // 等待 loader 返回候选（王五不在圈内 → 显示）
    await within(dialog).findByText("王五");
    fireEvent.click(within(dialog).getByLabelText("王五"));
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deliveries/1");
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch?.body)) as Record<string, unknown>;
      expect(body.customerIds).toEqual([101, 102, 103]);
      expect(body.updatedAt).toBe(2000);
    });
  });

  it("移除客户：确认后 PATCH customerIds 差集 + updatedAt（OCC）", async () => {
    const calls = mockCircleApi(adminMe);
    renderApp("/deliveries/1/circle");
    await screen.findByText("圈子工作台 · 圈子全年交付");

    const removeButtons = screen.getAllByRole("button", { name: "移除" });
    fireEvent.click(removeButtons[0]!); // 张三
    const dialog = screen.getByRole("dialog", { name: "移除客户" });
    fireEvent.click(within(dialog).getByRole("button", { name: "移除" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deliveries/1");
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch?.body)) as Record<string, unknown>;
      expect(body.customerIds).toEqual([102]);
      expect(body.updatedAt).toBe(2000);
    });
  });

  it("客户维度交付项「动作」→ 弹出状态矩阵弹窗，格内单击打勾即改（PATCH task done）", async () => {
    const calls = mockCircleApi(adminMe);
    renderApp("/deliveries/1/circle");
    await screen.findByText("圈子工作台 · 圈子全年交付");

    fireEvent.click(screen.getByRole("tab", { name: /交付工作项/ }));
    fireEvent.click(within(itemRowOf("拉群")).getByRole("button", { name: "动作" }));

    // 状态矩阵弹窗：行 = 客户，列 = 客户维度交付项
    const dialog = screen.getByRole("dialog", { name: "状态矩阵：拉群" });
    expect(within(dialog).getByLabelText("张三 · 拉群").textContent).toContain("✓ 完成");
    const liCell = within(dialog).getByLabelText("李四 · 拉群");
    expect(liCell.textContent).toContain("未完成");

    // 不是旧的动作清单弹窗
    expect(screen.queryByRole("dialog", { name: "动作清单：拉群" })).toBeNull();

    // 格内单击打勾 → PATCH task done 带 updatedAt（OCC）
    fireEvent.click(liCell);
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/deliveries/1/items/21/tasks/3");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ done: true, updatedAt: 1500 });
    });
  });

  it("项目维度交付项「动作」→ 仍是动作清单弹窗", async () => {
    mockCircleApi(adminMe);
    renderApp("/deliveries/1/circle");
    await screen.findByText("圈子工作台 · 圈子全年交付");

    fireEvent.click(screen.getByRole("tab", { name: /交付工作项/ }));
    fireEvent.click(within(itemRowOf("开营仪式")).getByRole("button", { name: "动作" }));

    expect(screen.getByRole("dialog", { name: "动作清单：开营仪式" })).toBeTruthy();
  });

  it("列设置：客户表字段自由显隐 + localStorage 持久化；导出 Excel 跟随所选字段", async () => {
    localStorage.clear();
    mockCircleApi(assistantMe);
    const hrefs: string[] = [];
    const spy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        hrefs.push(this.href);
      });
    try {
      renderApp("/deliveries/1/circle");
      await screen.findByText("圈子工作台 · 圈子全年交付");

      const fieldsOf = (href: string | undefined): string[] =>
        (new URL(href ?? "", window.location.origin).searchParams.get("fields") ?? "").split(",");

      // 默认导出：fields = 默认所选字段（昵称锁定 + 常用列），不含未勾选的 行业
      fireEvent.click(screen.getByRole("button", { name: "导出 Excel" }));
      let fields = fieldsOf(hrefs.at(-1));
      expect(fields).toContain("nickname");
      expect(fields).toContain("realName");
      expect(fields).not.toContain("industry");

      // 打开列设置：取消「城市」→ 列消失；勾选「行业」→ 显示张三的行业
      fireEvent.click(screen.getByRole("button", { name: "列设置" }));
      const panel = screen.getByRole("group", { name: "列设置" });
      fireEvent.click(within(panel).getByLabelText("城市"));
      await waitFor(() => expect(screen.queryAllByText("杭州")).toHaveLength(0));
      fireEvent.click(within(panel).getByLabelText("行业"));
      await screen.findByText("教育");

      // 昵称行头锁定不可关（checkbox 禁用）
      expect(within(panel).getByLabelText("客户")).toHaveProperty("disabled", true);

      // 持久化到 localStorage（DataGrid 同款 key 规范）
      const stored = JSON.parse(
        localStorage.getItem("gb-crm:datagrid:delivery-circle-customers:columns") ?? "[]",
      ) as string[];
      expect(stored).not.toContain("city");
      expect(stored).toContain("industry");

      // 再次导出：跟随最新所选字段
      fireEvent.click(screen.getByRole("button", { name: "导出 Excel" }));
      fields = fieldsOf(hrefs.at(-1));
      expect(fields).toContain("nickname");
      expect(fields).toContain("industry");
      expect(fields).not.toContain("city");
    } finally {
      spy.mockRestore();
    }
  });
});
