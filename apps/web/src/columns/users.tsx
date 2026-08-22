// users 列定义（docs/design.md Appendix B users：冻结 nickname；仅 admin 可编
// = users.update 仅 admin；username 创建后可写一次、表格中只读；密码不上表）。
import {
  accountStatusLabels,
  can,
  employmentStatusLabels,
  jobTitleLabels,
  systemRoleLabels,
  type SystemRole,
} from "@gb-crm/shared";

import type { UserDto } from "../api/types";
import type { GridColumn } from "../components/DataGrid/DataGrid";
import { enumBadge, formatDateTime, optionsOf, refName, type BadgeTone } from "./common";

const ACCOUNT_TONES: Record<string, BadgeTone> = {
  enabled: "accent",
  disabled: "muted",
};

/** Appendix B users 列规格；employmentStatus 只读（不在可编清单里） */
export function userColumns(role: SystemRole | null): GridColumn<UserDto>[] {
  const canEdit = can(role, "users", "update"); // 仅 admin

  return [
    { key: "nickname", label: "昵称", editor: "text", editable: canEdit },
    {
      key: "username",
      label: "用户名",
      editable: false, // 创建时写一次，之后只读（改用户名不在 v1）
      render: (row) => row.username ?? "—",
    },
    {
      key: "jobTitle",
      label: "角色",
      editor: "select",
      editable: canEdit,
      options: optionsOf(jobTitleLabels),
      render: (row) => enumBadge(jobTitleLabels)(row.jobTitle),
    },
    {
      key: "systemRole",
      label: "系统角色",
      editor: "select",
      editable: canEdit,
      options: optionsOf(systemRoleLabels),
      render: (row) => enumBadge(systemRoleLabels)(row.systemRole),
    },
    {
      key: "employmentStatus",
      label: "在职状态",
      editable: false,
      render: (row) => enumBadge(employmentStatusLabels)(row.employmentStatus),
    },
    {
      key: "accountStatus",
      label: "账户状态",
      editor: "select",
      editable: canEdit,
      options: optionsOf(accountStatusLabels),
      render: (row) => enumBadge(accountStatusLabels, ACCOUNT_TONES)(row.accountStatus),
    },
    {
      key: "updatedAt",
      label: "更新时间",
      editable: false,
      render: (row) => formatDateTime(row.updatedAt),
    },
    { key: "realName", label: "真实姓名", editor: "text", editable: canEdit },
    { key: "phone", label: "电话", editor: "text", editable: canEdit },
    { key: "wechat", label: "个人微信", editor: "text", editable: canEdit },
    { key: "duties", label: "职责描述", editor: "textarea", editable: canEdit },
    { key: "notes", label: "其他备注", editor: "textarea", editable: canEdit },
    { key: "id", label: "ID", editable: false },
    {
      key: "createdAt",
      label: "创建时间",
      editable: false,
      render: (row) => formatDateTime(row.createdAt),
    },
    {
      key: "createdBy",
      label: "创建人",
      editable: false,
      render: (row) => refName(row.createdBy),
    },
    {
      key: "updatedBy",
      label: "最后修改人",
      editable: false,
      render: (row) => refName(row.updatedBy),
    },
  ];
}
