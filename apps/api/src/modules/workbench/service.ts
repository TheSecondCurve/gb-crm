// K61 工作台快照分发业务规则。
// 发布：tar.gz → 解包校验（tar.ts）→ 内容寻址对象逐个上传 S3（先 list 去重，未变化零上传）
//   → INSERT 版本行（manifest 只含 path/sha256/size/mode，文件体不入库）→ 滚动保留 +
//   孤儿对象 GC（保留版本引用并集之外的远端对象，尽力删除，失败不阻断发布——语义同
//   备份远端修剪 K53）。
// 读取：manifest（JSON 给 agent / TSV 给脚本）与对象下载（CRM 代理流式回包，成员机
//   只要求可达 CRM，不要求可达 S3；sha 先 list 精确前缀确认存在，区分 404 与上游故障）。
import { s3DeleteObject, s3GetObject, s3ListObjects, s3PutObject, S3Error, type S3ClientConfig } from "../../lib/s3.js";
import { notFound, s3Error, unprocessable } from "../../plugins/error-handler.js";
import type { Db } from "../../db/client.js";
import { getWorkbenchS3Config, isS3RemoteReady, type S3CredentialsValue } from "../system/repo.js";
import { parseTarGz, sha256Hex } from "./tar.js";
import {
  deleteWorkbenchVersion,
  insertWorkbenchVersion,
  latestWorkbenchVersion,
  listWorkbenchVersionMetas,
  listWorkbenchVersions,
  workbenchVersionById,
  type WorkbenchVersionRow,
} from "./repo.js";

/** 版本滚动保留份数（含最新；超出硬删 + GC 其独占对象） */
export const WORKBENCH_VERSIONS_KEEP = 10;

/** 对象 key 前缀（挂在 workbenchS3 配置的 prefix 之下） */
export const WORKBENCH_OBJECTS_DIR = "workbench/objects/";

export interface WorkbenchManifestFile {
  path: string;
  sha256: string;
  size: number;
  /** 0o755 / 0o644（tar.ts 规范化） */
  mode: number;
}

interface ManifestJson {
  v: 1;
  files: WorkbenchManifestFile[];
}

export interface WorkbenchVersionDto {
  id: number;
  commitSha: string;
  commitSubject: string | null;
  note: string | null;
  fileCount: number;
  totalBytes: number;
  publishedAt: number;
  publishedBy: number | null;
  /** 仅 detail / latest 端点携带 */
  files?: WorkbenchManifestFile[];
}

export interface PublishResult {
  version: WorkbenchVersionDto;
  /** 实际上传的对象数 */
  uploaded: number;
  /** 内容未变跳过上传的对象数 */
  skipped: number;
  /** 本次滚动删除的版本 id */
  prunedVersionIds: number[];
  /** GC 删除的远端孤儿对象数 */
  gcDeleted: number;
  /** GC 删除失败数（不阻断发布） */
  gcErrors: number;
}

function toClientConfig(cfg: S3CredentialsValue): S3ClientConfig {
  // 调用方先用 assertWorkbenchStorageReady 断言过四要素
  return {
    endpoint: cfg.endpoint!,
    region: cfg.region,
    bucket: cfg.bucket!,
    accessKeyId: cfg.accessKeyId!,
    secretAccessKey: cfg.secretAccessKey!,
  };
}

/** 发布前置：workbenchS3 已启用且四要素齐备，否则 422 */
function assertWorkbenchStorageReady(db: Db): { cfg: S3CredentialsValue; client: S3ClientConfig; objectsPrefix: string } {
  const cfg = getWorkbenchS3Config(db);
  if (!cfg || !cfg.enabled || !isS3RemoteReady(cfg)) {
    throw unprocessable("工作台对象存储未配置或未启用（系统设置 → 工作台分发）");
  }
  return {
    cfg,
    client: toClientConfig(cfg),
    objectsPrefix: `${cfg.prefix ?? ""}${WORKBENCH_OBJECTS_DIR}`,
  };
}

/** 解析已存库的 manifest（自家写入，防御性解析；损坏返回 undefined 而非抛错） */
function parseStoredManifest(json: string): ManifestJson | undefined {
  try {
    const parsed = JSON.parse(json) as { v?: unknown; files?: unknown };
    if (parsed.v !== 1 || !Array.isArray(parsed.files)) return undefined;
    const files: WorkbenchManifestFile[] = [];
    for (const f of parsed.files) {
      const o = f as Partial<WorkbenchManifestFile>;
      if (typeof o.path !== "string" || typeof o.sha256 !== "string") return undefined;
      files.push({ path: o.path, sha256: o.sha256, size: o.size ?? 0, mode: o.mode ?? 0o644 });
    }
    return { v: 1, files };
  } catch {
    return undefined;
  }
}

function manifestOf(row: WorkbenchVersionRow): ManifestJson {
  return parseStoredManifest(row.manifestJson) ?? { v: 1, files: [] };
}

function toDto(row: WorkbenchVersionRow, withFiles = false): WorkbenchVersionDto {
  const dto: WorkbenchVersionDto = {
    id: row.id,
    commitSha: row.commitSha,
    commitSubject: row.commitSubject,
    note: row.note,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
  };
  if (withFiles) dto.files = manifestOf(row).files;
  return dto;
}

function wrapS3<T>(err: unknown): T {
  if (err instanceof S3Error) throw s3Error(err.message);
  throw err;
}

export async function publishWorkbenchVersion(
  db: Db,
  opts: {
    bundle: Buffer;
    commitSha: string;
    commitSubject: string | null;
    note: string | null;
    publishedBy: number;
    now: number;
    /** S3 fetch 注入（测试 mock）；默认全局 fetch */
    fetchFn?: typeof fetch;
  },
): Promise<PublishResult> {
  const { client, objectsPrefix } = assertWorkbenchStorageReady(db);
  const fetchFn = opts.fetchFn;

  const tarEntries = parseTarGz(opts.bundle);
  const byHash = new Map<string, Buffer>();
  const files: WorkbenchManifestFile[] = tarEntries
    .map((e) => {
      const sha = sha256Hex(e.data);
      if (!byHash.has(sha)) byHash.set(sha, e.data); // 内容寻址：同内容多路径只存一份
      return { path: e.path, sha256: sha, size: e.data.length, mode: e.mode };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 去重上传：先 list 已有对象（单次请求），内容未变化的文件零上传
  let existingKeys: string[];
  try {
    existingKeys = await s3ListObjects(client, objectsPrefix, { fetchFn });
  } catch (err) {
    throw wrapS3(err);
  }
  const existingHashes = new Set(existingKeys.map((k) => k.slice(objectsPrefix.length)));

  let uploaded = 0;
  let skipped = 0;
  for (const [sha, data] of byHash) {
    if (existingHashes.has(sha)) {
      skipped += 1;
      continue;
    }
    try {
      await s3PutObject(client, `${objectsPrefix}${sha}`, data, { fetchFn });
    } catch (err) {
      throw wrapS3(err);
    }
    uploaded += 1;
  }

  const manifestJson = JSON.stringify({ v: 1, files } satisfies ManifestJson);
  const id = insertWorkbenchVersion(db, {
    commitSha: opts.commitSha,
    commitSubject: opts.commitSubject,
    note: opts.note,
    fileCount: files.length,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    manifestJson,
    publishedBy: opts.publishedBy,
    publishedAt: opts.now,
  });

  // 滚动保留：超出 KEEP 的旧版本硬删（分发日志语义，同备份滚动清理）
  const metas = listWorkbenchVersionMetas(db); // 含刚插入的最新，id 倒序
  const prunedVersionIds = metas.slice(WORKBENCH_VERSIONS_KEEP).map((m) => m.id);
  for (const vid of prunedVersionIds) deleteWorkbenchVersion(db, vid);

  // 孤儿对象 GC：保留版本引用并集之外的对象尽力删除；任一 manifest 损坏则本轮放弃 GC
  let gcDeleted = 0;
  let gcErrors = 0;
  const kept = metas.slice(0, WORKBENCH_VERSIONS_KEEP);
  const referenced = new Set<string>();
  let manifestIntact = true;
  for (const m of kept) {
    const manifest = parseStoredManifest(m.manifestJson);
    if (!manifest) {
      manifestIntact = false;
      break;
    }
    for (const f of manifest.files) referenced.add(f.sha256);
  }
  if (manifestIntact) {
    const orphans = [...existingHashes].filter((sha) => !referenced.has(sha));
    for (const sha of orphans) {
      try {
        await s3DeleteObject(client, `${objectsPrefix}${sha}`, { fetchFn });
        gcDeleted += 1;
      } catch {
        gcErrors += 1; // 尽力而为：失败不阻断发布，下轮发布会再见到它
      }
    }
  }

  const row = workbenchVersionById(db, id)!;
  return {
    version: toDto(row, true),
    uploaded,
    skipped,
    prunedVersionIds,
    gcDeleted,
    gcErrors,
  };
}

export function listWorkbenchVersionsResult(
  db: Db,
  opts: { page: number; pageSize: number },
): { data: WorkbenchVersionDto[]; meta: { page: number; pageSize: number; total: number } } {
  const { rows, total } = listWorkbenchVersions(db, opts);
  return {
    data: rows.map((r) => toDto(r)),
    meta: { page: opts.page, pageSize: opts.pageSize, total },
  };
}

export function latestWorkbenchVersionResult(db: Db): WorkbenchVersionDto | undefined {
  const row = latestWorkbenchVersion(db);
  return row ? toDto(row, true) : undefined;
}

export function workbenchVersionResult(db: Db, id: number): WorkbenchVersionDto | undefined {
  const row = workbenchVersionById(db, id);
  return row ? toDto(row, true) : undefined;
}

/** 单行文本化：制表符/换行压成空格（TSV 元数据行安全） */
function oneLine(s: string | null): string {
  return (s ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

/** manifest 渲染为脚本友好的 TSV：`#key\tvalue` 元数据行 + `sha\tsize\tmode\tpath` 数据行 */
export function renderManifestTsv(row: WorkbenchVersionRow): string {
  const files = manifestOf(row).files;
  const lines = [
    `#version\t${row.id}`,
    `#commit\t${row.commitSha}`,
    `#subject\t${oneLine(row.commitSubject)}`,
    `#note\t${oneLine(row.note)}`,
    `#published_at\t${row.publishedAt}`,
    ...files.map((f) => `${f.sha256}\t${f.size}\t${f.mode}\t${f.path}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** manifest.tsv 目标版本：显式 version 参数优先，缺省最新；无版本可发 → 404 */
export function manifestTsvTarget(db: Db, versionId: number | null): WorkbenchVersionRow {
  const row = versionId === null ? latestWorkbenchVersion(db) : workbenchVersionById(db, versionId);
  if (!row) {
    throw notFound(versionId === null ? "尚未发布任何工作台版本" : "版本不存在");
  }
  return row;
}

/** 下载对象：sha 必须是 64 位 hex（422）；远端不存在 → undefined（路由映射 404） */
export async function getWorkbenchObject(
  db: Db,
  sha: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<Buffer | undefined> {
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw unprocessable("对象哈希必须是 64 位十六进制");
  }
  const { client, objectsPrefix } = assertWorkbenchStorageReady(db);
  const key = `${objectsPrefix}${sha}`;
  try {
    const keys = await s3ListObjects(client, key, { fetchFn: opts.fetchFn });
    if (keys.length === 0) return undefined;
    const { body } = await s3GetObject(client, key, { fetchFn: opts.fetchFn });
    return body;
  } catch (err) {
    throw wrapS3(err);
  }
}
