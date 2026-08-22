import { z } from "zod";

// 枚举与 docs/design.md Appendix A.5 一一对应（全量，禁止节选）。
// 库内存英文 code；中文 label 见 labels.ts。

export const jobTitleSchema = z.enum([
  "ip",
  "partner",
  "ops",
  "assistant",
  "content",
  "other",
  "part_time_helper",
  "intern",
]);
export type JobTitle = z.infer<typeof jobTitleSchema>;

export const systemRoleSchema = z.enum(["admin", "operator", "assistant"]);
export type SystemRole = z.infer<typeof systemRoleSchema>;

export const employmentStatusSchema = z.enum(["employed", "handing_over", "left"]);
export type EmploymentStatus = z.infer<typeof employmentStatusSchema>;

export const accountStatusSchema = z.enum(["enabled", "disabled"]);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const platformSchema = z.enum([
  "wechat",
  "weibo",
  "xiaohongshu",
  "douyin",
  "xiaoyuzhou",
  "other",
  "bilibili",
  "xigua",
  "wechat_channels",
]);
export type Platform = z.infer<typeof platformSchema>;

export const channelTypeSchema = z.enum([
  "private",
  "public",
  "private_assistant",
  "public_assistant",
  "fixed_wechat",
]);
export type ChannelType = z.infer<typeof channelTypeSchema>;

export const accountTypeSchema = z.enum([
  "public_account",
  "private_assistant",
  "fixed_wechat",
  "wechat_group",
  "weibo_group",
  "xhs_group",
]);
export type AccountType = z.infer<typeof accountTypeSchema>;

export const channelStatusSchema = z.enum(["operating", "paused", "pending"]);
export type ChannelStatus = z.infer<typeof channelStatusSchema>;

export const productTypeSchema = z.enum([
  "c_consulting",
  "b_consulting",
  "ad_coop",
  "content_coop",
  "knowledge",
  "circle_sub",
  "campaign",
  "team_delivery",
]);
export type ProductType = z.infer<typeof productTypeSchema>;

export const productStatusSchema = z.enum(["on_sale", "off_sale", "in_dev"]);
export type ProductStatus = z.infer<typeof productStatusSchema>;

export const customerTypeSchema = z.enum([
  "guest",
  "customer",
  "company",
  "invite",
  "partner",
]);
export type CustomerType = z.infer<typeof customerTypeSchema>;

/** 客户社交媒体平台（K41，沿用原 customers 表 6 个账号字段的类型） */
export const socialPlatformSchema = z.enum([
  "wechat_channels",
  "xiaoyuzhou",
  "xiaohongshu",
  "weibo",
  "douyin",
  "other",
]);
export type SocialPlatform = z.infer<typeof socialPlatformSchema>;

/** 成交阶段（K42，对照飞书成交表「阶段」下拉，默认 gift 赠送） */
export const dealStageSchema = z.enum(["gift", "paid", "refunded", "closed"]);
export type DealStage = z.infer<typeof dealStageSchema>;

/** 交付项状态（K43，对照飞书「用户权益明细表」状态下拉） */
export const deliverableStatusSchema = z.enum([
  "pending",
  "delivering",
  "delivered",
  "cancelled",
]);
export type DeliverableStatus = z.infer<typeof deliverableStatusSchema>;
