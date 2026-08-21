import { useState } from "react";
import { Outlet } from "react-router-dom";

import { Header } from "./Header";
import { Sidebar } from "./Sidebar";

const SIDEBAR_HIDDEN_KEY = "gb-crm:sidebar-hidden";

export function AppLayout() {
  const [sidebarHidden, setSidebarHidden] = useState(
    () => localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1",
  );

  const toggleSidebar = () => {
    setSidebarHidden((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_HIDDEN_KEY, next ? "1" : "0");
      return next;
    });
  };

  return (
    <div className="layout">
      <Sidebar hidden={sidebarHidden} />
      <div className="content">
        <Header onToggleSidebar={toggleSidebar} />
        <main className="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
