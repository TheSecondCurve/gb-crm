// POST /api/v1/agent/sql：Agent 单一自由 SQL 端点（K35；2026-08-21 产品拍板，
// 推翻旧决定「不开放任意 SQL」）。
// - 仅 Bearer PAT（req.tokenScope !== null）；cookie session 一律 403。
// - 读写判定用 better-sqlite3 原生 prepare 后的 stmt.readonly：
//   SELECT/WITH/PRAGMA 等 readonly=true → 任意 scope、任意角色放行（含渠道密钥列，产品接受）；
//   readonly=false（含 INSERT...RETURNING）→ 必须 write scope + systemRole=admin。
// - 单语句：prepare 抛 SqliteError（多语句/语法错误）→ 422 SQL_ERROR，message 用 sqlite 原文。
// - 读：stmt.raw() 逐行取，上限 1000 行，超出 truncated=true；rows 为数组省 token。
// - 写：包事务 stmt.run()，返回 changes / lastInsertRowid；约束冲突等 SqliteError → 422。
// 写 SQL 绕过 PATCH 内核 / OCC / 审计列，SKILL.md 已要求写时手动维护 updated_at / updated_by。
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { ApiError, forbidden } from "../../plugins/error-handler.js";

/** 读查询行数上限，超出截断并 truncated=true */
export const AGENT_SQL_MAX_ROWS = 1000;

const sqlBodySchema = z.object({ sql: z.string().min(1) });

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

    let stmt: Database.Statement;
    try {
      stmt = sqlite.prepare(sql); // 多语句 / 语法错误在此抛出
    } catch (err) {
      throw prepareError(err);
    }

    if (stmt.readonly) {
      const columns = stmt.columns().map((c) => c.name);
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
}
