import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { adminMe, mockFetch, renderApp, unauthorized } from "./helpers";

describe("认证与路由", () => {
  it("未登录访问 /customers → 跳 /login", async () => {
    mockFetch((url) => {
      if (url === "/api/v1/auth/me") return unauthorized();
    });
    renderApp("/customers");
    expect(await screen.findByRole("heading", { name: "闪光 · 客户运营" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "客户信息" })).toBeNull();
  });

  it("登录成功 → 跳 /customers", async () => {
    let loggedIn = false;
    const fetchMock = mockFetch((url, init) => {
      if (url === "/api/v1/auth/me") {
        return loggedIn ? { status: 200, body: { data: adminMe } } : unauthorized();
      }
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
    expect(screen.getByRole("heading", { name: "闪光 · 客户运营" })).toBeTruthy();
  });

  it("已登录访问 /login → 跳 /customers", async () => {
    mockFetch((url) => {
      if (url === "/api/v1/auth/me") return { status: 200, body: { data: adminMe } };
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
      if (url === "/api/v1/auth/logout" && init?.method === "POST") {
        loggedIn = false;
        return { status: 204 };
      }
    });
    renderApp("/customers");

    fireEvent.click(await screen.findByRole("button", { name: "退出" }));

    expect(await screen.findByRole("heading", { name: "闪光 · 客户运营" })).toBeTruthy();
  });
});
