// 认证服务（§5 / Security 认证细节）：
// - argon2id，memoryCost 65536 / timeCost 3 / parallelism 1（有测试钉住参数）；
// - 登录四项闸门全过才算成功，任一失败统一 401 INVALID_CREDENTIALS「用户名或密码错误」；
// - 用户不存在时用 dummy hash 跑一次 verify，避免计时探测用户是否存在。
import argon2 from "argon2";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";

import type { SystemRole } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { ApiError } from "../../plugins/error-handler.js";
import {
  deleteSessionsByUserId,
  findSessionById,
  restoreSessionUser,
  switchSessionUser,
} from "./session-repo.js";

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export const LOGIN_FAIL_MESSAGE = "用户名或密码错误";

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** 已登录用户身份（挂在 request.user 上） */
export interface AuthUser {
  id: number;
  username: string;
  nickname: string;
  systemRole: SystemRole;
}

let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  return (dummyHashPromise ??= argon2.hash("gb-crm-timing-dummy", ARGON2_OPTIONS));
}

async function safeVerify(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false; // 畸形 hash 视为校验失败，不暴露细节
  }
}

/**
 * 登录校验。四项闸门（§5，任一不过 → null）：
 * 1. 行存在且 deleted_at IS NULL，username/password_hash 非空；
 * 2. argon2id 校验通过；
 * 3. account_status === 'enabled'；
 * 4. system_role ∈ {admin,operator,assistant}（非 null，K23）。
 * employment_status 不参与闸门。
 */
export async function verifyLogin(
  db: Db,
  username: string,
  password: string,
): Promise<AuthUser | null> {
  const row = db
    .select()
    .from(users)
    .where(and(eq(users.username, username), isNull(users.deletedAt)))
    .get();

  // 无论行是否存在都跑一次 verify，拉平计时
  const passwordOk = await safeVerify(row?.passwordHash ?? (await dummyHash()), password);

  if (!row || row.username === null || row.passwordHash === null) return null;
  if (!passwordOk) return null;
  if (row.accountStatus !== "enabled") return null;
  if (row.systemRole === null) return null;

  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    systemRole: row.systemRole as SystemRole,
  };
}

/**
 * 改自己密码：校验 currentPassword（失败 → false，路由层抛 401）。
 * 成功后按 §5「改密：删该用户全部 session」删除该用户所有 session（含当前），
 * 客户端随后 401 重新登录。
 * @param input.now epoch 毫秒（全库统一单位）
 */
export async function changeOwnPassword(
  db: Db,
  input: { userId: number; currentPassword: string; newPassword: string; now: number },
): Promise<boolean> {
  const row = db.select().from(users).where(eq(users.id, input.userId)).get();
  if (!row || row.passwordHash === null) return false;
  if (!(await safeVerify(row.passwordHash, input.currentPassword))) return false;

  const passwordHash = await hashPassword(input.newPassword);
  db.update(users)
    .set({ passwordHash, updatedAt: input.now })
    .where(eq(users.id, row.id))
    .run();
  deleteSessionsByUserId(db, row.id);
  return true;
}

// ── K49：admin「扮演用户（act as user）」──
// 机制：改写当前 cookie session 行的 user_id 指向被扮演者，impersonated_by 记录原 admin；
// 退出时恢复。单层不可嵌套。仅 cookie session 可用（Bearer PAT 由路由层拒绝）。
// 目标闸门与 session-auth 的 loadAuthUser 一致（未软删 / enabled / systemRole 非空 / username 非空），
// 保证扮演后 session 立即可用。

export interface ImpersonationTarget {
  id: number;
  username: string | null;
  nickname: string;
  systemRole: SystemRole;
}

/** 候选目标：与 loadAuthUser 同闸门（可加载的用户），排除自己 */
export function listImpersonationTargets(
  db: Db,
  excludeUserId: number,
): ImpersonationTarget[] {
  return db
    .select({
      id: users.id,
      username: users.username,
      nickname: users.nickname,
      systemRole: users.systemRole,
    })
    .from(users)
    .where(
      and(
        isNull(users.deletedAt),
        eq(users.accountStatus, "enabled"),
        isNotNull(users.systemRole),
        isNotNull(users.username),
        ne(users.id, excludeUserId),
      ),
    )
    .all()
    .map((row) => ({ ...row, systemRole: row.systemRole as SystemRole }));
}

/** 开始扮演：目标可加载 / 非自己 / 未在扮演，任一不满足即抛错，不改库。 */
export function startImpersonation(
  db: Db,
  input: { sessionId: string; adminId: number; targetId: number; now: number },
): void {
  const session = findSessionById(db, input.sessionId);
  if (!session) throw new ApiError(404, "NOT_FOUND", "会话不存在");
  if (session.impersonatedBy !== null) {
    throw new ApiError(409, "CONFLICT", "已在扮演中，请先退出扮演");
  }
  if (session.userId === input.targetId) {
    throw new ApiError(409, "CONFLICT", "不能扮演自己");
  }
  if (findLoadableUser(db, input.targetId) === null) {
    throw new ApiError(422, "VALIDATION", "目标用户不可用（已禁用、已删除或无登录角色）");
  }
  switchSessionUser(db, input.sessionId, input.targetId, input.adminId, input.now);
}

/** 退出扮演：未在扮演 → 409。恢复 user_id = impersonated_by 并清空。 */
export function stopImpersonation(db: Db, input: { sessionId: string; now: number }): void {
  const session = findSessionById(db, input.sessionId);
  if (!session) throw new ApiError(404, "NOT_FOUND", "会话不存在");
  if (session.impersonatedBy === null) {
    throw new ApiError(409, "CONFLICT", "当前未在扮演");
  }
  restoreSessionUser(db, input.sessionId, input.now);
}

/** 与 session-auth 的 loadAuthUser 相同的可加载闸门（避免插件↔模块循环依赖，在此内联） */
function findLoadableUser(db: Db, userId: number): AuthUser | null {
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  if (
    !row ||
    row.deletedAt !== null ||
    row.accountStatus !== "enabled" ||
    row.systemRole === null ||
    row.username === null
  ) {
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    systemRole: row.systemRole as SystemRole,
  };
}

/** 当前 cookie session 的扮演发起人（原 admin）信息；未扮演 / 发起人已删 → null */
export function getSessionImpersonator(
  db: Db,
  sessionId: string,
): { id: number; nickname: string } | null {
  const session = findSessionById(db, sessionId);
  if (!session || session.impersonatedBy === null) return null;
  const row = db
    .select({ id: users.id, nickname: users.nickname })
    .from(users)
    .where(eq(users.id, session.impersonatedBy))
    .get();
  if (!row) return null;
  return { id: row.id, nickname: row.nickname };
}
