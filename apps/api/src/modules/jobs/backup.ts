// 数据库备份（db-backup 任务）：better-sqlite3 backup API 在线备份 → gzip → 落
// <数据库目录>/backups/gb-crm-<本地时间戳>.sqlite.gz（chmod 600），滚动保留最近
// BACKUP_KEEP 份（按文件名时间戳排序，超出静默删最旧）。不匹配备份命名的文件绝不动。
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

import type Database from "better-sqlite3";

import { unprocessable } from "../../plugins/error-handler.js";

/** 滚动保留份数（含本次新备份） */
export const BACKUP_KEEP = 7;

const BACKUP_FILE_RE = /^gb-crm-\d{8}-\d{6}-\d{3}\.sqlite\.gz$/;

export interface BackupResult {
  /** 备份文件绝对路径 */
  file: string;
  /** gzip 后字节数 */
  bytes: number;
  /** 保留份数 */
  kept: number;
  /** 本次滚动删除的旧备份文件名 */
  pruned: string[];
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 本地时区时间戳（生产容器 TZ=Asia/Shanghai），零填充保证字典序 = 时间序 */
function stamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`
  );
}

export async function runDbBackup(sqlite: Database.Database, now: number): Promise<BackupResult> {
  const dbPath = sqlite.name;
  if (!dbPath || dbPath === ":memory:") {
    throw unprocessable("内存数据库不支持备份");
  }

  const dir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(dir, { recursive: true });

  const base = `gb-crm-${stamp(now)}.sqlite`;
  const rawPath = path.join(dir, base);
  const gzPath = `${rawPath}.gz`;

  // 在线备份（WAL 安全）到临时未压缩文件，再流式 gzip，成功后删原始文件
  await sqlite.backup(rawPath);
  try {
    await pipeline(fs.createReadStream(rawPath), zlib.createGzip(), fs.createWriteStream(gzPath));
  } finally {
    fs.rmSync(rawPath, { force: true });
  }
  fs.chmodSync(gzPath, 0o600); // 备份含全量数据，与库文件同权

  // 滚动保留：仅碰匹配命名的 .sqlite.gz，字典序即时间序，超出 BACKUP_KEEP 删最旧
  const all = fs
    .readdirSync(dir)
    .filter((f) => BACKUP_FILE_RE.test(f))
    .sort();
  const pruned = all.slice(0, Math.max(0, all.length - BACKUP_KEEP));
  for (const name of pruned) {
    fs.rmSync(path.join(dir, name), { force: true });
  }

  return {
    file: gzPath,
    bytes: fs.statSync(gzPath).size,
    kept: all.length - pruned.length,
    pruned,
  };
}
