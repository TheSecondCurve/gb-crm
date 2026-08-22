// customers 列定义（docs/design.md Appendix B customers：冻结 nickname，assistant 的
// owners 只读 = K31 updateOwners deny）。labels 全部来自 @gb-crm/shared。
import { can, customerTypeLabels, tagLabels, type SystemRole } from "@gb-crm/shared";

import type { ChannelRefDto, CustomerDto, UserRefDto } from "../api/types";
import type { GridColumn } from "../components/DataGrid/DataGrid";
import { enumBadge, formatDateTime, optionsOf, refName, tagBadges } from "./common";
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
    {
      key: "tagCodes",
      label: "标签",
      editor: "multi",
      editable: canUpdate,
      options: optionsOf(tagLabels),
      render: (row) => tagBadges(row.tagCodes),
    },
    { key: "city", label: "城市", editor: "text", editable: canUpdate },
    {
      key: "owners",
      label: "归属人",
      editor: "relation",
      editable: canUpdateOwners, // K31：assistant 只读
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
      key: "wechatChannelsAccount",
      label: "视频号账号",
      editor: "text",
      editable: canUpdate,
    },
    {
      key: "xiaoyuzhouAccount",
      label: "小宇宙账号",
      editor: "text",
      editable: canUpdate,
    },
    {
      key: "xiaohongshuAccount",
      label: "小红书账号",
      editor: "text",
      editable: canUpdate,
    },
    {
      key: "weiboAccount",
      label: "微博账号",
      editor: "text",
      editable: canUpdate,
    },
    {
      key: "douyinAccount",
      label: "抖音账号",
      editor: "text",
      editable: canUpdate,
    },
    {
      key: "otherSocial",
      label: "其他社交账号",
      editor: "text",
      editable: canUpdate,
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
