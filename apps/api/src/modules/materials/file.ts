// K57 资料对象存储：kind=file 的上传/替换/读取/尽力删除。
// 远端配置走 system_configs code='materialsS3'；文件体量上限 MATERIAL_FILE_MAX_BYTES。
import { randomUUID } from "node:crypto";

import { MATERIAL_FILE_KIND, MATERIAL_FILE_MAX_BYTES } from "@gb-crm/shared";

import type { AuditContext } from "../../lib/audit.js";
import { createAudit, updateAudit } from "../../lib/audit.js";
import { S3Error, s3DeleteObject, s3GetObject, s3PutObject, type S3ClientConfig } from "../../lib/s3.js";
import { conflict, notFound, s3Error, unprocessable } from "../../plugins/error-handler.js";
import type { Db } from "../../db/client.js";
import { getDeliveryById } from "../deliveries/repo.js";
import {
  getMaterialsS3Config,
  isS3RemoteReady,
  type S3CredentialsValue,
} from "../system/repo.js";
import { assembleMaterialDetail, type MaterialDetailDto } from "./assemble.js";
import { isPreviewableImage } from "./file-meta.js";
import {
  findLiveCustomerIds,
  getMaterialByIdAny,
  insertMaterial,
  occUpdateMaterial,
  replaceMaterialCustomers,
  type MaterialRow,
} from "./repo.js";

export const MATERIAL_FILE_BODY_LIMIT = MATERIAL_FILE_MAX_BYTES + 1024 * 1024;

export interface UploadedFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

function fileExtension(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const m = base.match(/(\.[A-Za-z0-9]{1,10})$/);
  return m ? m[1]!.toLowerCase() : "";
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = [...base].filter((c) => c.charCodeAt(0) >= 32).join("").trim();
  return cleaned.slice(0, 200) || "file";
}

function toClientConfig(cfg: S3CredentialsValue): S3ClientConfig {
  return {
    endpoint: cfg.endpoint!,
    region: cfg.region,
    bucket: cfg.bucket!,
    accessKeyId: cfg.accessKeyId!,
    secretAccessKey: cfg.secretAccessKey!,
  };
}

export function assertMaterialsStorageReady(db: Db): S3CredentialsValue {
  const cfg = getMaterialsS3Config(db);
  if (!cfg?.enabled || !isS3RemoteReady(cfg)) {
    throw unprocessable("请先在系统设置中启用并保存资料存储配置");
  }
  return cfg;
}

function objectKeyFor(cfg: S3CredentialsValue, filename: string): string {
  const prefix = cfg.prefix ?? "";
  const ext = fileExtension(filename);
  return `${prefix}materials/${randomUUID()}${ext}`;
}

function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

function assertLiveDelivery(db: Db, deliveryId: number | null | undefined): void {
  if (deliveryId == null) return;
  if (!getDeliveryById(db, deliveryId)) {
    throw unprocessable("交付单不存在或已删除", [
      { path: "deliveryId", message: `无效交付单 id: ${deliveryId}` },
    ]);
  }
}

function assertLiveCustomers(db: Db, customerIds: number[] | undefined): void {
  if (customerIds === undefined) return;
  const unique = [...new Set(customerIds)];
  if (unique.length === 0) return;
  const live = findLiveCustomerIds(db, unique);
  const missing = unique.filter((id) => !live.has(id));
  if (missing.length > 0) {
    throw unprocessable("客户不存在或已删除", [
      { path: "customerIds", message: `无效客户 id: ${missing.join(",")}` },
    ]);
  }
}

async function putFile(
  cfg: S3CredentialsValue,
  key: string,
  file: UploadedFile,
  fetchFn?: typeof fetch,
): Promise<void> {
  try {
    await s3PutObject(toClientConfig(cfg), key, file.buffer, {
      fetchFn,
      contentType: file.contentType || "application/octet-stream",
      timeoutMs: 60_000,
    });
  } catch (err) {
    if (err instanceof S3Error) throw s3Error(err.message);
    throw err;
  }
}

async function deleteObjectBestEffort(
  cfg: S3CredentialsValue | undefined,
  key: string | null,
  fetchFn?: typeof fetch,
): Promise<void> {
  if (!cfg || !key || !isS3RemoteReady(cfg)) return;
  try {
    await s3DeleteObject(toClientConfig(cfg), key, { fetchFn, timeoutMs: 15_000 });
  } catch {
    // 软删已经落库；远端尽力删除，失败不回滚
  }
}

function assertFileSize(file: UploadedFile): void {
  if (file.buffer.length === 0) {
    throw unprocessable("请选择要上传的文件");
  }
  if (file.buffer.length > MATERIAL_FILE_MAX_BYTES) {
    throw unprocessable("文件不能超过 32MB");
  }
}

export async function uploadMaterialFile(
  db: Db,
  meta: { title: string; deliveryId?: number | null; customerIds?: number[] },
  file: UploadedFile,
  ctx: AuditContext,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<MaterialDetailDto> {
  assertFileSize(file);
  const cfg = assertMaterialsStorageReady(db);
  assertLiveDelivery(db, meta.deliveryId);
  assertLiveCustomers(db, meta.customerIds);

  const filename = sanitizeFilename(file.filename);
  const key = objectKeyFor(cfg, filename);
  await putFile(cfg, key, file, opts.fetchFn);

  try {
    return inTx(db, (tx) => {
      const id = insertMaterial(tx, {
        kind: MATERIAL_FILE_KIND,
        title: meta.title,
        deliveryId: meta.deliveryId ?? null,
        objectKey: key,
        contentType: file.contentType || "application/octet-stream",
        fileSize: file.buffer.length,
        originalFilename: filename,
        url: null,
        content: null,
        ...createAudit(ctx),
      });
      if (meta.customerIds !== undefined) replaceMaterialCustomers(tx, id, meta.customerIds);
      return assembleMaterialDetail(tx, getMaterialByIdAny(tx, id)!);
    });
  } catch (err) {
    await deleteObjectBestEffort(cfg, key, opts.fetchFn);
    throw err;
  }
}

export async function replaceMaterialFile(
  db: Db,
  id: number,
  file: UploadedFile,
  expectedUpdatedAt: number,
  ctx: AuditContext,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<MaterialDetailDto> {
  assertFileSize(file);
  const existing = getMaterialByIdAny(db, id);
  if (!existing || existing.deletedAt !== null) throw notFound("资料不存在");
  if (existing.kind !== MATERIAL_FILE_KIND) {
    throw unprocessable("只有对象存储类型的资料可以替换文件");
  }
  const cfg = assertMaterialsStorageReady(db);
  const filename = sanitizeFilename(file.filename);
  const key = objectKeyFor(cfg, filename);
  await putFile(cfg, key, file, opts.fetchFn);

  const set = {
    objectKey: key,
    contentType: file.contentType || "application/octet-stream",
    fileSize: file.buffer.length,
    originalFilename: filename,
    ...updateAudit(ctx),
  };
  const changes = occUpdateMaterial(db, id, expectedUpdatedAt, set);
  if (changes === 0) {
    await deleteObjectBestEffort(cfg, key, opts.fetchFn);
    const again = getMaterialByIdAny(db, id);
    if (!again || again.deletedAt !== null) throw notFound("资料不存在");
    throw conflict("数据已被他人修改，请刷新后重试", assembleMaterialDetail(db, again));
  }
  await deleteObjectBestEffort(cfg, existing.objectKey, opts.fetchFn);
  return assembleMaterialDetail(db, getMaterialByIdAny(db, id)!);
}

export async function readMaterialFile(
  db: Db,
  id: number,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<{ body: Buffer; contentType: string; filename: string; isImage: boolean }> {
  const row = getMaterialByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("资料不存在");
  if (row.kind !== MATERIAL_FILE_KIND || !row.objectKey) {
    throw unprocessable("该资料没有对象存储文件");
  }
  const cfg = assertMaterialsStorageReady(db);
  try {
    const got = await s3GetObject(toClientConfig(cfg), row.objectKey, {
      fetchFn: opts.fetchFn,
      timeoutMs: 60_000,
    });
    const filename = row.originalFilename || "file";
    const contentType = row.contentType || got.contentType || "application/octet-stream";
    return {
      body: got.body,
      contentType,
      filename,
      isImage: isPreviewableImage(contentType, filename),
    };
  } catch (err) {
    if (err instanceof S3Error) throw s3Error(err.message);
    throw err;
  }
}

export async function deleteStoredObjectIfAny(
  db: Db,
  row: MaterialRow,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<void> {
  if (row.kind !== MATERIAL_FILE_KIND || !row.objectKey) return;
  await deleteObjectBestEffort(getMaterialsS3Config(db), row.objectKey, opts.fetchFn);
}

export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_") || "file";
  const encoded = encodeURIComponent(filename);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
