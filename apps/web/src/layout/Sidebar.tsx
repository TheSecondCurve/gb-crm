import { NavLink } from "react-router-dom";
import { menuPagesSorted, PAGE_GROUPS, type PageDef, type PageKey } from "@gb-crm/shared";

import { useAuth } from "../auth/AuthProvider";
import { BRAND_NAME } from "../brand";

const NAV_LINK_CLASS = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");

/** 按侧栏分组渲染用户实际可见的菜单（安全层 can() ∩ 配置允许集，由 /auth/me.pages 下发） */
function NavGroup({ group, items }: { group: string; items: PageDef[] }) {
  return (
    <div className="nav-group">
      <div className="nav-group-title">{group}</div>
      <div className="nav-group-items">
        <div className="nav-group-inner">
          {items.map((p) => (
            <NavLink key={p.key} to={p.path} className={NAV_LINK_CLASS}>
              {p.label}
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ hidden }: { hidden: boolean }) {
  const { me } = useAuth();
  const visible = menuPagesSorted((me?.pages ?? []) as PageKey[]);
  const byGroup = PAGE_GROUPS.map((group) => ({
    group,
    items: visible.filter((p) => p.group === group),
  })).filter((g) => g.items.length > 0);

  return (
    <aside className={hidden ? "sidebar sidebar-hidden" : "sidebar"}>
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true" />
        {BRAND_NAME}
      </div>
      <nav className="sidebar-nav">
        {byGroup.map((g) => (
          <NavGroup key={g.group} group={g.group} items={g.items} />
        ))}
      </nav>
    </aside>
  );
}
