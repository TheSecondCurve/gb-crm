// 数据库备份（db-backup 任务）：better-sqlite3 backup API 在线备份 → gzip → 落
// <数据库目录>/backups/gb-crm-<本地时间戳>.sqlite.gz（chmod 600），滚动保留最近
// BACKUP_KEEP 份（按文件名时间戳排序，超出静默删最旧）。不匹配备份命名的文件绝不动。
// K53：若 system_configs code='s3' 启用且配置完整，另上传到远端：时间戳版本
// {prefix}gb-crm-<时间戳>.sqlite.gz（滚动保留 keep 份）+ 覆盖式 {prefix}gb-crm-latest.sqlite.gz；
// 上传失败不回滚本地备份，由调用方降级为 partial。
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

import type Database from "better-sqlite3";

import type { Db } from "../../db/client.js";
import { S3Error, s3DeleteObject, s3ListObjects, s3PutObject } from "../../lib/s3.js";
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
  /** 时间戳版本 key（与 latest 同内容） */
  timestampedKey?: string;
  bytes?: number;
  error?: string;
  /** 远端滚动修剪信息 */
  pruned?: string[];
  kept?: number;
  keep?: number;
  pruneError?: string;
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
 * K53：本地备份文件上传远端（启用且四要素齐备才执行；时间戳版本滚动 N 份 + latest 覆盖式）。
 * 失败不抛（返回 ok=false），由调用方决定任务终态——本地备份成功不该被远端故障抹掉。
 * 远端修剪失败不视为上传失败（仅记录 pruneError），避免因清理失败把已成功的上传标为 partial。
 */
export async function uploadBackupToS3(
  db: Db,
  file: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<RemoteUploadOutcome | null> {
  const cfg = getS3Config(db);
  if (!cfg || !cfg.enabled || !isS3RemoteReady(cfg)) return null;

  const prefix = cfg.prefix ?? "";
  const latestKey = `${prefix}${REMOTE_BACKUP_KEY}`;
  const timestampedKey = `${prefix}${path.basename(file)}`;
  const bucket = cfg.bucket!;
  const keep = cfg.keep ?? 7;
  const clientConfig = {
    endpoint: cfg.endpoint!,
    region: cfg.region,
    bucket,
    accessKeyId: cfg.accessKeyId!,
    secretAccessKey: cfg.secretAccessKey!,
  };

  try {
    const body = fs.readFileSync(file);
    // 先上传时间戳版本，再覆盖 latest（两者同内容）
    await s3PutObject(clientConfig, timestampedKey, body, { fetchFn: opts.fetchFn });
    await s3PutObject(clientConfig, latestKey, body, { fetchFn: opts.fetchFn });

    // 远端滚动修剪：列出前缀下所有时间戳备份，超出 keep 删除最旧
    let pruned: string[] = [];
    let kept: number | undefined;
    let pruneError: string | undefined;
    try {
      const allKeys = await s3ListObjects(clientConfig, prefix, { fetchFn: opts.fetchFn });
      const candidates = allKeys
        .filter((k) => {
          if (!k.startsWith(prefix)) return false;
          const base = k.slice(prefix.length);
          return BACKUP_FILE_RE.test(base);
        })
        .sort();
      const toPrune = candidates.slice(0, Math.max(0, candidates.length - keep));
      const succeeded: string[] = [];
      for (const k of toPrune) {
        try {
          await s3DeleteObject(clientConfig, k, { fetchFn: opts.fetchFn });
          succeeded.push(k);
        } catch (e) {
          pruneError = e instanceof S3Error ? e.message : String(e);
          break;
        }
      }
      pruned = succeeded;
      kept = candidates.length - succeeded.length;
      // 若因强一致窗口未列出新文件，kept 可能为 0，此时修正为 1
      if (candidates.length === 0) kept = 1;
      if (pruneError && toPrune.length > succeeded.length) {
        // 有未删完的，按实际保留数
        kept = candidates.length - succeeded.length;
      }
    } catch (e) {
      pruneError = e instanceof S3Error ? e.message : String(e);
    }

    return {
      ok: true,
      bucket,
      key: latestKey,
      timestampedKey,
      bytes: body.length,
      pruned,
      kept,
      keep,
      ...(pruneError ? { pruneError } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      bucket,
      key: latestKey,
      timestampedKey,
      keep,
      error: err instanceof S3Error ? err.message : String(err),
    };
  }
}
