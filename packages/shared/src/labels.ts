import type {
  AccountStatus,
  AccountType,
  ChannelStatus,
  ChannelType,
  CustomerType,
  EmploymentStatus,
  JobTitle,
  Platform,
  ProductStatus,
  ProductType,
  SystemRole,
  Tag,
} from "./enums.js";

// code → 中文 label，全量对应 docs/design.md Appendix A.5（K11：禁止节选）。

export const jobTitleLabels: Record<JobTitle, string> = {
  ip: "IP",
  partner: "合伙人",
  ops: "运营",
  assistant: "助理",
  content: "内容",
  other: "其他",
  part_time_helper: "兼职小助手",
  intern: "实习生",
};

export const systemRoleLabels: Record<SystemRole, string> = {
  admin: "管理员",
  operator: "团队运营",
  assistant: "兼职助手",
};

export const employmentStatusLabels: Record<EmploymentStatus, string> = {
  employed: "在职",
  handing_over: "交接中",
  left: "已离职",
};

export const accountStatusLabels: Record<AccountStatus, string> = {
  enabled: "有效",
  disabled: "失效",
};

export const platformLabels: Record<Platform, string> = {
  wechat: "微信",
  weibo: "微博",
  xiaohongshu: "小红书",
  douyin: "抖音",
  xiaoyuzhou: "小宇宙",
  other: "其他",
  bilibili: "Bilibili",
  xigua: "西瓜视频",
  wechat_channels: "微信视频号",
};

export const channelTypeLabels: Record<ChannelType, string> = {
  private: "私域",
  public: "公域",
  private_assistant: "私域助手号",
  public_assistant: "公域助手号",
  fixed_wechat: "固定微信",
};

export const accountTypeLabels: Record<AccountType, string> = {
  public_account: "公域账号",
  private_assistant: "私域助手号",
  fixed_wechat: "固定微信",
  wechat_group: "微信群",
  weibo_group: "微博群",
  xhs_group: "小红书群",
};

export const channelStatusLabels: Record<ChannelStatus, string> = {
  operating: "运营中",
  paused: "暂停",
  pending: "待开通",
};

export const productTypeLabels: Record<ProductType, string> = {
  c_consulting: "C端咨询",
  b_consulting: "B端咨询",
  ad_coop: "广告合作",
  content_coop: "内容合作",
  knowledge: "知识付费",
  circle_sub: "圈子订阅",
  campaign: "运营活动",
  team_delivery: "团队交付",
};

export const productStatusLabels: Record<ProductStatus, string> = {
  on_sale: "在售",
  off_sale: "停售",
  in_dev: "开发中",
};

export const customerTypeLabels: Record<CustomerType, string> = {
  guest: "嘉宾",
  customer: "客户",
  company: "企业",
  invite: "邀请",
  partner: "合作伙伴",
};

export const tagLabels: Record<Tag, string> = {
  stage_0_1: "业务阶段 0-1",
  stage_1_10: "1-10",
  stage_10_100: "10-100",
  vip: "VIP",
  ip: "IP",
  side_hustle: "副业",
  guest: "嘉宾",
  partner: "合作伙伴",
};

function reverse<T extends string>(labels: Record<T, string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [code, label] of Object.entries(labels) as [T, string][]) {
    out[label] = code;
  }
  return out;
}

// 飞书中文 → code，导入脚本用。同一中文可能出现在多个枚举（如「IP」「嘉宾」），
// 所以反向映射必须按枚举分开，不能合并成一张全局表。

export const jobTitleFromFeishu: Record<string, JobTitle> = reverse(jobTitleLabels);
export const systemRoleFromFeishu: Record<string, SystemRole> = reverse(systemRoleLabels);
export const employmentStatusFromFeishu: Record<string, EmploymentStatus> =
  reverse(employmentStatusLabels);
export const accountStatusFromFeishu: Record<string, AccountStatus> =
  reverse(accountStatusLabels);
export const platformFromFeishu: Record<string, Platform> = reverse(platformLabels);
export const channelTypeFromFeishu: Record<string, ChannelType> = reverse(channelTypeLabels);
export const accountTypeFromFeishu: Record<string, AccountType> = reverse(accountTypeLabels);
export const channelStatusFromFeishu: Record<string, ChannelStatus> =
  reverse(channelStatusLabels);
export const productTypeFromFeishu: Record<string, ProductType> = reverse(productTypeLabels);
export const productStatusFromFeishu: Record<string, ProductStatus> =
  reverse(productStatusLabels);
export const customerTypeFromFeishu: Record<string, CustomerType> =
  reverse(customerTypeLabels);

// A.5 末尾说明：飞书原文无「业务阶段」前缀按 `1-10` / `10-100` 匹配，带前缀同样映射到 stage_*。
export const tagFromFeishu: Record<string, Tag> = {
  ...reverse(tagLabels),
  "业务阶段 1-10": "stage_1_10",
  "业务阶段 10-100": "stage_10_100",
};
