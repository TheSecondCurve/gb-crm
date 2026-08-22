import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { CustomerDto } from "../src/api/types";

const customer: CustomerDto = {
  id: 1,
  feishuRecordId: null,
  nickname: "张三",
  realName: null,
  title: null,
  phone: "13800000000",
  wechat: null,
  otherSocial: null,
  wechatChannelsAccount: null,
  xiaoyuzhouAccount: null,
  xiaohongshuAccount: null,
  weiboAccount: null,
  douyinAccount: null,
  country: null,
  city: "上海",
  originStory: null,
  notes: null,
  profileUrl: null,
  customerType: "customer",
  parentId: null,
  wechatOpenid: null,
  lastFollowedAt: null,
  feishuCreatedDate: null,
  tagCodes: ["vip"],
  owners: [{ id: 1, nickname: "老王" }],
  upsellOwners: [],
  sourceChannels: [],
  communityChannels: [],
  parent: null,
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
    if (url.startsWith("/api/v1/users")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 1, nickname: "老王" },
            { id: 2, nickname: "小李" },
          ],
          meta: { page: 1, pageSize: 100, total: 2 },
        },
      };
    }
    if (url.startsWith("/api/v1/customers")) {
      if (method === "GET") {
        return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
      }
      if (method === "POST") {
        return { status: 201, body: { data: { ...customer, id: 99, nickname: "未命名客户" } } };
      }
      if (method === "PATCH") return { status: 200, body: { data: { ...customer, updatedAt: 2001 } } };
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

describe("客户信息页", () => {
  it("渲染列表：昵称/徽章/归属人展开", async () => {
    mockCustomersApi(adminMe);
    renderApp("/customers");
    expect(await screen.findByText("张三")).toBeTruthy();
    expect(screen.getByText("13800000000")).toBeTruthy();
    expect(screen.getByText("VIP")).toBeTruthy(); // 标签 badge
    expect(screen.getByText("老王")).toBeTruthy(); // 归属人展开
    const headers = [...document.querySelectorAll(".data-grid-table th")].map((th) => th.textContent);
    expect(headers).toEqual(
      expect.arrayContaining(["昵称", "真实姓名", "手机号", "微信号", "类型", "标签", "城市", "归属人", "更新时间"]),
    );
  });

  it("q 搜索触发新 query（300ms debounce 后带 q 参数）", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "张" } });
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "GET" && decodeURIComponent(c.url).includes("q=张")),
      ).toBe(true),
    );
  });

  it("类型过滤下拉触发新 query", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "partner" } });
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("customerType=partner"))).toBe(true),
    );
  });

  it("pageSize 切换触发新 query", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "50" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("pageSize=50"))).toBe(true));
  });

  it("assistant：无新增/删除按钮，归属人列只读（K31）", async () => {
    mockCustomersApi(assistantMe);
    renderApp("/customers");
    await screen.findByText("张三");

    expect(screen.queryByRole("button", { name: "新增" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();

    // 归属人双击无编辑器
    fireEvent.doubleClick(cell(1, "owners"));
    expect(cell(1, "owners").querySelector(".cell-dropdown")).toBeNull();

    // 普通字段仍可编（assistant 有 customers.update）
    fireEvent.doubleClick(cell(1, "nickname"));
    expect(cell(1, "nickname").querySelector("input")).toBeTruthy();
  });

  it("admin：新增/删除可见，归属人列可编（relation 选项来自 GET /users）", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    expect(screen.getByRole("button", { name: "新增" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();

    fireEvent.doubleClick(cell(1, "owners"));
    expect(await screen.findByLabelText("小李")).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith("/api/v1/users") && c.url.includes("pageSize=100"))).toBe(
      true,
    );
  });

  it("新增：弹字段表单（不再直接 POST 空行），填字段后 POST 并刷新列表", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    const dialog = screen.getByRole("dialog", { name: "新增客户" });
    // 弹窗阶段不发请求
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.change(within(dialog).getByLabelText("昵称"), { target: { value: "新客户" } });
    fireEvent.change(within(dialog).getByLabelText("城市"), { target: { value: "北京" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/customers");
      expect(post).toBeTruthy();
      // 只带填了值的键；未动的 select（类型）缺席，走服务端默认
      expect(JSON.parse(String(post?.body))).toEqual({ nickname: "新客户", city: "北京" });
    });
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/customers")).length).toBeGreaterThanOrEqual(2),
    );
  });

  it("删除：行尾按钮 → ConfirmDialog → DELETE → 列表刷新", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除客户" });
    expect(within(dialog).getByText(/确定删除客户「张三」/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/customers/1")).toBe(true),
    );
    // 删除后 invalidate 重新拉列表
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/customers")).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });
});
