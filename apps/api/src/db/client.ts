// K14：PRAGMA 全部在每条连接上执行，不写进 migration。
// K29：sqlite 文件创建（或已存在）后确保 chmod 600。
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

// $client 是 drizzle() 返回类型上的原生 better-sqlite3 连接（modules/agent 用它做
// 自由 SQL 的 prepare/readonly 判定）；类类型上没有，这里显式补上——createDb 永远走真实 drizzle()。
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close: () => void;
}

export function createDb(dbPath: string): DbHandle {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");

  if (dbPath !== ":memory:") {
    fs.chmodSync(dbPath, 0o600);
  }

  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}
