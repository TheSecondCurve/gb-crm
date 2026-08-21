// 签名 cookie 插件（K5）：secret = SESSION_SECRET（HMAC 密钥，appEnv 强制 ≥32 字符）。
// session cookie 名 gb_crm_sid，值为 @fastify/cookie 签名后的 sessions.id；未签名 raw id 一律 401。
import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply } from "fastify";

export const SESSION_COOKIE_NAME = "gb_crm_sid";

/** 注册签名 cookie（root scope；@fastify/cookie 自带 fastify-plugin，decorator 全局可见） */
export function registerCookie(app: FastifyInstance, secret: string): void {
  void app.register(fastifyCookie, { secret });
}

export interface SessionCookieOptions {
  secure: boolean;
  /** cookie 规范单位是秒；由剩余 idle 毫秒换算而来（DB 内时间戳一律 epoch 毫秒） */
  maxAgeSeconds: number;
}

export function setSessionCookie(
  reply: FastifyReply,
  sessionId: string,
  options: SessionCookieOptions,
): void {
  reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
    signed: true,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: options.secure,
    maxAge: options.maxAgeSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}
