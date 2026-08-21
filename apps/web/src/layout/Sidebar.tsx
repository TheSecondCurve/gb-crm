import { NavLink } from "react-router-dom";
import { can } from "@gb-crm/shared";

import { useAuth } from "../auth/AuthProvider";
import { BRAND_NAME } from "../brand";

const NAV_LINK_CLASS = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");

export function Sidebar({ hidden }: { hidden: boolean }) {
  const { me } = useAuth();
  const canListUsers = can(me?.systemRole ?? null, "users", "list");

  return (
    <aside className={hidden ? "sidebar sidebar-hidden" : "sidebar"}>
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true" />
        {BRAND_NAME}
      </div>
      <nav className="sidebar-nav">
        <div className="nav-group">
          <div className="nav-group-title">主数据</div>
          <div className="nav-group-items">
            <div className="nav-group-inner">
              <NavLink to="/customers" className={NAV_LINK_CLASS}>
                客户信息
              </NavLink>
              <NavLink to="/channels" className={NAV_LINK_CLASS}>
                渠道资产
              </NavLink>
              <NavLink to="/products" className={NAV_LINK_CLASS}>
                产品目录
              </NavLink>
            </div>
          </div>
        </div>
        {canListUsers && (
          <div className="nav-group">
            <div className="nav-group-title">系统</div>
            <div className="nav-group-items">
              <div className="nav-group-inner">
                <NavLink to="/users" className={NAV_LINK_CLASS}>
                  团队成员
                </NavLink>
              </div>
            </div>
          </div>
        )}
      </nav>
    </aside>
  );
}
