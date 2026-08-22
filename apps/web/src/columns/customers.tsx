// customers 列定义（docs/design.md Appendix B customers：冻结 nickname，assistant 的
// owner 只读 = K31 updateOwners deny）。labels 全部来自 @gb-crm/shared。
import { can, customerTypeLabels, type SystemRole } from "@gb-crm/shared";

import type { ChannelRefDto, CustomerDto, UserRefDto } from "../api/types";
import type { GridColumn } from "../components/DataGrid/DataGrid";
import {
  badge,
  enumBadge,
  formatDateTime,
  optionsOf,
  refName,
  type BadgeTone,
} from "./common";
import {
  applyRefs,
  channelLabelCache,
  channelOptionsLoader,
  idsOf,
  userLabelCache,
  userOptionsLoader,
} from "./relation";

const makeUserRef = (id: number, nickname: string): UserRefDto => ({ id, nickname });
const makeChannelRef = (id: number, name: string): ChannelRefDto => ({ id, name });

/** K45 标签徽章按 scope 上色（身份/兴趣 accent，阶段 plain，其它 muted） */
const TAG_SCOPE_TONES: Record<string, BadgeTone> = {
  identity: "accent",
  stage: "plain",
  interest: "accent",
  other: "muted",
};

/** Appendix B customers 列规格；editable 由 can(role, …) 算好 */
export function customerColumns(role: SystemRole | null): GridColumn<CustomerDto>[] {
  const canUpdate = can(role, "customers", "update");
  const canUpdateOwners = can(role, "customers", "updateOwners");

  return [
    { key: "nickname", label: "昵称", editor: "text", editable: canUpdate },
    { key: "realName", label: "真实姓名", editor: "text", editable: canUpdate },
    { key: "phone", label: "手机号", editor: "text", editable: canUpdate },
    { key: "wechat", label: "微信号", editor: "text", editable: canUpdate },
    {
      key: "customerType",
      label: "类型",
      editor: "select",
      editable: canUpdate,
      options: optionsOf(customerTypeLabels),
      render: (row) => enumBadge(customerTypeLabels)(row.customerType),
    },
    { key: "city", label: "城市", editor: "text", editable: canUpdate },
    { key: "industry", label: "行业", editor: "text", editable: canUpdate },
    {
      key: "tags",
      label: "标签",
      editable: false,
      render: (row) => (
        <span className="tag-list">
          {row.tags.map((t) => badge(t.name, TAG_SCOPE_TONES[t.scope] ?? "muted"))}
        </span>
      ),
    },
    {
      key: "owner",
      label: "归属人",
      editor: "relation-one",
      editable: canUpdateOwners, // K31：assistant 只读
      patchKey: "ownerId",
      relationLoader: userOptionsLoader,
      getValue: (row) => row.owner?.id ?? null,
      render: (row) => row.owner?.nickname ?? "—",
      applyOptimistic: (row, v) => {
        const id = typeof v === "number" ? v : null;
        return {
          ...row,
          owner:
            id === null
              ? null
              : makeUserRef(id, userLabelCache.get(id) ?? row.owner?.nickname ?? `#${id}`),
        };
      },
    },
    {
      key: "updatedAt",
      label: "更新时间",
      editable: false,
      render: (row) => formatDateTime(row.updatedAt),
    },
    { key: "title", label: "称谓", editor: "text", editable: canUpdate },
    { key: "country", label: "国家", editor: "text", editable: canUpdate },
    {
      key: "originStory",
      label: "元故事",
      editor: "textarea",
      editable: canUpdate,
    },
    { key: "notes", label: "备注", editor: "textarea", editable: canUpdate },
    {
      key: "wechatOpenid",
      label: "OpenID",
      editor: "text",
      editable: canUpdate,
    },
    {
      key: "lastFollowedAt",
      label: "最近跟进",
      editable: false,
      render: (row) => formatDateTime(row.lastFollowedAt),
    },
    {
      key: "sourceChannels",
      label: "来源渠道",
      editor: "relation",
      editable: canUpdate,
      patchKey: "sourceChannelIds",
      relationLoader: channelOptionsLoader,
      getValue: (row) => idsOf(row.sourceChannels),
      render: (row) => row.sourceChannels.map((c) => c.name).join("、"),
      applyOptimistic: (row, ids) => ({
        ...row,
        sourceChannels: applyRefs(row.sourceChannels, ids, channelLabelCache, makeChannelRef),
      }),
    },
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
