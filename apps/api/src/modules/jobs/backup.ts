// 数据库备份（db-backup 任务）：better-sqlite3 backup API 在线备份 → gzip → 落
// <数据库目录>/backups/gb-crm-<本地时间戳>.sqlite.gz（chmod 600），滚动保留最近
// BACKUP_KEEP 份（按文件名时间戳排序，超出静默删最旧）。不匹配备份命名的文件绝不动。
// K53：若 system_configs code='s3' 启用且配置完整，另上传一份到远端固定对象
// （覆盖式单对象，不留多份）；上传失败不回滚本地备份，由调用方降级为 partial。
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

import type Database from "better-sqlite3";

import type { Db } from "../../db/client.js";
import { S3Error, s3PutObject } from "../../lib/s3.js";
import { unprocessable } from "../../plugins/error-handler.js";
import { getS3Config, isS3RemoteReady } from "../system/repo.js";

/** 滚动保留份数（含本次新备份） */
export const BACKUP_KEEP = 7;

/** 远端固定对象名（覆盖式，不留多份，K53） */
export const REMOTE_BACKUP_KEY = "gb-crm-latest.sqlite.gz";

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

/** K53 远程上传结果（remote=null 表示未启用/配置不完整跳过） */
export interface RemoteUploadOutcome {
  ok: boolean;
  bucket: string;
  key: string;
  bytes?: number;
  error?: string;
}

export interface DbBackupJobResult extends BackupResult {
  remote: RemoteUploadOutcome | null;
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

/**
 * K53：本地备份文件上传远端（启用且四要素齐备才执行；固定单对象覆盖式）。
 * 失败不抛（返回 ok=false），由调用方决定任务终态——本地备份成功不该被远端故障抹掉。
 */
export async function uploadBackupToS3(
  db: Db,
  file: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<RemoteUploadOutcome | null> {
  const cfg = getS3Config(db);
  if (!cfg || !cfg.enabled || !isS3RemoteReady(cfg)) return null;

  const key = `${cfg.prefix ?? ""}${REMOTE_BACKUP_KEY}`;
  const bucket = cfg.bucket!;
  try {
    const body = fs.readFileSync(file);
    await s3PutObject(
      {
        endpoint: cfg.endpoint!,
        region: cfg.region,
        bucket,
        accessKeyId: cfg.accessKeyId!,
        secretAccessKey: cfg.secretAccessKey!,
      },
      key,
      body,
      { fetchFn: opts.fetchFn },
    );
    return { ok: true, bucket, key, bytes: body.length };
  } catch (err) {
    return {
      ok: false,
      bucket,
      key,
      error: err instanceof S3Error ? err.message : String(err),
    };
  }
}
