// channels 列定义（docs/design.md Appendix B channels：冻结 name；K27 密钥列
// assistant 显示「—」且不可编）。
import {
  accountTypeLabels,
  can,
  channelStatusLabels,
  channelTypeLabels,
  platformLabels,
  type SystemRole,
} from "@gb-crm/shared";

import type { ChannelDto, UserRefDto } from "../api/types";
import type { GridColumn } from "../components/DataGrid/DataGrid";
import { enumBadge, formatDateTime, optionsOf, refName, type BadgeTone } from "./common";
import {
  applyRefs,
  idsOf,
  userLabelCache,
  userOptionsLoader,
} from "./relation";

const STATUS_TONES: Record<string, BadgeTone> = {
  operating: "accent",
  paused: "muted",
};

const makeUserRef = (id: number, nickname: string): UserRefDto => ({ id, nickname });

/** Appendix B channels 列规格 */
export function channelColumns(role: SystemRole | null): GridColumn<ChannelDto>[] {
  const canUpdate = can(role, "channels", "update");
  const canReadSecrets = can(role, "channels", "readChannelSecrets");
  const canEditSecrets = can(role, "channels", "updateChannelSecrets");

  // 密钥列（K27）：assistant GET 已为 null，展示「—」、不可编
  const secret = (key: string, label: string): GridColumn<ChannelDto> => ({
    key,
    label,
    editor: "text",
    editable: canEditSecrets,
    render: (row) => {
      if (!canReadSecrets) return "—";
      const v = row[key as keyof ChannelDto];
      return typeof v === "string" ? v : "";
    },
  });

  return [
    { key: "name", label: "渠道名称", editor: "text", editable: canUpdate },
    {
      key: "platform",
      label: "平台",
      editor: "select",
      editable: canUpdate,
      options: optionsOf(platformLabels),
      render: (row) => enumBadge(platformLabels)(row.platform),
    },
    {
      key: "channelType",
      label: "渠道类型",
      editor: "select",
      editable: canUpdate,
      options: optionsOf(channelTypeLabels),
      render: (row) => enumBadge(channelTypeLabels)(row.channelType),
    },
    {
      key: "status",
      label: "状态",
      editor: "select",
      editable: canUpdate,
      options: optionsOf(channelStatusLabels),
      render: (row) => enumBadge(channelStatusLabels, STATUS_TONES)(row.status),
    },
    {
      key: "owners",
      label: "负责人",
      editor: "relation",
      editable: canUpdate,
      patchKey: "ownerIds",
      relationLoader: userOptionsLoader,
      getValue: (row) => idsOf(row.owners),
      render: (row) => row.owners.map((o) => o.nickname).join("、"),
      applyOptimistic: (row, ids) => ({
        ...row,
        owners: applyRefs(row.owners, ids, userLabelCache, makeUserRef),
      }),
    },
    {
      key: "followerCount",
      label: "粉丝/好友数",
      editor: "text",
      editable: canUpdate,
      getValue: (row) => (row.followerCount === null ? "" : String(row.followerCount)),
      // 文本编辑 → number | null（空 = null）
      applyOptimistic: (row, v) => {
        const s = String(v ?? "").trim();
        return { ...row, followerCount: s === "" ? null : Number(s) };
      },
    },
    {
      key: "updatedAt",
      label: "更新时间",
      editable: false,
      render: (row) => formatDateTime(row.updatedAt),
    },
    {
      key: "accountType",
      label: "账号类型",
      editor: "select",
      editable: canUpdate,
      options: optionsOf(accountTypeLabels),
      render: (row) => enumBadge(accountTypeLabels)(row.accountType),
    },
    {
      key: "description",
      label: "渠道说明",
      editor: "textarea",
      editable: canUpdate,
    },
    { key: "notes", label: "备注", editor: "textarea", editable: canUpdate },
    secret("accountId", "账号ID"),
    secret("registerPhone", "注册手机号"),
    secret("registrant", "注册人"),
    secret("realNamePerson", "实名认证人"),
    secret("loginDevice", "登录设备"),
    { key: "id", label: "ID", editable: false },
    { key: "feishuRecordId", label: "飞书记录", editable: false },
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
