import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

import App from "../src/App";
import { AuthProvider, type Me } from "../src/auth/AuthProvider";

export type { Me };

export const adminMe: Me = {
  id: 1,
  username: "admin",
  nickname: "管理员",
  systemRole: "admin",
  impersonatedBy: null,
};
export const assistantMe: Me = {
  id: 2,
  username: "assistant",
  nickname: "兼职助手",
  systemRole: "assistant",
  impersonatedBy: null,
};
export const operatorMe: Me = {
  id: 3,
  username: "operator",
  nickname: "团队运营",
  systemRole: "operator",
  impersonatedBy: null,
};

/** K49：扮演中的 me（真实身份是 admin，当前以 target 身份操作） */
export const impersonatingMe: Me = {
  id: 2,
  username: "assistant",
  nickname: "兼职助手",
  systemRole: "assistant",
  impersonatedBy: { id: 1, nickname: "管理员" },
};

/** 空列表响应（落在列表页但本测试不关心列表数据时用） */
export const emptyList = (): MockResponse => ({
  status: 200,
  body: { data: [], meta: { page: 1, pageSize: 25, total: 0 } },
});

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
