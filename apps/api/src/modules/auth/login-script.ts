// 渲染 GET /agent/login.sh 与 /agent/login.ps1：把当前请求的 origin 写进脚本默认 baseUrl。
// Host 必须是合法 host[:port]，否则回退 127.0.0.1:3001，避免注入 shell。
import fs from "node:fs";

import type { FastifyRequest } from "fastify";

const PLACEHOLDER = "__GB_CRM_BASE_URL__";
const FALLBACK_BASE_URL = "http://127.0.0.1:3001";
const HOST_RE = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;
const BASE_URL_RE = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

const shTemplate = fs.readFileSync(new URL("./login.sh", import.meta.url), "utf8");
const ps1Template = fs.readFileSync(new URL("./login.ps1", import.meta.url), "utf8");

export function publicBaseUrl(req: FastifyRequest): string {
  const host = req.headers.host;
  if (typeof host !== "string" || !HOST_RE.test(host)) return FALLBACK_BASE_URL;
  const proto = req.protocol === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

export function renderLoginScript(baseUrl: string): string {
  const safe = BASE_URL_RE.test(baseUrl) ? baseUrl : FALLBACK_BASE_URL;
  return shTemplate.replaceAll(PLACEHOLDER, safe);
}

export function renderLoginScriptPs1(baseUrl: string): string {
  const safe = BASE_URL_RE.test(baseUrl) ? baseUrl : FALLBACK_BASE_URL;
  // 前置 UTF-8 BOM：PowerShell 5.1 对无 BOM 的 .ps1 默认按 ANSI(系统区域码) 读取，
  // 会把 UTF-8 中文注释读成乱码、吞掉引号导致 ParseException（`& $loginTmp` / `-File` 路径）。
  // BOM 让 PS5.1 按 UTF-8 解析；`irm | iex` 路径因 charset=utf-8 解码不受影响。
  return "\uFEFF" + ps1Template.replaceAll(PLACEHOLDER, safe);
}
