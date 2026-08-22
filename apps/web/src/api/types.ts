// API DTO 类型（与 apps/api/src/modules/*/assemble.ts 的输出一一对应；K21 camelCase）。
// GET list 项 = GET one = PATCH/POST 响应（含 expansions）；passwordHash / deletedAt 永不出现在 JSON。

export interface UserRefDto {
  id: number;
  nickname: string;
}

export interface ChannelRefDto {
  id: number;
  name: string;
}

export interface CustomerDto {
  id: number;
  nickname: string;
  realName: string | null;
  title: string | null;
  phone: string | null;
  wechat: string | null;
  country: string | null;
  city: string | null;
  originStory: string | null;
  notes: string | null;
  customerType: string;
  wechatOpenid: string | null;
  lastFollowedAt: number | null;
  socialAccounts: { platform: string; account: string }[];
  owner: UserRefDto | null;
  sourceChannels: ChannelRefDto[];
  createdAt: number;
  updatedAt: number;
  createdBy: UserRefDto | null;
  updatedBy: UserRefDto | null;
}

export interface ChannelDto {
  id: number;
  name: string;
  description: string | null;
  /** 以下五个为密钥字段（K27）：assistant GET 时为 null，前端展示「—」 */
  accountId: string | null;
  registerPhone: string | null;
  registrant: string | null;
  realNamePerson: string | null;
  loginDevice: string | null;
  notes: string | null;
  platform: string;
  channelType: string;
  accountType: string;
  status: string;
  followerCount: number | null;
  owners: UserRefDto[];
  createdAt: number;
  updatedAt: number;
  createdBy: UserRefDto | null;
  updatedBy: UserRefDto | null;
}

export interface ProductDto {
  id: number;
  name: string;
  notes: string | null;
  sopUrl: string | null;
  packageIncludes: string | null;
  deliveryCycle: string | null;
  productType: string;
  isPackage: boolean;
  status: string;
  /** K13：integer 分；null = 未定价。UI 展示/编辑元 */
  priceCents: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRefDto | null;
  updatedBy: UserRefDto | null;
}

/** deals 客户 ref（K42：带 city 供「客户城市」只读列） */
export interface DealCustomerRefDto {
  id: number;
  nickname: string;
  city: string | null;
}

export interface DealProductRefDto {
  id: number;
  name: string;
}

export interface DealDto {
  id: number;
  customerId: number;
  productId: number | null;
  ownerId: number | null;
  stage: string;
  orderNo: string | null;
  paymentRemark: string | null;
  /** epoch ms UTC；null = 未填。UI 展示/编辑 YYYY-MM-DD */
  deliveryDate: number | null;
  customer: DealCustomerRefDto | null;
  product: DealProductRefDto | null;
  owner: UserRefDto | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRefDto | null;
  updatedBy: UserRefDto | null;
}

/** 交付类型配置（K44） */
export interface DeliveryTypeDto {
  id: number;
  name: string;
  description: string | null;
  /** 多行文本，每行一个默认动作；创建交付项时预填模板 */
  defaultTasks: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRefDto | null;
  updatedBy: UserRefDto | null;
}

/** 交付单（K44：类型 + 客户集合 + 备注） */
export interface DeliveryDto {
  id: number;
  deliveryTypeId: number;
  deliveryType: { id: number; name: string } | null;
  customers: { id: number; nickname: string }[];
  remark: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRefDto | null;
  updatedBy: UserRefDto | null;
}

/** 动作打勾清单项（K44：客户维度任务携带 customer） */
export interface DeliveryTaskDto {
  id: number;
  customer: { id: number; nickname: string } | null;
  content: string;
  done: boolean;
  doneAt: number | null;
  doneBy: UserRefDto | null;
  remark: string | null;
  updatedAt: number;
}

/** 交付项（K44：项目维度 / 客户维度；无独立状态，打勾进度即状态） */
export interface DeliverableDto {
  id: number;
  deliveryId: number;
  content: string;
  dimension: string;
  description: string | null;
  deliveryUrl: string | null;
  tasks: DeliveryTaskDto[];
  createdAt: number;
  updatedAt: number;
  createdBy: UserRefDto | null;
  updatedBy: UserRefDto | null;
}

export interface UserDto {
  id: number;
  username: string | null;
  nickname: string;
  realName: string | null;
  phone: string | null;
  wechat: string | null;
  jobTitle: string;
  systemRole: string | null;
  employmentStatus: string;
  accountStatus: string;
  duties: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRefDto | null;
  updatedBy: UserRefDto | null;
}
