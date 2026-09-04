// 客户总览页（K45–K48）：区块渲染 / AI 打标 POST / 手动标签 PATCH / 标签移除。
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp } from "./helpers";
import type { CustomerOverviewDto } from "../src/api/types";

const tags = [
  { id: 1, name: "创业者", scope: "identity", sort: 1, enabled: true },
  { id: 2, name: "已成交", scope: "stage", sort: 1, enabled: true },
  { id: 3, name: "商学院", scope: "interest", sort: 1, enabled: true },
];

function makeOverview(over: Partial<CustomerOverviewDto> = {}): CustomerOverviewDto {
  return {
    customer: {
      id: 1,
      nickname: "张三",
      realName: null,
      title: "CEO",
      phone: "13800000000",
      wechat: null,
      country: null,
      city: "上海",
      industry: "餐饮",
      originStory: "白手起家创业",
      notes: null,
      customerType: "customer",
      wechatOpenid: null,
      lastFollowedAt: null,
      socialAccounts: [],
      tags: [{ id: 1, name: "创业者", scope: "identity" }],
      owner: { id: 1, nickname: "老王" },
      sourceChannels: [],
      createdAt: 1000,
      updatedAt: 2000,
      createdBy: null,
      updatedBy: null,
    },
    stats: { dealCount: 2, paidTotalCents: 19900, lastDealAt: 1500, materialCount: 0, maintenanceRecordCount: 0 },
    deals: [
      {
        id: 11,
        customerId: 1,
        productId: 3,
        ownerId: null,
        stage: "paid",
        orderNo: "A001",
        paymentRemark: null,
        dealDate: 1500,
        deliveryDate: 1600,
        amountCents: 9900,
        afterTaxRatio: null,
        customer: { id: 1, nickname: "张三", city: "上海" },
        product: { id: 3, name: "增长圈" },
        owner: null,
        createdAt: 1500,
        updatedAt: 1600,
        createdBy: null,
        updatedBy: null,
      },
    ],
    circles: [
      {
        id: 21,
        deliveryTypeId: 5,
        deliveryType: { id: 5, name: "私董圈子", kind: "circle" },
        customers: [{ id: 1, nickname: "张三" }],
        startsAt: 1700,
        endsAt: null,
        remark: null,
        createdAt: 1600,
        updatedAt: 1700,
        createdBy: null,
        updatedBy: null,
      },
    ],
    materials: [],
    maintenanceRecords: [],
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockOverviewApi(me: typeof adminMe, over: Partial<CustomerOverviewDto> = {}) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (method === "GET" && url.startsWith("/api/v1/tags")) {
      return {
        status: 200,
        body: { data: tags, meta: { page: 1, pageSize: 100, total: tags.length } },
      };
    }
    if (url === "/api/v1/tags" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>;
      return {
        status: 201,
        body: {
          data: {
            id: 99,
            name: body.name,
            scope: body.scope ?? "other",
            sort: 0,
            enabled: true,
            createdAt: 3000,
            updatedAt: 3000,
            createdBy: { id: 1, nickname: "管理员" },
            updatedBy: null,
          },
        },
      };
    }
    // K55：维护记录 create/update/delete
    if (url.startsWith("/api/v1/users") && method === "GET") {
      return { status: 200, body: { data: [{ id: 1, nickname: "老王" }], meta: { page: 1, pageSize: 100, total: 1 } } };
    }
    if (url.startsWith("/api/v1/channels") && method === "GET") {
      return { status: 200, body: { data: [], meta: { page: 1, pageSize: 100, total: 0 } } };
    }
    if (url.includes("/customers/1/records/") && method === "PATCH") {
      return {
        status: 200,
        body: { data: { id: 51, customerId: 1, kind: "lead", happenedAt: 1750000000000, content: "x", createdAt: 1600, updatedAt: 1601, createdBy: { id: 1, nickname: "管理员" }, updatedBy: null } },
      };
    }
    if (url.includes("/customers/1/records") && method === "POST") {
      return {
        status: 201,
        body: { data: { id: 52, customerId: 1, kind: "follow_up", happenedAt: 1750000000000, content: "x", createdAt: 1600, updatedAt: 1600, createdBy: { id: 1, nickname: "管理员" }, updatedBy: null } },
      };
    }
    if (url.includes("/customers/1/records/") && method === "DELETE") {
      return { status: 204, body: "" };
    }
    if (url.includes("/customers/1/overview")) {
      return { status: 200, body: { data: makeOverview(over) } };
    }
    if (url.startsWith("/api/v1/customers") && method === "PATCH") {
      return { status: 200, body: { data: { ...makeOverview(over).customer, updatedAt: 2001 } } };
    }
    if (url.includes("/customers/1/tags/generate") && method === "POST") {
      return { status: 200, body: { data: makeOverview(over).customer } };
    }
    // K54：查看资料详情（完整 content）
    if (url.startsWith("/api/v1/materials/") && method === "GET") {
      const material = makeOverview(over).materials.find((m) => url.endsWith(`/${m.id}`));
      if (material) return { status: 200, body: { data: { ...material, content: "资料完整全文" } } };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return calls;
}

describe("客户总览页", () => {
  it("渲染基本信息 / 统计 / 消费记录 / 当前圈子", async () => {
    mockOverviewApi(adminMe);
    renderApp("/customers/1");

    expect(await screen.findByText("张三")).toBeTruthy();
    expect(screen.getByText("行业：餐饮")).toBeTruthy();
    expect(screen.getByText("创业者")).toBeTruthy(); // 标签徽章
    expect(screen.getByText("成交笔数")).toBeTruthy();
    expect(screen.getByText("199.00")).toBeTruthy(); // 累计实付 元
    expect(screen.getByText("增长圈")).toBeTruthy(); // 消费记录产品
    expect(screen.getByText("私董圈子")).toBeTruthy(); // 当前圈子
  });

  it("AI 生成标签：点击 POST /tags/generate", async () => {
    const calls = mockOverviewApi(adminMe);
    renderApp("/customers/1");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "AI 生成标签" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.url.includes("/customers/1/tags/generate")),
      ).toBe(true),
    );
  });

  it("手动添加标签：点选可加标签后「保存」→ PATCH tagIds 并集", async () => {
    const calls = mockOverviewApi(adminMe);
    renderApp("/customers/1");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "已成交" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/customers/1");
      expect(patch).toBeTruthy();
      // 现有标签 [创业者(id1)] ∪ 新选 [已成交(id2)]
      expect(JSON.parse(String(patch?.body))).toEqual({ tagIds: [1, 2], updatedAt: 2000 });
    });
  });

  it("移除标签：点 chip × → PATCH 去掉该标签", async () => {
    const calls = mockOverviewApi(adminMe);
    renderApp("/customers/1");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "移除标签 创业者" }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/customers/1");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ tagIds: [], updatedAt: 2000 });
    });
  });

  it("自定义标签：输入新名 → POST /tags 创建 并 PATCH 挂载", async () => {
    const calls = mockOverviewApi(adminMe);
    renderApp("/customers/1");
    await screen.findByText("张三");

    const input = screen.getByPlaceholderText("输入自定义标签名…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "高端客户" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/tags")).toBe(true);
    });
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/customers/1");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ tagIds: [1, 99], updatedAt: 2000 });
    });
  });

  it("自定义标签：输入已有词表标签名 → 直接复用 PATCH（不 POST 新建）", async () => {
    const calls = mockOverviewApi(adminMe);
    renderApp("/customers/1");
    await screen.findByText("张三");

    const input = screen.getByPlaceholderText("输入自定义标签名…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "已成交" } }); // tags 词表 id=2
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/customers/1");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ tagIds: [1, 2], updatedAt: 2000 });
    });
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/tags")).toBe(false);
  });

  it("修改：admin 打开全字段编辑弹窗，保存仅 PATCH 变更键 + updatedAt", async () => {
    const calls = mockOverviewApi(adminMe);
    renderApp("/customers/1");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    const dialog = await screen.findByRole("dialog", { name: "修改客户：张三" });

    const phoneInput = within(dialog).getByLabelText(/手机号/) as HTMLInputElement;
    expect(phoneInput.value).toBe("13800000000");
    fireEvent.change(phoneInput, { target: { value: "13900000000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/customers/1");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ phone: "13900000000", updatedAt: 2000 });
    });
  });

  it("assistant：无 AI 生成按钮、无移除/添加标签（customers.update 其实有，但页面按 canUpdate 显示——assistant 有 update）", async () => {
    // assistant 有 customers.update，因此 AI/标签操作可见（与后端权限一致）
    mockOverviewApi(assistantMe);
    renderApp("/customers/1");
    expect(await screen.findByText("张三")).toBeTruthy();
    expect(screen.getByRole("button", { name: "AI 生成标签" })).toBeTruthy();
  });

  it("空成交/空圈子显示占位文案", async () => {
    mockOverviewApi(adminMe, { stats: { dealCount: 0, paidTotalCents: 0, lastDealAt: null, materialCount: 0, maintenanceRecordCount: 0 }, deals: [], circles: [] });
    renderApp("/customers/1");
    expect(await screen.findByText("暂无成交记录")).toBeTruthy();
    expect(screen.getByText("暂无当前有效的交付圈子")).toBeTruthy();
  });

  it("K54 资料：统计区显示资料数，资料列表渲染并可打开查看弹窗", async () => {
    const material = {
      id: 41,
      kind: "link",
      title: "访谈文章链接",
      url: "https://example.com/interview",
      contentLength: 0,
      excerpt: null,
      originalFilename: null,
      contentType: null,
      fileSize: null,
      isImage: false,
      deliveryId: 21,
      delivery: { id: 21, deliveryType: { id: 5, name: "私董圈子", kind: "circle" }, startsAt: 1700, endsAt: null },
      customers: [{ id: 1, nickname: "张三" }],
      createdAt: 1600,
      updatedAt: 1700,
      createdBy: null,
      updatedBy: null,
    };
    const calls = mockOverviewApi(adminMe, {
      stats: { dealCount: 2, paidTotalCents: 19900, lastDealAt: 1500, materialCount: 1, maintenanceRecordCount: 0 },
      materials: [material],
    });
    renderApp("/customers/1");

    expect(await screen.findByText("资料数")).toBeTruthy();
    // 断言 stat 数值（materialCount=1），不只是标签
    const statItem = screen.getByText("资料数").closest(".stat-item");
    expect(statItem?.querySelector(".stat-value")?.textContent).toBe("1");
    expect(screen.getByText("访谈文章链接")).toBeTruthy();
    expect(screen.getByText(/关联交付：私董圈子/)).toBeTruthy();

    // 打开查看弹窗：先 GET /materials/41 拉全文
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    const dialog = await screen.findByRole("dialog", { name: "访谈文章链接" });
    expect(calls.some((c) => c.method === "GET" && c.url === "/api/v1/materials/41")).toBe(true);
    expect(within(dialog).getByRole("link", { name: "https://example.com/interview" })).toBeTruthy();
  });

  it("K54 资料空态：暂无资料", async () => {
    mockOverviewApi(adminMe);
    renderApp("/customers/1");
    expect(await screen.findByText("暂无资料")).toBeTruthy();
  });

  it("K55 维护记录：admin 可新增/编辑/删除；assistant 只读", async () => {
    const record = {
      id: 51,
      customerId: 1,
      kind: "lead",
      happenedAt: 1750000000000,
      content: "对1v1感兴趣",
      createdAt: 1600,
      updatedAt: 1600,
      createdBy: { id: 1, nickname: "管理员" },
      updatedBy: null,
    };
    const calls = mockOverviewApi(adminMe, {
      stats: { dealCount: 2, paidTotalCents: 19900, lastDealAt: 1500, materialCount: 0, maintenanceRecordCount: 1 },
      maintenanceRecords: [record],
    });
    renderApp("/customers/1");

    expect(await screen.findByText("对1v1感兴趣")).toBeTruthy();
    expect(screen.getByText("线索意向")).toBeTruthy(); // kind badge label
    expect(screen.getByText("维护记录（1）")).toBeTruthy();

    // 新增
    fireEvent.click(screen.getByRole("button", { name: "新增记录" }));
    const dialog = await screen.findByRole("dialog", { name: "新增维护记录" });
    fireEvent.change(within(dialog).getByLabelText(/内容/), { target: { value: "新记录内容" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/customers/1/records")).toBe(true),
    );

    // 编辑
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const editDialog = await screen.findByRole("dialog", { name: "编辑维护记录" });
    fireEvent.click(within(editDialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "PATCH" && c.url === "/api/v1/customers/1/records/51"),
      ).toBe(true),
    );

    // 删除（复用 ConfirmDialog）：
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const delDialog = screen.getByRole("dialog", { name: "删除维护记录" });
    fireEvent.click(within(delDialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/customers/1/records/51"),
      ).toBe(true),
    );
  });

  it("K55 维护记录：assistant 只读（无新增/编辑/删除），但仍渲染记录", async () => {
    const record = {
      id: 51,
      customerId: 1,
      kind: "lead",
      happenedAt: 1750000000000,
      content: "对1v1感兴趣",
      createdAt: 1600,
      updatedAt: 1600,
      createdBy: { id: 2, nickname: "兼职助手" },
      updatedBy: null,
    };
    mockOverviewApi(assistantMe, {
      stats: { dealCount: 2, paidTotalCents: 19900, lastDealAt: 1500, materialCount: 0, maintenanceRecordCount: 1 },
      maintenanceRecords: [record],
    });
    renderApp("/customers/1");

    expect(await screen.findByText("对1v1感兴趣")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新增记录" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });
});
