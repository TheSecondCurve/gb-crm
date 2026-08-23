// 交付单详情 → 状态矩阵页（客户维度交付项，K44 增强）。
// 薄壳：拉取交付单 + 交付项，矩阵核心在 components/DeliveryMatrix（圈子工作台弹窗复用）。
import { useQuery } from "@tanstack/react-query";
import { can } from "@gb-crm/shared";
import { useNavigate, useParams } from "react-router-dom";

import { api } from "../api/client";
import type { DeliverableDto, DeliveryDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { DeliveryMatrix } from "../components/DeliveryMatrix";

export function DeliveryMatrixPage() {
  const { id } = useParams();
  const deliveryId = Number(id);
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const navigate = useNavigate();
  const canUpdate = can(role, "deliveries", "update");

  const { data: delivery } = useQuery({
    queryKey: ["deliveries", deliveryId],
    queryFn: async () => (await api.get<{ data: DeliveryDto }>(`/deliveries/${deliveryId}`))?.data,
  });
  const { data: items, refetch } = useQuery({
    queryKey: ["deliveries", deliveryId, "items"],
    queryFn: async () =>
      (await api.get<{ data: DeliverableDto[] }>(`/deliveries/${deliveryId}/items`))?.data ?? [],
  });

  return (
    <>
      <div className="page-head">
        <h1>状态矩阵 · {delivery?.deliveryType?.name ?? `交付 #${deliveryId}`}</h1>
        <div className="search-bar">
          <button type="button" onClick={() => navigate(`/deliveries/${deliveryId}`)}>
            返回详情
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-body-flush">
          <DeliveryMatrix
            deliveryId={deliveryId}
            customers={delivery?.customers ?? []}
            items={items}
            canUpdate={canUpdate}
            onChanged={() => void refetch()}
          />
        </div>
      </div>
    </>
  );
}
