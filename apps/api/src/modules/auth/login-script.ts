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
  // 模板必须保持纯 ASCII：Windows PowerShell 5.1 对无 BOM 的 .ps1 按 ANSI(系统区域码) 读，
  // 有 BOM 又会让 `irm | iex` 把首行 `\uFEFF#` 当成命令名报 NotRecognized。纯 ASCII 两种执行方式都稳。
  return ps1Template.replaceAll(PLACEHOLDER, safe);
}
