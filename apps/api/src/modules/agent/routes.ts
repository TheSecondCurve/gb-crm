// POST /api/v1/agent/sql：Agent 单一自由 SQL 端点（K35；2026-08-21 产品拍板，
// 推翻旧决定「不开放任意 SQL」）。
// - 仅 Bearer PAT（req.tokenScope !== null）；cookie session 一律 403。
// - 读写判定（H1 双条件版）：读路径必须同时满足
//   (1) stmt.readonly === true 且 (2) SQL 以 SELECT / WITH / VALUES 开头。
//   sqlite3_stmt_readonly 对 PRAGMA / BEGIN 等也返回 true，而它们能改连接级状态
//   （locking_mode / busy_timeout / foreign_keys…），会卡死备份与第二连接，
//   故任一条件不满足即落写分支（write scope + admin）。
//   注意：better-sqlite3 的 prepare() 会立即执行 PRAGMA（实测），所以非查询词形的
//   SQL 必须先过写门、再 prepare，否则 read 令牌会在「被拒绝前」已改掉连接状态。
// - 读路径凭据黑名单（M2）：结果列含 password_hash / token_hash，或 SQL 引用
//   sessions 表 → 403。渠道密钥列的产品豁免覆盖不了凭据哈希与裸 session id。
// - 单语句：prepare 抛 SqliteError（多语句/语法错误）→ 422 SQL_ERROR，message 用 sqlite 原文。
// - 读：stmt.raw() 逐行取，上限 1000 行，超出 truncated=true；rows 为数组省 token。
// - 写：包事务 stmt.run()，返回 changes / lastInsertRowid；约束冲突等 SqliteError → 422。
// 写 SQL 绕过 PATCH 内核 / OCC / 审计列，SKILL.md 已要求写时手动维护 updated_at / updated_by。
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { ApiError, forbidden } from "../../plugins/error-handler.js";
import { publicBaseUrl } from "../auth/login-script.js";
import { readSkillFile, renderSkillInstallScript, skillFileExists } from "./skill-install.js";

/** 读查询行数上限，超出截断并 truncated=true */
export const AGENT_SQL_MAX_ROWS = 1000;

const sqlBodySchema = z.object({ sql: z.string().min(1) });

// H1：只读语句的词形白名单。\b 防止 SELECTX 这类前缀误判；大小写不敏感。
const READ_ONLY_SQL_RE = /^\s*(select|with|values)\b/i;
// 非查询词形里「readonly=true 但改连接状态」的常见开头，用于给更准确的拒绝提示
const CONNECTION_STATE_RE = /^\s*(pragma|begin|savepoint)\b/i;
// M2：凭据材料黑名单——密码哈希 / PAT 哈希列，与会话表（裸 session id 即凭据）。
const CREDENTIAL_COLUMN_RE = /^(password_hash|token_hash)$/;
const SESSIONS_TABLE_RE = /\bsessions\b/i;

function toSqlError(err: unknown): ApiError {
  if (err instanceof Database.SqliteError) return new ApiError(422, "SQL_ERROR", err.message);
  throw err;
}

// prepare 阶段的抛错都与 SQL 字符串本身有关：语法/语义错误是 SqliteError，
// 多语句是 RangeError（better-sqlite3 JS 层检查），统一映射 422 SQL_ERROR。
function prepareError(err: unknown): ApiError {
  if (err instanceof Error) return new ApiError(422, "SQL_ERROR", err.message);
  throw err;
}

export interface AgentRoutesOptions {
  db: Db;
}

export function agentRoutes(app: FastifyInstance, opts: AgentRoutesOptions): void {
  // drizzle 的 $client 即 createDb 里那条 better-sqlite3 原生连接（PRAGMA 已就绪）
  const sqlite = opts.db.$client;

  app.post("/api/v1/agent/sql", async (req) => {
    if (req.tokenScope === null) {
      throw forbidden("此接口仅限 Agent 令牌（Bearer PAT）调用");
    }
    const { sql } = sqlBodySchema.parse(req.body ?? {});
    const looksLikeRead = READ_ONLY_SQL_RE.test(sql);

    // H1：词形不是 SELECT/WITH/VALUES 的 SQL 先过写门再 prepare——
    // prepare() 会立即执行 PRAGMA，鉴权放后面就拦不住了。
    if (!looksLikeRead && (req.tokenScope !== "write" || req.user!.systemRole !== "admin")) {
      throw forbidden(
        CONNECTION_STATE_RE.test(sql)
          ? "只读令牌仅允许执行 SELECT / WITH / VALUES 查询"
          : "仅管理员可执行写 SQL",
      );
    }

    let stmt: Database.Statement;
    try {
      stmt = sqlite.prepare(sql); // 多语句 / 语法错误在此抛出
    } catch (err) {
      throw prepareError(err);
    }

    if (looksLikeRead && stmt.readonly) {
      // columns() 移进 try：零列语句等场景防御性按 422 SQL_ERROR 处理
      let columns: string[];
      try {
        columns = stmt.columns().map((c) => c.name);
      } catch (err) {
        throw prepareError(err);
      }
      // M2 凭据黑名单：SELECT * FROM users 由列名兜住，sessions 表由词边界兜住
      if (columns.some((c) => CREDENTIAL_COLUMN_RE.test(c))) {
        throw forbidden("查询涉及凭据字段（password_hash / token_hash），已拒绝");
      }
      if (SESSIONS_TABLE_RE.test(sql)) {
        throw forbidden("禁止读取 sessions 表（会话凭据数据）");
      }
      const rows: unknown[][] = [];
      let truncated = false;
      try {
        for (const row of stmt.raw().iterate()) {
          if (rows.length >= AGENT_SQL_MAX_ROWS) {
            truncated = true;
            break;
          }
          rows.push(row as unknown[]);
        }
      } catch (err) {
        throw toSqlError(err);
      }
      return { data: { columns, rows, rowCount: rows.length, truncated } };
    }

    // 词形像查询但 readonly=false（如 WITH...DELETE），落到写分支；
    // 上面的前置写门只挡了非查询词形，这里仍要完整校验 scope + admin。
    if (req.tokenScope !== "write" || req.user!.systemRole !== "admin") {
      throw forbidden("仅管理员可执行写 SQL");
    }
    try {
      const info = sqlite.transaction(() => stmt.run())();
      return { data: { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) } };
    } catch (err) {
      throw toSqlError(err);
    }
  });

  // ── 渠道 A：skill 下发（K35；内网可用、无需 GitHub；/agent/* 不走 session-auth）──
  // 安装器 + 两个源文件。skill 不含密钥，端点为公开（与 /agent/login.sh 同信任面）。
  app.get("/agent/skill/gb-crm/install.sh", async (req, reply) => {
    const script = renderSkillInstallScript(publicBaseUrl(req));
    return reply
      .header("Content-Type", "text/x-shellscript; charset=utf-8")
      .header("Content-Disposition", 'inline; filename="install.sh"')
      .send(script);
  });

  app.get("/agent/skill/gb-crm/SKILL.md", async (_req, reply) => {
    if (!skillFileExists("SKILL.md")) throw new ApiError(404, "NOT_FOUND", "skill 文件缺失");
    return reply.header("Content-Type", "text/markdown; charset=utf-8").send(readSkillFile("SKILL.md"));
  });

  app.get("/agent/skill/gb-crm/scripts/gb-crm.py", async (_req, reply) => {
    if (!skillFileExists("scripts/gb-crm.py")) {
      throw new ApiError(404, "NOT_FOUND", "skill 脚本缺失");
    }
    return reply
      .header("Content-Type", "text/x-python; charset=utf-8")
      .send(readSkillFile("scripts/gb-crm.py"));
  });
}
