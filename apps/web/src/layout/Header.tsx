import { useLocation } from "react-router-dom";

import { useAuth } from "../auth/AuthProvider";

/** 与 v1 导航（design.md §4）一致的路径 → 面包屑 */
const PATH_LABELS: Record<string, string> = {
  "/customers": "客户信息",
  "/channels": "渠道资产",
  "/products": "产品目录",
  "/users": "团队成员",
};

export function Header({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { me, logout } = useAuth();
  const location = useLocation();
  const label = PATH_LABELS[location.pathname] ?? "";

  return (
    <header className="app-header">
      <button type="button" className="sidebar-toggle" aria-label="折叠侧栏" onClick={onToggleSidebar}>
        ☰
      </button>
      <div className="breadcrumb">{label}</div>
      <div className="navbar-user">
        <span className="navbar-username">{me?.nickname}</span>
        <button type="button" className="navbar-logout" onClick={() => void logout()}>
          退出
        </button>
      </div>
    </header>
  );
}
