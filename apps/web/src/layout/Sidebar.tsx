import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { NavLink } from "react-router-dom";
import { menuPagesSorted, PAGE_GROUPS, type PageDef, type PageKey } from "@gb-crm/shared";

import { useAuth } from "../auth/AuthProvider";
import { BRAND_NAME } from "../brand";

const NAV_LINK_CLASS = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");

/** 分组折叠状态持久化（每个分组一条 key） */
function groupStorageKey(group: string): string {
  return `gb-crm:sidebar:group:${group}`;
}

/**
 * 按侧栏分组渲染用户实际可见的菜单（安全层 can() ∩ 配置允许集，由 /auth/me.pages 下发）。
 * 分组标题可点击折叠/展开（复用 base.css 的 .collapsed 动画），持左状态到 localStorage。
 */
function NavGroup({ group, items }: { group: string; items: PageDef[] }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(groupStorageKey(group)) === "1";
    } catch {
      return false;
    }
  });

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(groupStorageKey(group), next ? "1" : "0");
      } catch {
        /* 忽略持久化失败 */
      }
      return next;
    });
  };

  return (
    <div className="nav-group">
      <button
        type="button"
        className={collapsed ? "nav-group-title collapsed" : "nav-group-title"}
        aria-expanded={!collapsed}
        onClick={toggle}
      >
        {group}
        <span className="nav-group-arrow" aria-hidden="true">
          <CaretDown size={12} weight="bold" />
        </span>
      </button>
      <div className={collapsed ? "nav-group-items collapsed" : "nav-group-items"}>
        {collapsed ? null : (
          <div className="nav-group-inner">
            {items.map((p) => (
              <NavLink key={p.key} to={p.path} className={NAV_LINK_CLASS}>
                {p.label}
              </NavLink>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 侧栏（K67）：桌面端 hidden 走负 margin 折叠；手机断点 drawerOpen 时变遮罩抽屉，
 * 遮罩由本组件渲染、点击回调 onCloseDrawer。
 */
export function Sidebar({
  hidden,
  drawerOpen = false,
  onCloseDrawer,
}: {
  hidden: boolean;
  drawerOpen?: boolean;
  onCloseDrawer?: () => void;
}) {
  const { me } = useAuth();
  const visible = menuPagesSorted((me?.pages ?? []) as PageKey[]);
  const byGroup = PAGE_GROUPS.map((group) => ({
    group,
    items: visible.filter((p) => p.group === group),
  })).filter((g) => g.items.length > 0);

  const className = drawerOpen
    ? "sidebar sidebar-drawer-open"
    : hidden
      ? "sidebar sidebar-hidden"
      : "sidebar";

  return (
    <>
      {drawerOpen && <div className="sidebar-mask" aria-hidden="true" onClick={onCloseDrawer} />}
      <aside className={className}>
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
    </>
  );
}
