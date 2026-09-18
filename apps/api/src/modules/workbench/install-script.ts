// K61 渲染 GET /agent/workbench/install.sh 与 /agent/workbench/install.ps1：
// 把当前请求的 origin 注入脚本默认 baseUrl。Host 非法回退 127.0.0.1:3001（防 shell 注入，
// 仿 login-script / skill-install）。
import fs from "node:fs";

const PLACEHOLDER = "__GB_CRM_BASE_URL__";
const FALLBACK_BASE_URL = "http://127.0.0.1:3001";
const BASE_URL_RE = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

const template = fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const ps1Template = fs.readFileSync(new URL("./install.ps1", import.meta.url), "utf8");

export function renderWorkbenchInstallScript(baseUrl: string): string {
  const safe = BASE_URL_RE.test(baseUrl) ? baseUrl : FALLBACK_BASE_URL;
  return template.replaceAll(PLACEHOLDER, safe);
}

export function renderWorkbenchInstallScriptPs1(baseUrl: string): string {
  const safe = BASE_URL_RE.test(baseUrl) ? baseUrl : FALLBACK_BASE_URL;
  // 模板必须保持纯 ASCII：Windows PowerShell 5.1 对无 BOM 的 .ps1 按 ANSI(系统区域码) 读，
  // 有 BOM 又会让 `irm | iex` 把首行 `\uFEFF#` 当成命令名报 NotRecognized。纯 ASCII 两种执行方式都稳。
  return ps1Template.replaceAll(PLACEHOLDER, safe);
}
