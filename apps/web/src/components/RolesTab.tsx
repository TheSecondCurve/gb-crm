import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PAGE_GROUPS, PAGE_REGISTRY } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import { useToast } from "./Toast";

type RoleKey = "operator" | "assistant";

interface PageAccessDto {
  roles: Record<RoleKey, { allowed: string[]; enabled: string[] }>;
}

const ROLE_LABELS: Record<RoleKey, string> = { operator: "团队运营", assistant: "兼职助手" };
const ROLES: RoleKey[] = ["operator", "assistant"];

/**
 * 角色页面权限（admin only，/settings?tab=roles）。
 * 只配 operator / assistant；admin 固定全量。安全层仍由后端 can() 兜底（配置只能收缩、不能越权）。
 */
export function RolesTab() {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState<Record<RoleKey, string[]>>({
    operator: [],
    assistant: [],
  });
  const [initialized, setInitialized] = useState(false);

  const { data } = useQuery({
    queryKey: ["system", "page-access"],
    queryFn: async () => (await api.get<{ data: PageAccessDto }>("/system/page-access"))?.data,
  });

  // 首次拿到服务端 enabled 状态时初始化本地勾选（之后以本地编辑为准）
  useEffect(() => {
    if (data && !initialized) {
      setEnabled({
        operator: data.roles.operator.enabled,
        assistant: data.roles.assistant.enabled,
      });
      setInitialized(true);
    }
  }, [data, initialized]);

  const isChecked = (role: RoleKey, key: string) => enabled[role].includes(key);
  const canAllow = (role: RoleKey, key: string) => data?.roles[role]?.allowed.includes(key) ?? false;
  // H5：每个角色至少保留一个页面，否则该角色登录后无处可去（服务端 schema 同样拒绝空数组）
  const hasEmptyRole = ROLES.some((r) => enabled[r].length === 0);

  const toggle = (role: RoleKey, key: string) => {
    setEnabled((prev) => ({
      ...prev,
      [role]: prev[role].includes(key)
        ? prev[role].filter((k) => k !== key)
        : [...prev[role], key],
    }));
  };

  const save = async () => {
    try {
      await api.patch("/system/page-access", {
        roles: { operator: enabled.operator, assistant: enabled.assistant },
      });
      await queryClient.invalidateQueries({ queryKey: ["system", "page-access"] });
      showToast("已保存角色页面权限");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    }
  };

  if (!data) return null; // 首次加载中（管理页数据量小，无需占位骨架）

  return (
    <div className="settings-section">
      <div className="card">
        <div className="card-head">
          <h2>角色页面权限</h2>
        </div>
        <div className="card-body">
          <p className="role-access-hint">
            管理员固定拥有全部页面；下方仅可调整「团队运营」「兼职助手」。勾选只在该角色数据权限允许的范围内收缩，不会越权赋予。
          </p>
          {PAGE_GROUPS.map((group) => {
            const pages = PAGE_REGISTRY.filter((p) => p.menu && p.group === group).sort(
              (a, b) => a.order - b.order,
            );
            if (pages.length === 0) return null;
            return (
              <div key={group} className="role-access-group">
                <h3>{group}</h3>
                <table className="role-access-table">
                  <thead>
                    <tr>
                      <th>页面</th>
                      {ROLES.map((r) => (
                        <th key={r}>{ROLE_LABELS[r]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pages.map((p) => (
                      <tr key={p.key}>
                        <td>{p.label}</td>
                        {ROLES.map((r) => {
                          const allowed = canAllow(r, p.key);
                          return (
                            <td key={r}>
                              <input
                                type="checkbox"
                                aria-label={`${ROLE_LABELS[r]}可访问${p.label}`}
                                disabled={!allowed}
                                checked={isChecked(r, p.key)}
                                onChange={() => toggle(r, p.key)}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          <div className="modal-actions field-span">
            {hasEmptyRole && (
              <p className="role-access-hint" role="alert">
                每个角色至少需保留一个可访问页面，否则该角色登录后无处可去
              </p>
            )}
            <button
              type="button"
              className="btn-primary"
              disabled={hasEmptyRole}
              onClick={() => void save()}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
