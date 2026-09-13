// K61 渲染 GET /agent/workbench/install.sh：把当前请求的 origin 注入脚本默认 baseUrl。
// Host 非法回退 127.0.0.1:3001（防 shell 注入，仿 login-script / skill-install）。
import fs from "node:fs";

const PLACEHOLDER = "__GB_CRM_BASE_URL__";
const FALLBACK_BASE_URL = "http://127.0.0.1:3001";
const BASE_URL_RE = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

const template = fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8");

export function renderWorkbenchInstallScript(baseUrl: string): string {
  const safe = BASE_URL_RE.test(baseUrl) ? baseUrl : FALLBACK_BASE_URL;
  return template.replaceAll(PLACEHOLDER, safe);
}
