import type {
  AccountStatus,
  AccountType,
  ChannelStatus,
  ChannelType,
  CustomerType,
  DealStage,
  DeliverableDimension,
  DeliveryTypeKind,
  DeliveryTypeStatus,
  EmploymentStatus,
  JobTitle,
  MaintenanceKind,
  MaterialKind,
  Platform,
  ProductStatus,
  ProductType,
  SocialPlatform,
  SystemRole,
  TagScope,
} from "./enums.js";
import type { TokenScope } from "./schemas/auth.js";

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

export const socialPlatformLabels: Record<SocialPlatform, string> = {
  wechat_channels: "视频号",
  xiaoyuzhou: "小宇宙",
  xiaohongshu: "小红书",
  weibo: "微博",
  douyin: "抖音",
  other: "其他",
};

export const dealStageLabels: Record<DealStage, string> = {
  gift: "赠送",
  paid: "已付款",
  refunded: "退款",
  closed: "已关闭",
};

export const deliverableDimensionLabels: Record<DeliverableDimension, string> = {
  project: "项目",
  customer: "客户",
};

export const deliveryTypeKindLabels: Record<DeliveryTypeKind, string> = {
  consulting: "咨询类",
  activity: "活动类",
  circle: "圈子类",
  other: "其他类",
};

export const deliveryTypeStatusLabels: Record<DeliveryTypeStatus, string> = {
  active: "有效",
  inactive: "失效",
};

export const tagScopeLabels: Record<TagScope, string> = {
  identity: "身份",
  stage: "阶段",
  interest: "兴趣",
  other: "其它",
};

export const materialKindLabels: Record<MaterialKind, string> = {
  transcript: "录音文字稿",
  text: "文本资料",
  audio: "音频",
  video: "视频",
  link: "其他链接",
};

export const maintenanceKindLabels: Record<MaintenanceKind, string> = {
  follow_up: "跟进联系",
  status_change: "状态变化",
  lead: "线索意向",
  note: "一般备注",
  other: "其他",
};

/** Agent PAT 令牌范围（K35）：read = 只读；write = 走 REST，仍受 can() 约束 */
export const tokenScopeLabels: Record<TokenScope, string> = {
  read: "只读",
  write: "读写",
};
