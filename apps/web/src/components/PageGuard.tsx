import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { canAccessPageKey, menuPagesSorted, type PageKey } from "@gb-crm/shared";

import { useAuth } from "../auth/AuthProvider";

/** H5：存量脏配置（角色页面集为空）的兜底占位页，避免登录页 ↔ 守卫互相导航死循环 */
export function NoPagesPlaceholder() {
  return (
    <div className="page-loading" role="alert">
      当前角色未配置任何可用页面，请联系管理员
    </div>
  );
}

/**
 * 落地页推导（统一入口）：customers 在允许集中优先客户页（保留原行为），
 * 否则取该角色第一张可看菜单页；pages 为空返回 null（调用方渲染 NoPagesPlaceholder）。
 */
export function homePath(pages: string[]): string | null {
  if (pages.length === 0) return null;
  if (pages.includes("customers")) return "/customers";
  return menuPagesSorted(pages as PageKey[])[0]?.path ?? null;
}

/**
 * 路由级页面守卫：判断当前角色（/auth/me.pages，安全层 can() ∩ 配置允许集）
 * 是否能访问指定页面；无权则跳转到该角色第一张可看的菜单页。
 * pages 为空（存量脏配置）时渲染占位页而不是踢回 /login（防死循环，H5）。
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
  // role 为空理论到不了这里（RequireAuth 已拦）；pages 为空则无路可去 → 占位兜底
  if (!first && role !== null) return <NoPagesPlaceholder />;
  return <Navigate to={first?.path ?? "/login"} replace />;
}
