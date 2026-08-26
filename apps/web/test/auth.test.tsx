import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { api, ApiError, setUnauthorizedHandler } from "../src/api/client";
import { adminMe, emptyList, Me, mockFetch, renderApp, unauthorized } from "./helpers";

describe("认证与路由", () => {
  it("未登录访问 /customers → 跳 /login", async () => {
    mockFetch((url) => {
      if (url === "/api/v1/auth/me") return unauthorized();
    });
    renderApp("/customers");
    expect(await screen.findByRole("heading", { name: "女商 私域运营管理端" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "客户信息" })).toBeNull();
  });

  it("登录成功 → 跳 /customers", async () => {
    let loggedIn = false;
    const fetchMock = mockFetch((url, init) => {
      if (url === "/api/v1/auth/me") {
        return loggedIn ? { status: 200, body: { data: adminMe } } : unauthorized();
      }
      if (url.startsWith("/api/v1/customers")) return emptyList();
      if (url === "/api/v1/auth/login" && init?.method === "POST") {
        loggedIn = true;
        return { status: 204 };
      }
    });
    renderApp("/login");

    fireEvent.change(await screen.findByLabelText("用户名"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret-ok-1" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("heading", { name: "客户信息" })).toBeTruthy();
    const loginCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/v1/auth/login");
    expect(loginCall).toBeTruthy();
    expect(JSON.parse(String(loginCall?.[1]?.body))).toEqual({
      username: "admin",
      password: "secret-ok-1",
    });
  });

  it("登录 401 → 显示统一中文错误", async () => {
    mockFetch((url, init) => {
      if (url === "/api/v1/auth/me") return unauthorized();
      if (url === "/api/v1/auth/login" && init?.method === "POST") {
        return {
          status: 401,
          body: { error: { code: "INVALID_CREDENTIALS", message: "用户名或密码错误" } },
        };
      }
    });
    renderApp("/login");

    fireEvent.change(await screen.findByLabelText("用户名"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("用户名或密码错误")).toBeTruthy();
    // 仍在登录页
    expect(screen.getByRole("heading", { name: "女商 私域运营管理端" })).toBeTruthy();
  });

  it("已登录访问 /login → 跳 /customers", async () => {
    mockFetch((url) => {
      if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
      if (url.startsWith("/api/v1/customers")) return emptyList();
    });
    renderApp("/login");
    expect(await screen.findByRole("heading", { name: "客户信息" })).toBeTruthy();
  });

  it("退出登录 → 回 /login", async () => {
    let loggedIn = true;
    mockFetch((url, init) => {
      if (url === "/api/v1/auth/me") {
        return loggedIn ? { status: 200, body: { data: adminMe } } : unauthorized();
      }
      if (url.startsWith("/api/v1/customers")) return emptyList();
      if (url === "/api/v1/auth/logout" && init?.method === "POST") {
        loggedIn = false;
        return { status: 204 };
      }
    });
    renderApp("/customers");

    fireEvent.click(await screen.findByRole("button", { name: "退出" }));

    expect(await screen.findByRole("heading", { name: "女商 私域运营管理端" })).toBeTruthy();
  });
});

describe("会话失效 401 分流（H4）", () => {
  it("任意接口收到 401 → me 置空，自动跳登录页", async () => {
    mockFetch((url) => {
      if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
      if (url.startsWith("/api/v1/customers")) return emptyList();
      if (url.startsWith("/api/v1/products")) return unauthorized();
    });
    renderApp("/customers");
    await screen.findByRole("heading", { name: "客户信息" });

    // 切到产品目录触发一次会 401 的请求
    fireEvent.click(screen.getByRole("link", { name: "产品目录" }));

    expect(await screen.findByRole("heading", { name: "女商 私域运营管理端" })).toBeTruthy();
  });

  it("POST /auth/login 自身的 401 不触发未授权回调；其它路径 401 触发一次", async () => {
    let fired = 0;
    setUnauthorizedHandler(() => {
      fired += 1;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          status: 401,
          ok: false,
          json: () =>
            Promise.resolve({ error: { code: "UNAUTHORIZED", message: "用户名或密码错误" } }),
        } as Response),
      ),
    );

    await expect(api.post("/auth/login", { username: "a", password: "b" })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fired).toBe(0);

    await expect(api.get("/customers")).rejects.toBeInstanceOf(ApiError);
    expect(fired).toBe(1);

    setUnauthorizedHandler(null);
  });
});

describe("角色无可用页面兜底（H5）", () => {
  const emptyPagesMe: Me = { ...adminMe, id: 9, systemRole: "operator", pages: [] };

  it("pages 为空：访问 /login 显示占位，而非跳转死循环", async () => {
    mockFetch((url) => {
      if (url === "/api/v1/auth/me") return { status: 200, body: { data: emptyPagesMe } };
    });
    renderApp("/login");
    expect(await screen.findByText("当前角色未配置任何可用页面，请联系管理员")).toBeTruthy();
  });

  it("pages 为空：访问受保护页显示占位，而非踢回 /login", async () => {
    mockFetch((url) => {
      if (url === "/api/v1/auth/me") return { status: 200, body: { data: emptyPagesMe } };
    });
    renderApp("/customers");
    expect(await screen.findByText("当前角色未配置任何可用页面，请联系管理员")).toBeTruthy();
  });

  it("pages 为空的用户登录成功 → 登录页就地显示占位", async () => {
    let loggedIn = false;
    mockFetch((url, init) => {
      if (url === "/api/v1/auth/me") {
        return loggedIn ? { status: 200, body: { data: emptyPagesMe } } : unauthorized();
      }
      if (url === "/api/v1/auth/login" && init?.method === "POST") {
        loggedIn = true;
        return { status: 204 };
      }
    });
    renderApp("/login");

    fireEvent.change(await screen.findByLabelText("用户名"), { target: { value: "op" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("当前角色未配置任何可用页面，请联系管理员")).toBeTruthy();
  });

  it("落地页推导：无 customers 页时取第一张可看菜单页；有 customers 页仍优先客户页", async () => {
    const opMe: Me = { ...adminMe, id: 10, systemRole: "operator", pages: ["products"] };
    mockFetch((url) => {
      if (url === "/api/v1/auth/me") return { status: 200, body: { data: opMe } };
      if (url.startsWith("/api/v1/products")) return emptyList();
    });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "产品目录" })).toBeTruthy();
  });
});
