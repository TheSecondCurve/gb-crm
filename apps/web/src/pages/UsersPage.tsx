import { useCallback, useMemo, useState, type FormEvent } from "react";
import {
  accountStatusLabels,
  can,
  employmentStatusLabels,
  jobTitleLabels,
  PASSWORD_MIN_LENGTH,
  systemRoleLabels,
} from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { UserDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { userColumns } from "../columns/users";
import { optionsOf } from "../columns/common";
import { DataGrid, Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { RecordFormModal } from "../components/RecordFormModal";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { focusEditableCell, useResourceList } from "./useResourceList";

/** 新增成员表单（仅 admin；密码最小长度见 shared PASSWORD_MIN_LENGTH） */
function CreateUserModal({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const password = String(fd.get("password") ?? "");
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`密码至少 ${PASSWORD_MIN_LENGTH} 位`);
      return;
    }
    const systemRole = String(fd.get("systemRole") ?? "");
    setError(null);
    await onSubmit({
      nickname: String(fd.get("nickname") ?? ""),
      username: String(fd.get("username") ?? ""),
      password,
      jobTitle: String(fd.get("jobTitle") ?? "other"),
      systemRole: systemRole === "" ? null : systemRole,
      employmentStatus: String(fd.get("employmentStatus") ?? "employed"),
      accountStatus: String(fd.get("accountStatus") ?? "disabled"),
    });
  };

  return (
    <Modal title="新增成员" onClose={onClose}>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <label className="field">
          昵称
          <input name="nickname" required autoComplete="off" />
        </label>
        <label className="field">
          用户名
          <input name="username" required autoComplete="off" />
        </label>
        <label className="field">
          密码（至少 {PASSWORD_MIN_LENGTH} 位）
          <input name="password" type="password" required autoComplete="new-password" />
        </label>
        <label className="field">
          角色
          <select name="jobTitle" defaultValue="other">
            {optionsOf(jobTitleLabels).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          系统角色
          <select name="systemRole" defaultValue="">
            <option value="">（不设置，不能登录）</option>
            {optionsOf(systemRoleLabels).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          在职状态
          <select name="employmentStatus" defaultValue="employed">
            {optionsOf(employmentStatusLabels).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          账户状态
          <select name="accountStatus" defaultValue="enabled">
            {optionsOf(accountStatusLabels).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            创建
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 管理员给他人设密码（密码不是表格单元格，design.md §7.8） */
function SetPasswordModal({
  user,
  busy,
  onClose,
  onSubmit,
}: {
  user: UserDto;
  busy: boolean;
  onClose: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`密码至少 ${PASSWORD_MIN_LENGTH} 位`);
      return;
    }
    setError(null);
    await onSubmit(password);
  };

  return (
    <Modal title={`设置密码：${user.nickname}`} onClose={onClose}>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <label className="field">
          新密码（至少 {PASSWORD_MIN_LENGTH} 位）
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            确认
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function UsersPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const list = useResourceList<UserDto>("users", "accountStatus");
  const columns = useMemo(() => userColumns(role), [role]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<UserDto | null>(null);
  const [deleting, setDeleting] = useState<UserDto | null>(null);
  const [busy, setBusy] = useState(false);

  // users 全部写操作仅 admin
  const canCreate = can(role, "users", "create");
  const canUpdate = can(role, "users", "update");
  const canDelete = can(role, "users", "delete");
  const canSetPassword = can(role, "users", "setPassword");

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    const res = await api.patch<{ data: UserDto }>(`/users/${id}`, body);
    return res!.data;
  }, []);

  const createUser = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await api.post<{ data: UserDto }>("/users", body);
      setCreating(false);
      await list.invalidate();
      showToast("已创建成员");
      if (res?.data) focusEditableCell(res.data.id, "nickname");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  // 修改：全字段表单弹窗，PATCH 只带变更键（OCC 由弹窗附 updatedAt）；密码走「设置密码」
  const updateUser = async (id: number, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await patchRow(id, body);
      setEditing(null);
      await list.invalidate();
      showToast("已保存");
    } catch (err) {
      showToast(
        err instanceof ApiError && err.status === 409
          ? "该行已被他人更新，请刷新后重试"
          : err instanceof ApiError
            ? err.message
            : "保存失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  };

  const setPasswordFor = async (password: string) => {
    if (!passwordTarget) return;
    setBusy(true);
    try {
      await api.post(`/users/${passwordTarget.id}/password`, { password });
      setPasswordTarget(null);
      showToast("密码已设置");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "设置失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.delete(`/users/${deleting.id}`);
      setDeleting(null);
      await list.invalidate();
      showToast("已删除");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "删除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const hasActions = canUpdate || canSetPassword || canDelete;

  return (
    <>
      <div className="page-head">
        <h1>团队成员</h1>
        <div className="search-bar">
          <SearchBar onSearch={list.changeSearch} placeholder="搜索成员…" />
          <select
            aria-label="账户状态筛选"
            value={list.filter}
            onChange={(e) => list.changeFilter(e.target.value)}
          >
            <option value="">全部状态</option>
            {optionsOf(accountStatusLabels).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {canCreate && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              新增
            </button>
          )}
        </div>
      </div>
      <div className="card">
        <div className="card-body-flush">
          <DataGrid
            ref={list.gridRef}
            gridId="users"
            columns={columns}
            rows={list.rows}
            loading={list.loading}
            queryKey={list.queryKey}
            patchRow={patchRow}
            isRowDisabled={(row) => row.accountStatus === "disabled"}
            renderRowActions={
              hasActions
                ? (row) => (
                    <span className="row-actions">
                      {canUpdate && (
                        <button type="button" onClick={() => setEditing(row)}>
                          修改
                        </button>
                      )}
                      {canSetPassword && (
                        <button type="button" onClick={() => setPasswordTarget(row)}>
                          设置密码
                        </button>
                      )}
                      {canDelete && (
                        <button type="button" className="btn-danger" onClick={() => setDeleting(row)}>
                          删除
                        </button>
                      )}
                    </span>
                  )
                : undefined
            }
          />
        </div>
        <div className="card-footer">
          <Pagination
            page={list.page}
            pageSize={list.pageSize}
            total={list.total}
            onChange={list.changePage}
          />
        </div>
      </div>
      {creating && (
        <CreateUserModal busy={busy} onClose={() => setCreating(false)} onSubmit={createUser} />
      )}
      {editing && (
        <RecordFormModal
          title={`修改成员：${editing.nickname}`}
          columns={columns}
          requiredKeys={["nickname"]}
          row={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(body) => updateUser(editing.id, body)}
        />
      )}
      {passwordTarget && (
        <SetPasswordModal
          user={passwordTarget}
          busy={busy}
          onClose={() => setPasswordTarget(null)}
          onSubmit={setPasswordFor}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除成员"
          message={`确定删除成员「${deleting.nickname}」吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
