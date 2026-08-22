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
