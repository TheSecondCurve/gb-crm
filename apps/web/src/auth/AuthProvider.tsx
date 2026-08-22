import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SystemRole } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";

/** GET /api/v1/auth/me 的响应形状（无 passwordHash） */
export interface Me {
  id: number;
  username: string | null;
  nickname: string;
  systemRole: SystemRole | null;
  /** K49：扮演发起人（原 admin）。非空 = 当前正以 me 的身份扮演中 */
  impersonatedBy: { id: number; nickname: string } | null;
}

interface AuthContextValue {
  me: Me | null;
  /** 首次 GET /auth/me 进行中（受保护路由据此显示占位） */
  isLoading: boolean;
  /** 成功 204 + 写 session cookie 后刷新 me；失败抛 ApiError（401 为统一中文文案） */
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** K49：admin 扮演用户（POST /auth/impersonate/:id 后刷新 me） */
  impersonate: (userId: number) => Promise<void>;
  /** K49：退出扮演（POST /auth/impersonate/stop 后刷新 me） */
  stopImpersonation: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ME_QUERY_KEY = ["auth", "me"] as const;

async function fetchMe(): Promise<Me | null> {
  try {
    const res = await api.get<{ data: Me }>("/auth/me");
    return res?.data ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    staleTime: Infinity,
    retry: false,
  });

  const login = useCallback(
    async (username: string, password: string) => {
      await api.post("/auth/login", { username, password });
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      queryClient.setQueryData(ME_QUERY_KEY, null);
    }
  }, [queryClient]);

  const impersonate = useCallback(
    async (userId: number) => {
      await api.post(`/auth/impersonate/${userId}`);
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    [queryClient],
  );

  const stopImpersonation = useCallback(async () => {
    await api.post("/auth/impersonate/stop");
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }, [queryClient]);

  return (
    <AuthContext.Provider
      value={{ me: data ?? null, isLoading, login, logout, impersonate, stopImpersonation }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必须在 AuthProvider 内使用");
  return ctx;
}
