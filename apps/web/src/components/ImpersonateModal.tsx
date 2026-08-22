import { useQuery } from "@tanstack/react-query";
import { systemRoleLabels, type SystemRole } from "@gb-crm/shared";

import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { Modal } from "./Modal";

/** GET /api/v1/auth/impersonate/targets 的单个候选 */
interface Target {
  id: number;
  username: string | null;
  nickname: string;
  systemRole: SystemRole;
}

/** K49：admin 选择要扮演的用户。点击即扮演（可随时在右上角退出，无需二次确认）。 */
export function ImpersonateModal({ onClose }: { onClose: () => void }) {
  const { impersonate } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["auth", "impersonate", "targets"],
    queryFn: () => api.get<{ data: Target[] }>("/auth/impersonate/targets"),
    staleTime: 30_000,
  });

  const targets = data?.data ?? [];

  return (
    <Modal title="切换身份（扮演用户）" onClose={onClose} wide>
      <p className="page-tip">
        以所选用户身份操作，用于测试「我的运营」等按人过滤的页面；右上角可随时退出扮演。
      </p>
      {isLoading ? (
        <div className="empty">加载中…</div>
      ) : targets.length === 0 ? (
        <div className="empty">暂无其他可扮演用户</div>
      ) : (
        <div className="impersonate-list">
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              className="impersonate-option"
              onClick={() => {
                void impersonate(t.id).then(onClose);
              }}
            >
              <span className="impersonate-name">{t.nickname}</span>
              <span className="impersonate-meta">
                {t.username ?? ""} · {systemRoleLabels[t.systemRole]}
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
