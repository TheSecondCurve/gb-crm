import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { CustomerDto } from "../src/api/types";

const customer: CustomerDto = {
  id: 1,
  nickname: "张三",
  realName: null,
  title: null,
  phone: "13800000000",
  wechat: null,
  country: null,
  city: "上海",
  industry: null,
  originStory: null,
  notes: null,
  customerType: "customer",
  wechatOpenid: null,
  lastFollowedAt: null,
  socialAccounts: [],
  tags: [],
  owner: { id: 1, nickname: "老王" },
  sourceChannels: [],
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

function mockCustomersApi(me: Me, rows: CustomerDto[] = [customer], failDelete = false) {
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
    // 表单弹窗的 relation 选项 loader（来源渠道 = GET /channels?pageSize=100）
    if (url.startsWith("/api/v1/channels")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 1, name: "公众号A" },
            { id: 2, name: "社群B" },
          ],
          meta: { page: 1, pageSize: 100, total: 2 },
        },
      };
    }
    // K45：标签筛选下拉选项
    if (url.startsWith("/api/v1/tags")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 1, name: "创业者", scope: "identity", sort: 1, enabled: true },
            { id: 2, name: "已成交", scope: "stage", sort: 1, enabled: true },
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
      if (method === "DELETE") {
        return failDelete
          ? { status: 500, body: { error: { code: "INTERNAL", message: "服务器错误" } } }
          : { status: 204 };
      }
    }
    // K51：创建后台任务（POST）+ 跳转后任务列表（GET）
    if (url.startsWith("/api/v1/background-jobs")) {
      if (method === "GET") {
        return { status: 200, body: { data: [], meta: { page: 1, pageSize: 50, total: 0 } } };
      }
      return { status: 201, body: { data: { id: 1, type: "customer-tags-generate-all", status: "queued" } } };
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
  it("渲染列表：昵称/手机号/归属人展开", async () => {
    mockCustomersApi(adminMe);
    renderApp("/customers");
    expect(await screen.findByText("张三")).toBeTruthy();
    expect(screen.getByText("13800000000")).toBeTruthy();
    expect(screen.getByText("老王")).toBeTruthy(); // 归属人展开
    const headers = [...document.querySelectorAll(".data-grid-table th")].map((th) => th.textContent);
    expect(headers).toEqual(
      expect.arrayContaining(["昵称", "真实姓名", "手机号", "微信号", "类型", "城市", "归属人", "更新时间"]),
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

  it("标签筛选下拉触发 tagId query（K45）", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    fireEvent.change(screen.getByLabelText("标签筛选"), { target: { value: "1" } });
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("tagId=1"))).toBe(true),
    );
  });

  it("行操作「总览」按钮跳转 /customers/:id（触发 overview 请求）", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "总览" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "GET" && c.url.includes("/customers/1/overview")),
      ).toBe(true),
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
    fireEvent.doubleClick(cell(1, "owner"));
    expect(cell(1, "owner").querySelector(".cell-dropdown")).toBeNull();

    // 普通字段仍可编（assistant 有 customers.update）
    fireEvent.doubleClick(cell(1, "nickname"));
    expect(cell(1, "nickname").querySelector("input")).toBeTruthy();
  });

  it("admin：新增/删除可见，归属人列可编（relation-one 单选，选项来自 GET /users）", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    expect(screen.getByRole("button", { name: "新增" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();

    fireEvent.doubleClick(cell(1, "owner"));
    expect(await screen.findByRole("button", { name: "小李" })).toBeTruthy();
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

  it("修改：行尾按钮弹全字段表单（预填），PATCH 只带变更键 + updatedAt；清空标量 = null", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    const dialog = await screen.findByRole("dialog", { name: "修改客户：张三" });
    // 弹窗阶段不发 PATCH；字段已预填当前行
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect((within(dialog).getByLabelText("昵称") as HTMLInputElement).value).toBe("张三");
    expect((within(dialog).getByLabelText("城市") as HTMLInputElement).value).toBe("上海");

    fireEvent.change(within(dialog).getByLabelText("城市"), { target: { value: "杭州" } });
    fireEvent.change(within(dialog).getByLabelText("手机号"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/customers/1");
      expect(patch).toBeTruthy();
      // 只带变更键 + OCC updatedAt；未动的昵称/类型缺席，清空的可空标量 = null
      expect(JSON.parse(String(patch?.body))).toEqual({
        city: "杭州",
        phone: null,
        updatedAt: 2000,
      });
    });
    // 列表页刷新用 pageSize=25，与弹窗关系选项 loader 的 pageSize=100 区分开
    await waitFor(() =>
      expect(
        calls.filter(
          (c) =>
            c.method === "GET" &&
            c.url.startsWith("/api/v1/customers") &&
            c.url.includes("pageSize=25"),
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it("导出 Excel：按钮触发同源下载，href 跟随当前 q 与类型筛选", async () => {
    const calls = mockCustomersApi(adminMe);
    const hrefs: string[] = [];
    const spy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        hrefs.push(this.href);
      });
    try {
      renderApp("/customers");
      await screen.findByText("张三");

      // 无筛选：纯导出 URL
      fireEvent.click(screen.getByRole("button", { name: "导出 Excel" }));
      expect(hrefs.at(-1)).toContain("/api/v1/customers/export.xlsx");

      // 搜索 + 类型筛选后再导出：带上 q 与 customerType
      fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "张" } });
      fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "company" } });
      // 搜索 300ms debounce：等 q 真正进入列表 query 再点导出
      await waitFor(() =>
        expect(calls.some((c) => decodeURIComponent(c.url).includes("q=张"))).toBe(true),
      );
      fireEvent.click(screen.getByRole("button", { name: "导出 Excel" }));
      const href = decodeURIComponent(hrefs.at(-1) ?? "");
      expect(href).toContain("q=张");
      expect(href).toContain("customerType=company");

      // M7：标签筛选也要跟随（导出复用列表同一 WHERE）
      fireEvent.change(screen.getByLabelText("标签筛选"), { target: { value: "2" } });
      await waitFor(() => expect(calls.some((c) => c.url.includes("tagId=2"))).toBe(true));
      fireEvent.click(screen.getByRole("button", { name: "导出 Excel" }));
      expect(decodeURIComponent(hrefs.at(-1) ?? "")).toContain("tagId=2");
    } finally {
      spy.mockRestore();
    }
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

  it("删除失败：toast 提示错误信息，确认框不卡死（M13）", async () => {
    const calls = mockCustomersApi(adminMe, [customer], true);
    renderApp("/customers");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除客户" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.getByText("服务器错误")).toBeTruthy());
    expect(screen.getByRole("dialog", { name: "删除客户" })).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/customers/1")).toBe(true);
  });

  it("批量改归属人：勾选行 → 选归属人 → 应用 → 逐行 PATCH 带各自 updatedAt", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    fireEvent.click(screen.getByLabelText("全选当前页"));
    expect(screen.getByText("已选 1 项")).toBeTruthy();

    // 用户选项来自 GET /users?pageSize=100（mockCustomersApi 已 mock users）
    await screen.findByRole("option", { name: "小李" });
    fireEvent.change(screen.getByLabelText("批量归属人"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "应用归属人" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/customers/1");
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch?.body));
      expect(body.ownerId).toBe(2);
      expect(body.updatedAt).toBe(2000); // 该行自身的 OCC 值
    });
  });

  it("全量生成标签：确认后创建后台任务（POST /background-jobs，无筛选 params={}）并跳转后台任务 tab", async () => {
    const calls = mockCustomersApi(adminMe);
    renderApp("/customers");
    await screen.findByText("张三");

    fireEvent.click(screen.getByRole("button", { name: "全量生成标签" }));
    const dialog = screen.getByRole("dialog", { name: "全量生成标签" });
    expect(within(dialog).getByText(/1 个客户/)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false); // 确认前不发请求

    fireEvent.click(within(dialog).getByRole("button", { name: "创建任务" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/background-jobs");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toEqual({
        type: "customer-tags-generate-all",
        params: {},
      });
    });
    // 跳转到业务设置-后台任务 tab
    expect(await screen.findByRole("tab", { name: "后台任务" })).toBeTruthy();
  });
});
