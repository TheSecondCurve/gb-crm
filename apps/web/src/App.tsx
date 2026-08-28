import { Navigate, Route, Routes } from "react-router-dom";

import { useAuth } from "./auth/AuthProvider";
import { AppLayout } from "./layout/AppLayout";
import { homePath, NoPagesPlaceholder, PageGuard } from "./components/PageGuard";
import { LoginPage } from "./pages/LoginPage";
import { CustomersPage } from "./pages/CustomersPage";
import { CustomerOverviewPage } from "./pages/CustomerOverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { BusinessSettingsPage } from "./pages/BusinessSettingsPage";
import { ChannelsPage } from "./pages/ChannelsPage";
import { ProductsPage } from "./pages/ProductsPage";
import { UsersPage } from "./pages/UsersPage";
import { MyCustomersPage } from "./pages/MyCustomersPage";
import { MyDealsPage } from "./pages/MyDealsPage";
import { DealsPage } from "./pages/DealsPage";
import { DeliveriesPage } from "./pages/DeliveriesPage";
import { DeliveryDetailPage } from "./pages/DeliveryDetailPage";
import { DeliveryGanttPage } from "./pages/DeliveryGanttPage";
import { DeliveryMatrixPage } from "./pages/DeliveryMatrixPage";
import { DeliveryCirclePage } from "./pages/DeliveryCirclePage";
import { DeliveryTypesPage } from "./pages/DeliveryTypesPage";
import { MaterialsPage } from "./pages/MaterialsPage";

/** 未登录访问受保护页 → /login；等待 /auth/me 时显示占位 */
function RequireAuth() {
  const { me, isLoading } = useAuth();
  if (isLoading) return <div className="page-loading">加载中…</div>;
  if (!me) return <Navigate to="/login" replace />;
  return <AppLayout />;
}

/** 落地页：homePath 统一推导（customers 优先，否则第一张可看菜单页）；pages 为空 → 占位兜底 */
function HomeRedirect() {
  const { me } = useAuth();
  const target = homePath(me?.pages ?? []);
  if (target === null) return <NoPagesPlaceholder />;
  return <Navigate to={target} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<HomeRedirect />} />
        <Route
          path="/my/customers"
          element={
            <PageGuard pageKey="my-customers">
              <MyCustomersPage />
            </PageGuard>
          }
        />
        <Route
          path="/my/deals"
          element={
            <PageGuard pageKey="my-deals">
              <MyDealsPage />
            </PageGuard>
          }
        />
        <Route
          path="/customers"
          element={
            <PageGuard pageKey="customers">
              <CustomersPage />
            </PageGuard>
          }
        />
        <Route
          path="/customers/:id"
          element={
            <PageGuard pageKey="customer-overview">
              <CustomerOverviewPage />
            </PageGuard>
          }
        />
        <Route
          path="/settings"
          element={
            <PageGuard pageKey="settings">
              <SettingsPage />
            </PageGuard>
          }
        />
        <Route
          path="/business-settings"
          element={
            <PageGuard pageKey="business-settings">
              <BusinessSettingsPage />
            </PageGuard>
          }
        />
        <Route
          path="/channels"
          element={
            <PageGuard pageKey="channels">
              <ChannelsPage />
            </PageGuard>
          }
        />
        <Route
          path="/products"
          element={
            <PageGuard pageKey="products">
              <ProductsPage />
            </PageGuard>
          }
        />
        <Route
          path="/deals"
          element={
            <PageGuard pageKey="deals">
              <DealsPage />
            </PageGuard>
          }
        />
        <Route
          path="/deliveries"
          element={
            <PageGuard pageKey="deliveries">
              <DeliveriesPage />
            </PageGuard>
          }
        />
        <Route
          path="/deliveries/:id"
          element={
            <PageGuard pageKey="delivery-detail">
              <DeliveryDetailPage />
            </PageGuard>
          }
        />
        <Route
          path="/deliveries/:id/circle"
          element={
            <PageGuard pageKey="delivery-circle">
              <DeliveryCirclePage />
            </PageGuard>
          }
        />
        <Route
          path="/deliveries/:id/gantt"
          element={
            <PageGuard pageKey="delivery-gantt">
              <DeliveryGanttPage />
            </PageGuard>
          }
        />
        <Route
          path="/deliveries/:id/matrix"
          element={
            <PageGuard pageKey="delivery-matrix">
              <DeliveryMatrixPage />
            </PageGuard>
          }
        />
        <Route
          path="/materials"
          element={
            <PageGuard pageKey="materials">
              <MaterialsPage />
            </PageGuard>
          }
        />
        <Route
          path="/delivery-types"
          element={
            <PageGuard pageKey="delivery-types">
              <DeliveryTypesPage />
            </PageGuard>
          }
        />
        <Route
          path="/users"
          element={
            <PageGuard pageKey="users">
              <UsersPage />
            </PageGuard>
          }
        />
        <Route path="*" element={<HomeRedirect />} />
      </Route>
    </Routes>
  );
}
