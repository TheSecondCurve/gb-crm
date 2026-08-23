import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { canAccessPageKey, menuPagesSorted, type PageKey } from "@gb-crm/shared";

import { useAuth } from "../auth/AuthProvider";

/**
 * 路由级页面守卫：判断当前角色（/auth/me.pages，安全层 can() ∩ 配置允许集）
 * 是否能访问指定页面；无权则跳转到该角色第一张可看的菜单页（兜底 /login）。
 * 详情页传入自身 pageKey（走 parent 判断），菜单页传自身 key。
 */
export function PageGuard({ pageKey, children }: { pageKey: string; children: ReactNode }) {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const pages = (me?.pages ?? []) as PageKey[];
  if (role !== null && canAccessPageKey(role, pageKey, pages)) {
    return <>{children}</>;
  }
  const first = menuPagesSorted(pages)[0];
  return <Navigate to={first?.path ?? "/login"} replace />;
}
