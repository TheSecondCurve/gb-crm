import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, mockFetch, operatorMe, renderApp, type Me } from "./helpers";
import type { UserDto } from "../src/api/types";

function makeUser(partial: Partial<UserDto>): UserDto {
  return {
    id: 1,
    username: "admin",
    nickname: "管理员",
    realName: null,
    phone: null,
    wechat: null,
    jobTitle: "partner",
    systemRole: "admin",
    employmentStatus: "employed",
    accountStatus: "enabled",
    duties: null,
    notes: null,
    createdAt: 1000,
    updatedAt: 2000,
    createdBy: null,
    updatedBy: null,
    ...partial,
  };
}

const users = [
  makeUser({ id: 1 }),
  makeUser({
    id: 2,
    username: null,
    nickname: "小李",
    jobTitle: "ops",
    systemRole: null,
    accountStatus: "disabled",
  }),
];

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockUsersApi(me: Me, rows: UserDto[] = users) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/users")) {
      if (method === "GET") {
        return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
      }
      if (method === "POST" && url.endsWith("/password")) return { status: 204 };
      if (method === "POST") {
        return { status: 201, body: { data: makeUser({ id: 99, nickname: "新成员" }) } };
      }
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { data: { ...users[0]!, ...patch, updatedAt: 2001 } } };
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

describe("团队成员页", () => {
  it("渲染列表：徽章枚举；失效账户行 .row-disabled", async () => {
    mockUsersApi(adminMe);
    renderApp("/users");
    expect(await screen.findByText("小李")).toBeTruthy();
    expect(screen.getByText("合伙人")).toBeTruthy(); // jobTitle badge
    expect(screen.getByText("运营")).toBeTruthy(); // jobTitle ops badge
    expect(screen.getAllByText("失效").length).toBeGreaterThan(0); // accountStatus badge（过滤下拉里也有同名 option）

    const disabledRow = screen.getByText("小李").closest("tr");
    expect(disabledRow?.classList.contains("row-disabled")).toBe(true);
  });

  it("q 搜索 / 账户状态过滤 / pageSize 切换各触发新 query", async () => {
    const calls = mockUsersApi(adminMe);
    renderApp("/users");
    await screen.findByText("小李");

    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "小" } });
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "GET" && decodeURIComponent(c.url).includes("q=小")),
      ).toBe(true),
    );

    fireEvent.change(screen.getByLabelText("账户状态筛选"), { target: { value: "disabled" } });
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("accountStatus=disabled"))).toBe(true),
    );

    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "100" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("pageSize=100"))).toBe(true));
  });

  it("username 列只读（双击无编辑器）", async () => {
    mockUsersApi(adminMe);
    renderApp("/users");
    await screen.findByText("小李");
    fireEvent.doubleClick(cell(1, "username"));
    expect(cell(1, "username").querySelector("input,select")).toBeNull();
  });

  it("admin：新增成员走表单 Modal，POST /users", async () => {
    const calls = mockUsersApi(adminMe);
    renderApp("/users");
    await screen.findByText("小李");

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    const dialog = screen.getByRole("dialog", { name: "新增成员" });
    fireEvent.change(within(dialog).getByLabelText("昵称"), { target: { value: "新成员" } });
    fireEvent.change(within(dialog).getByLabelText("用户名"), { target: { value: "newbie" } });
    fireEvent.change(within(dialog).getByLabelText(/^密码/), { target: { value: "abcd1234" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/users");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toMatchObject({
        nickname: "新成员",
        username: "newbie",
        password: "abcd1234",
        jobTitle: "other",
        systemRole: null,
        employmentStatus: "employed",
        accountStatus: "enabled",
      });
    });
  });

  it("admin：设置密码 Modal → POST /users/:id/password；短密码客户端拦截", async () => {
    const calls = mockUsersApi(adminMe);
    renderApp("/users");
    await screen.findByText("小李");

    fireEvent.click(screen.getAllByRole("button", { name: "设置密码" })[1]!);
    const dialog = screen.getByRole("dialog", { name: "设置密码：小李" });

    // 短密码：不发出请求
    fireEvent.change(within(dialog).getByLabelText(/^新密码/), { target: { value: "short" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));
    expect(await within(dialog).findByText("密码至少 8 位")).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/password"))).toBe(false);

    fireEvent.change(within(dialog).getByLabelText(/^新密码/), { target: { value: "newpass123" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/users/2/password");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toEqual({ password: "newpass123" });
    });
  });

  it("operator：只读，无新增/设置密码/删除按钮", async () => {
    mockUsersApi(operatorMe);
    renderApp("/users");
    await screen.findByText("小李");

    expect(screen.queryByRole("button", { name: "新增" })).toBeNull();
    expect(screen.queryByRole("button", { name: "设置密码" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();

    fireEvent.doubleClick(cell(1, "nickname"));
    expect(cell(1, "nickname").querySelector("input")).toBeNull();
  });

  it("删除：ConfirmDialog → DELETE → 列表刷新", async () => {
    const calls = mockUsersApi(adminMe);
    renderApp("/users");
    await screen.findByText("小李");

    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[1]!);
    const dialog = screen.getByRole("dialog", { name: "删除成员" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/users/2")).toBe(true),
    );
  });
});
