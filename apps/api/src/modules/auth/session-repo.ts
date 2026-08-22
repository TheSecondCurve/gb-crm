// sessions 表 CRUD（K5）。所有时间戳一律 epoch 毫秒（integer，对齐 Data Model 的 epoch ms UTC）。
// created_at = 登录时刻（7d 绝对上限锚点）；expires_at = idle 12h 截止；last_touched_at = 上次 touch。
import { randomBytes } from "node:crypto";

import { eq, lt, or } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { sessions } from "../../db/schema.js";

export const SESSION_IDLE_TTL_MS = 12 * 60 * 60 * 1000; // idle 12h（cookie maxAge 按其秒数对齐）
export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 绝对上限 7d
export const SESSION_TOUCH_INTERVAL_MS = 30 * 60 * 1000; // touch 节流：30min 内不重复写
export const SESSION_TOUCH_REMAINING_MS = 11 * 60 * 60 * 1000; // 剩余 idle < 11h 也触发 touch

export type Session = typeof sessions.$inferSelect;

/** 创建 session：id = 32 字节 CSPRNG hex（64 字符） */
export function createSession(
  db: Db,
  input: { userId: number; now: number; ip?: string | undefined; userAgent?: string | undefined },
): Session {
  const row: Session = {
    id: randomBytes(32).toString("hex"),
    userId: input.userId,
    impersonatedBy: null,
    createdAt: input.now,
    expiresAt: input.now + SESSION_IDLE_TTL_MS,
    lastTouchedAt: input.now,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  };
  db.insert(sessions).values(row).run();
  return row;
}

export function findSessionById(db: Db, id: string): Session | undefined {
  return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

export function deleteSessionById(db: Db, id: string): void {
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

/** 禁用账户 / 改密 / reset：删该用户全部 session */
export function deleteSessionsByUserId(db: Db, userId: number): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

/**
 * K49：开始扮演 —— 当前 cookie session 的身份切到目标用户，
 * impersonated_by 记录原身份（admin），退出时恢复。单层不可嵌套（调用方校验）。
 */
export function switchSessionUser(
  db: Db,
  sessionId: string,
  userId: number,
  impersonatedBy: number,
  now: number,
): void {
  db.update(sessions)
    .set({ userId, impersonatedBy, lastTouchedAt: now })
    .where(eq(sessions.id, sessionId))
    .run();
}

/** K49：退出扮演 —— user_id 恢复为 impersonated_by（原 admin），清空 impersonated_by。 */
export function restoreSessionUser(db: Db, sessionId: string, now: number): void {
  db.update(sessions)
    .set({ userId: sessions.impersonatedBy, impersonatedBy: null, lastTouchedAt: now })
    .where(eq(sessions.id, sessionId))
    .run();
}

/** GC：删过期（idle 到期）或超绝对上限的 session；login 时必做，其它请求 1% 概率做（K29） */
export function gcSessions(db: Db, now: number): void {
  db.delete(sessions)
    .where(
      or(
        lt(sessions.expiresAt, now),
        lt(sessions.createdAt, now - SESSION_ABSOLUTE_TTL_MS),
      ),
    )
    .run();
}
