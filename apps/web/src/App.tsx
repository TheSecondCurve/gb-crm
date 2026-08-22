import { Navigate, Route, Routes } from "react-router-dom";

import { useAuth } from "./auth/AuthProvider";
import { AppLayout } from "./layout/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { CustomersPage } from "./pages/CustomersPage";
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
import { DeliveryTypesPage } from "./pages/DeliveryTypesPage";

/** 未登录访问受保护页 → /login；等待 /auth/me 时显示占位 */
function RequireAuth() {
  const { me, isLoading } = useAuth();
  if (isLoading) return <div className="page-loading">加载中…</div>;
  if (!me) return <Navigate to="/login" replace />;
  return <AppLayout />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Navigate to="/customers" replace />} />
        <Route path="/my/customers" element={<MyCustomersPage />} />
        <Route path="/my/deals" element={<MyDealsPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/channels" element={<ChannelsPage />} />
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/deals" element={<DealsPage />} />
        <Route path="/deliveries" element={<DeliveriesPage />} />
        <Route path="/deliveries/:id" element={<DeliveryDetailPage />} />
        <Route path="/deliveries/:id/gantt" element={<DeliveryGanttPage />} />
        <Route path="/deliveries/:id/matrix" element={<DeliveryMatrixPage />} />
        <Route path="/delivery-types" element={<DeliveryTypesPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="*" element={<Navigate to="/customers" replace />} />
      </Route>
    </Routes>
  );
}
