import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

import App from "../src/App";
import { AuthProvider, type Me } from "../src/auth/AuthProvider";

export const adminMe: Me = { id: 1, username: "admin", nickname: "管理员", systemRole: "admin" };
export const assistantMe: Me = {
  id: 2,
  username: "assistant",
  nickname: "兼职助手",
  systemRole: "assistant",
};

interface MockResponse {
  status: number;
  body?: unknown;
}

type FetchHandler = (
  url: string,
  init?: { method?: string; body?: string },
) => MockResponse | undefined;

/** 用纯对象模拟 Response（client.ts 只读 status / ok / json()）。未匹配路径抛错，防漏 mock。 */
export function mockFetch(handler: FetchHandler) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const res = handler(String(input), init as { method?: string; body?: string } | undefined);
    if (!res) throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${String(input)}`);
    return Promise.resolve({
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      json: () => Promise.resolve(res.body),
    } as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export const unauthorized = (): MockResponse => ({
  status: 401,
  body: { error: { code: "UNAUTHORIZED", message: "未登录或会话已过期" } },
});

export function renderApp(initialPath = "/"): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(tree);
}
