// 幂等迁移：按迁移文件名记录在 __migrations 表，已应用的跳过，重复执行不报错。
// 迁移 SQL 以 drizzle/ 目录下手写文件为准（含 0000_init.sql，无任何 PRAGMA，见 K14）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type Database from "better-sqlite3";

import { parseScriptEnv } from "../env.js";
import { createDb } from "./client.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function migrateDb(sqlite: Database.Database): string[] {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    (sqlite.prepare("SELECT name FROM __migrations").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const nowApplied: string[] = [];
  for (const file of files) {
    const name = file.replace(/\.sql$/, "");
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare("INSERT INTO __migrations (name, applied_at) VALUES (?, ?)")
        .run(name, Date.now());
    })();
    nowApplied.push(name);
  }
  return nowApplied;
}

// CLI 入口：npm run db:migrate -w @gb-crm/api
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = parseScriptEnv();
  const { sqlite, close } = createDb(env.DATABASE_PATH);
  try {
    const applied = migrateDb(sqlite);
    console.log(
      applied.length > 0
        ? `migrated ${env.DATABASE_PATH}: ${applied.join(", ")}`
        : `migrated ${env.DATABASE_PATH}: already up to date`,
    );
  } finally {
    close();
  }
}
