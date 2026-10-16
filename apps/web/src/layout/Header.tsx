import { useState } from "react";
import { CaretDown, List, MagnifyingGlass } from "@phosphor-icons/react";
import { can, systemRoleLabels } from "@gb-crm/shared";
import { useLocation } from "react-router-dom";

import { useAuth } from "../auth/AuthProvider";
import { ImpersonateModal } from "../components/ImpersonateModal";
import { breadcrumbLabel } from "./breadcrumb";

interface HeaderProps {
  onToggleSidebar: () => void;
  /** 打开全局快速搜索（K67：触屏没有 Cmd/Ctrl+K，顶栏给常驻入口） */
  onOpenSearch: () => void;
  sidebarToggleLabel?: string;
}

export function Header({ onToggleSidebar, onOpenSearch, sidebarToggleLabel = "折叠侧栏" }: HeaderProps) {
  const { me, logout, stopImpersonation } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [impersonateOpen, setImpersonateOpen] = useState(false);
  const location = useLocation();
  const label = breadcrumbLabel(location.pathname);

  const canImpersonate = can(me?.systemRole ?? null, "auth", "impersonate");
  // 与 CommandPalette 的权限门控一致：有客户页可见才给搜索入口
  const canSearch =
    (me?.pages ?? []).includes("customers") || (me?.pages ?? []).includes("my-customers");
  const impersonating = me?.impersonatedBy != null;
  const roleLabel = me?.systemRole ? systemRoleLabels[me.systemRole] : "";

  return (
    <header className="app-header">
      <button type="button" className="sidebar-toggle" aria-label={sidebarToggleLabel} onClick={onToggleSidebar}>
        <List size={18} weight="bold" aria-hidden="true" />
      </button>
      <div className="breadcrumb">{label}</div>
      <div className="navbar-user">
        {canSearch && (
          <button type="button" className="header-search" aria-label="搜索客户" onClick={onOpenSearch}>
            <MagnifyingGlass size={18} weight="bold" aria-hidden="true" />
          </button>
        )}
        {impersonating ? (
          <>
            {/* K49：扮演中 —— 显示被扮演者身份 + 退出扮演；不提供再次切换入口（单层） */}
            <span className="impersonate-badge" title={`原身份：${me?.impersonatedBy?.nickname ?? ""}`}>
              扮演中：{me?.nickname}（{roleLabel}）
            </span>
            <button type="button" className="navbar-logout" onClick={() => void stopImpersonation()}>
              退出扮演
            </button>
            <button type="button" className="navbar-logout" onClick={() => void logout()}>
              退出
            </button>
          </>
        ) : (
          <>
            {canImpersonate ? (
              <div className="navbar-menu-wrap">
                <button
                  type="button"
                  className="navbar-menu-trigger"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  {me?.nickname}
                  <span className="navbar-caret" aria-hidden="true">
                    <CaretDown size={10} weight="bold" />
                  </span>
                </button>
                {menuOpen && (
                  <>
                    <div className="navbar-menu-mask" onClick={() => setMenuOpen(false)} />
                    <div className="navbar-menu">
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          setImpersonateOpen(true);
                        }}
                      >
                        切换身份（扮演用户）
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <span className="navbar-username">{me?.nickname}</span>
            )}
            <button type="button" className="navbar-logout" onClick={() => void logout()}>
              退出
            </button>
          </>
        )}
      </div>
      {impersonateOpen && <ImpersonateModal onClose={() => setImpersonateOpen(false)} />}
    </header>
  );
}
