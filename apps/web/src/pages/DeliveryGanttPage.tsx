// 交付单详情 → 甘特图页（项目维度交付项，K44 增强）：
// 页头 + 查询，甘特本体复用 components/DeliveryGantt（圈子工作台同样内嵌）。
import { useQuery } from "@tanstack/react-query";
import { can } from "@gb-crm/shared";
import { useNavigate, useParams } from "react-router-dom";

import { api } from "../api/client";
import type { DeliverableDto, DeliveryDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { DeliveryGantt } from "../components/DeliveryGantt";

export function DeliveryGanttPage() {
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
        <h1>甘特图 · {delivery?.name ?? delivery?.deliveryType?.name ?? `交付 #${deliveryId}`}</h1>
        <div className="search-bar">
          <button type="button" onClick={() => navigate(`/deliveries/${deliveryId}`)}>
            返回详情
          </button>
        </div>
      </div>
      <DeliveryGantt
        deliveryId={deliveryId}
        delivery={delivery}
        items={items}
        canUpdate={canUpdate}
        onItemsChanged={() => void refetch()}
      />
    </>
  );
}
