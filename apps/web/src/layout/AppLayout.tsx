import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { CommandPalette } from "../components/CommandPalette";
import { MOBILE_BREAKPOINT, useMediaQuery } from "../hooks/useMediaQuery";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";

const SIDEBAR_HIDDEN_KEY = "gb-crm:sidebar-hidden";

/**
 * 应用布局壳（K67 响应式）：
 * 桌面端侧栏折叠维持 localStorage + 负 margin；手机断点（≤767px）侧栏变遮罩抽屉，
 * 折叠按钮切换抽屉显隐、点遮罩/路由变更自动关闭，两态互不共享状态。
 */
export function AppLayout() {
  const [sidebarHidden, setSidebarHidden] = useState(
    () => localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1",
  );
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

  // 手机抽屉不跨页驻留：路由变更即收起
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const toggleSidebar = () => {
    if (isMobile) {
      setDrawerOpen((v) => !v);
      return;
    }
    setSidebarHidden((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_HIDDEN_KEY, next ? "1" : "0");
      return next;
    });
  };

  return (
    <div className="layout">
      <Sidebar
        hidden={isMobile ? false : sidebarHidden}
        drawerOpen={isMobile && drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
      />
      <div className="content">
        <Header
          onToggleSidebar={toggleSidebar}
          onOpenSearch={() => setPaletteOpen(true)}
          sidebarToggleLabel={isMobile ? "打开导航菜单" : "折叠侧栏"}
        />
        <main className="main">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
