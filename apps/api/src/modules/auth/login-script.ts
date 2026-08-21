// 渲染 GET /agent/login.sh：把当前请求的 origin 写进脚本默认 baseUrl。
// Host 必须是合法 host[:port]，否则回退 127.0.0.1:3001，避免注入 shell。
import fs from "node:fs";

import type { FastifyRequest } from "fastify";

const PLACEHOLDER = "__GB_CRM_BASE_URL__";
const FALLBACK_BASE_URL = "http://127.0.0.1:3001";
const HOST_RE = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;
const BASE_URL_RE = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

const template = fs.readFileSync(new URL("./login.sh", import.meta.url), "utf8");

export function publicBaseUrl(req: FastifyRequest): string {
  const host = req.headers.host;
  if (typeof host !== "string" || !HOST_RE.test(host)) return FALLBACK_BASE_URL;
  const proto = req.protocol === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

export function renderLoginScript(baseUrl: string): string {
  const safe = BASE_URL_RE.test(baseUrl) ? baseUrl : FALLBACK_BASE_URL;
  return template.replaceAll(PLACEHOLDER, safe);
}
