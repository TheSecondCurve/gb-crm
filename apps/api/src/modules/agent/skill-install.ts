// K35 渠道 A：由 gb-crm 服务器下发 skill（内网可用，无需 GitHub）。
// - /agent/skill/gb-crm/install.sh 与 /agent/skill/gb-crm/install.ps1：安装器（shell / PowerShell），
//   探测 AGENT 技能目录、下载 skill 文件，最后引导用用户名/密码授权
//   （复用 /agent/login.sh / /agent/login.ps1 → PAT → ~/.gb-crm/credentials.json）。
// - /agent/skill/gb-crm/SKILL.md 与 /agent/skill/gb-crm/scripts/gb-crm.py：供安装器下载的源文件。
// 技能源目录 = 模块相对仓库根 5 层上溯到 skills/gb-crm（开发/容器一致；容器经 COPY skills ./skills）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = fileURLToPath(new URL("../../../../../skills/gb-crm", import.meta.url));

const INSTALL_SH_PATH = fileURLToPath(new URL("./install.sh", import.meta.url));
const INSTALL_PS1_PATH = fileURLToPath(new URL("./install.ps1", import.meta.url));
const INSTALL_PLACEHOLDER = "__GB_CRM_BASE_URL__";
const FALLBACK_BASE_URL = "http://127.0.0.1:3001";
const BASE_URL_RE = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

/** skill 源文件是否存在（不存在时应返回 404，而非 500） */
export function skillFileExists(rel: string): boolean {
  return fs.existsSync(path.join(SKILL_DIR, rel));
}

/** 读 skill 源文件内容（用于 /agent/skill/gb-crm/* 下发） */
export function readSkillFile(rel: string): string {
  return fs.readFileSync(path.join(SKILL_DIR, rel), "utf8");
}

/** 渲染安装器：注入安全 baseUrl（非法 Host 回退本地默认，防 shell 注入，仿 login-script） */
export function renderSkillInstallScript(baseUrl: string): string {
  const safe = BASE_URL_RE.test(baseUrl) ? baseUrl : FALLBACK_BASE_URL;
  const template = fs.readFileSync(INSTALL_SH_PATH, "utf8");
  return template.replaceAll(INSTALL_PLACEHOLDER, safe);
}

export function renderSkillInstallScriptPs1(baseUrl: string): string {
  const safe = BASE_URL_RE.test(baseUrl) ? baseUrl : FALLBACK_BASE_URL;
  const template = fs.readFileSync(INSTALL_PS1_PATH, "utf8");
  return template.replaceAll(INSTALL_PLACEHOLDER, safe);
}
