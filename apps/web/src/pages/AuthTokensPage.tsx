// 授权管理（K35 后台治理，系统菜单 /tokens，仅 admin）：查看全部 Agent PAT 令牌、
// 用户、权限（scope）、状态；可吊销任意令牌；吊销历史（revokedAt/revokedBy）可查。
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { tokenScopeLabels, type ListEnvelope } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { ApiTokenAdminDto, UserDto } from "../api/types";
import { badge, formatDateTime, type BadgeTone } from "../columns/common";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";

const STATUS_LABELS: Record<string, string> = {
  active: "有效",
  revoked: "已吊销",
  expired: "已过期",
};

const STATUS_TONES: Record<string, BadgeTone> = {
  active: "accent",
  revoked: "muted",
  expired: "danger",
};

const SCOPE_TONES: Record<string, BadgeTone> = {
  read: "plain",
  write: "accent",
};

export function AuthTokensPage() {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [userIdFilter, setUserIdFilter] = useState("");
  const [revoking, setRevoking] = useState<ApiTokenAdminDto | null>(null);
  const [busy, setBusy] = useState(false);

  // 用户下拉（仅 admin）：用于按用户过滤令牌
  const { data: users } = useQuery({
    queryKey: ["users", "all-token-filter"],
    queryFn: async () =>
      (await api.get<ListEnvelope<UserDto>>("/users?pageSize=100")) ?? {
        data: [],
        meta: { page: 1, pageSize: 100, total: 0 },
      },
  });

  const { data } = useQuery({
    queryKey: ["auth", "tokens-admin", statusFilter, scopeFilter, userIdFilter],
    queryFn: async () =>
      (await api.get<ListEnvelope<ApiTokenAdminDto>>(
        `/auth/tokens/admin?pageSize=100${statusFilter ? `&status=${statusFilter}` : ""}${
          scopeFilter ? `&scope=${scopeFilter}` : ""
        }${userIdFilter ? `&userId=${userIdFilter}` : ""}`,
      )) ?? { data: [], meta: { page: 1, pageSize: 100, total: 0 } },
  });

  const tokens = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const revoke = async (token: ApiTokenAdminDto) => {
    setBusy(true);
    try {
      await api.delete(`/auth/tokens/admin/${token.id}`);
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: ["auth", "tokens-admin"] });
      showToast("已吊销令牌");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "吊销失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <div className="page-head">
        <h1>授权管理</h1>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Agent 令牌（{total}）</h2>
          <div className="filters">
            <select
              aria-label="令牌状态筛选"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">全部状态</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="令牌范围筛选"
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value)}
            >
              <option value="">全部范围</option>
              {Object.entries(tokenScopeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="按用户筛选"
              value={userIdFilter}
              onChange={(e) => setUserIdFilter(e.target.value)}
            >
              <option value="">全部用户</option>
              {(users?.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nickname}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="card-body-flush">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>用户</th>
                <th>授权</th>
                <th>权限</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>过期时间</th>
                <th>最近使用</th>
                <th>吊销人</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {tokens.length === 0 && (
                <tr>
                  <td colSpan={10} className="task-empty">
                    本次筛选无令牌
                  </td>
                </tr>
              )}
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td>#{token.id}</td>
                  <td>{token.user.nickname}</td>
                  <td>
                    <code>{token.prefix}</code>
                    {token.name ? (
                      <span className="token-name" title={token.name}>
                        {token.name}
                      </span>
                    ) : null}
                  </td>
                  <td>{badge(tokenScopeLabels[token.scope] ?? token.scope, SCOPE_TONES[token.scope] ?? "plain")}</td>
                  <td>{badge(STATUS_LABELS[token.status] ?? token.status, STATUS_TONES[token.status] ?? "muted")}</td>
                  <td>{formatDateTime(token.createdAt)}</td>
                  <td>{formatDateTime(token.expiresAt) || "—"}</td>
                  <td>{formatDateTime(token.lastUsedAt) || "—"}</td>
                  <td>
                    {token.revokedBy?.nickname ??
                      (token.revokedAt !== null ? "系统" : "—")}
                  </td>
                  <td className="row-actions">
                    {token.revokedAt === null && (
                      <button type="button" className="btn-danger" onClick={() => setRevoking(token)}>
                        吊销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {revoking && (
        <ConfirmDialog
          title="吊销令牌"
          message={`确定吊销「${revoking.user.nickname}」的令牌 ${revoking.prefix} 吗？吊销后该令牌立即失效，且不可恢复。`}
          confirmText="确认吊销"
          loading={busy}
          onConfirm={() => void revoke(revoking)}
          onCancel={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
