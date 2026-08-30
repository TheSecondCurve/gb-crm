import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginSchema>;

export const PASSWORD_MIN_LENGTH = 8;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH),
});
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;

/** Agent 个人令牌范围：read = 只读 GET；write = 走现有 REST，仍受 can() 约束 */
export const tokenScopeSchema = z.enum(["read", "write"]);
export type TokenScope = z.infer<typeof tokenScopeSchema>;

export const TOKEN_NAME_MAX_LENGTH = 64;

export const mintTokenSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  scope: tokenScopeSchema,
  name: z.string().min(1).max(TOKEN_NAME_MAX_LENGTH).optional(),
});
export type MintTokenBody = z.infer<typeof mintTokenSchema>;

/** 后台「授权管理」派生视图状态：active = 未吊销且未过期；expired = 未吊销但已过期；revoked = 已吊销 */
export const tokenStatusSchema = z.enum(["active", "revoked", "expired"]);
export type TokenStatus = z.infer<typeof tokenStatusSchema>;

/** 后台列全部令牌的过滤 query（camelCase，K21）。status/scope/userId 均可选 */
export const adminTokenListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: tokenStatusSchema.optional(),
  scope: tokenScopeSchema.optional(),
  userId: z.coerce.number().int().positive().optional(),
});
export type AdminTokenListQuery = z.infer<typeof adminTokenListQuerySchema>;
