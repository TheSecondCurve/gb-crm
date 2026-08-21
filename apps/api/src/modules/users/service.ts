// users 业务规则（§3 service 层）：
// - 创建：argon2id hash 密码（hashFn 可注入，测试提速）；live 用户名唯一冲突 → 409；
// - PATCH 内核（K24）：键存在才 SET（null → SET NULL 可空列；非空列由 Zod 挡 422）；
//   username 创建后不可改（PATCH 含 username → 422，「改用户名不在 v1」）；
//   updatedAt 必带做行级 OCC：changes===0 → 软删 404，否则 409 且 data 带当前完整行；
//   accountStatus 置 disabled 时删该用户全部 session（§5「禁用账户：删全部 session」）
//   并撤销其 agent 令牌；
// - setPassword：管理员给他人设密码，删该用户全部 session（令牌保留）；
// - 删除 = 软删并删其 sessions、撤销其令牌。
import { PASSWORD_MIN_LENGTH, userWriteSchema } from "@gb-crm/shared";
import type { UserListQuery, UserPatch } from "@gb-crm/shared";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { conflict, notFound, unprocessable } from "../../plugins/error-handler.js";
import { hashPassword } from "../auth/service.js";
import { deleteSessionsByUserId } from "../auth/session-repo.js";
import { revokeAllTokensByUserId } from "../auth/token-repo.js";
import { assembleUser, assembleUsers, type UserDto } from "./assemble.js";
import {
  findLiveByUsername,
  getUserByIdAny,
  insertUser,
  listUsers,
  occUpdateUser,
  softDeleteUser,
  updatePasswordHash,
} from "./repo.js";

export type HashFn = (password: string) => Promise<string>;

export interface UsersServiceOptions {
  /** 密码 hash 函数（默认生产 argon2id 参数；测试可注入降参数版本提速） */
  hashFn?: HashFn;
}

// 创建 body：userWriteSchema + 可写 password（不设则 passwordHash=NULL，该成员不可登录）。
// 定义在 service 而非 routes，供 routes 做输入校验、service 拿到 zod 推导类型。
export const userCreateSchema = userWriteSchema.extend({
  password: z.string().min(PASSWORD_MIN_LENGTH).nullable().optional(),
});
export type UserCreateBody = z.infer<typeof userCreateSchema>;

export function listUsersResult(
  db: Db,
  query: UserListQuery,
): { data: UserDto[]; total: number } {
  const { rows, total } = listUsers(db, query);
  return { data: assembleUsers(db, rows), total };
}

export function getUserResult(db: Db, id: number): UserDto {
  const row = getUserByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("用户不存在");
  return assembleUser(db, row);
}

export async function createUser(
  db: Db,
  body: UserCreateBody,
  ctx: AuditContext,
  opts: UsersServiceOptions = {},
): Promise<UserDto> {
  const hashFn = opts.hashFn ?? hashPassword;
  const { password, ...fields } = body;
  if (fields.username != null && findLiveByUsername(db, fields.username)) {
    throw conflict("用户名已被占用");
  }
  const passwordHash =
    password !== undefined && password !== null ? await hashFn(password) : null;
  const id = insertUser(db, { ...fields, passwordHash, ...createAudit(ctx) });
  return assembleUser(db, getUserByIdAny(db, id)!);
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证不是数据列；username 单独拒绝） */
const PATCHABLE_KEYS = new Set([
  "nickname",
  "realName",
  "phone",
  "wechat",
  "jobTitle",
  "systemRole",
  "employmentStatus",
  "accountStatus",
  "duties",
  "notes",
]);

export function patchUser(db: Db, id: number, patch: UserPatch, ctx: AuditContext): UserDto {
  // 「改用户名不在 v1」：PATCH 带 username 键（含 null）一律 422，写清而不是静默忽略
  if ("username" in patch && patch.username !== undefined) {
    throw unprocessable("用户名创建后不可修改", [{ path: "username", message: "改用户名不在 v1" }]);
  }

  // 键存在才 SET；缺席键不动（K24）。非空列传 null 已被 Zod 挡在 422。
  const set: Record<string, unknown> = { ...updateAudit(ctx) };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "updatedAt" || value === undefined) continue;
    if (!PATCHABLE_KEYS.has(key)) continue;
    set[key] = value;
  }

  const changes = occUpdateUser(db, id, patch.updatedAt, set);
  if (changes === 0) {
    const row = getUserByIdAny(db, id);
    if (!row || row.deletedAt !== null) throw notFound("用户不存在");
    throw conflict("数据已被他人修改，请刷新后重试", assembleUser(db, row));
  }

  // 禁用账户：删该用户全部 session（§5），并撤销 agent 令牌
  if (patch.accountStatus === "disabled") {
    deleteSessionsByUserId(db, id);
    revokeAllTokensByUserId(db, id, ctx.now);
  }

  return assembleUser(db, getUserByIdAny(db, id)!);
}

export async function setUserPassword(
  db: Db,
  id: number,
  password: string,
  ctx: AuditContext,
  opts: UsersServiceOptions = {},
): Promise<void> {
  const hashFn = opts.hashFn ?? hashPassword;
  const row = getUserByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("用户不存在");
  const passwordHash = await hashFn(password);
  // 设密码不算业务字段编辑冲突面，直接按 id 更新 + bump 审计列
  updatePasswordHash(db, id, passwordHash, updateAudit(ctx));
  deleteSessionsByUserId(db, id);
}

export function deleteUser(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteUser(db, id, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("用户不存在");
  deleteSessionsByUserId(db, id);
  revokeAllTokensByUserId(db, id, ctx.now);
}
