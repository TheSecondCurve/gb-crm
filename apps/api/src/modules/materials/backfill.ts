// K63 存量回填：老 kind=file 资料行没有 checksum/宽高（升级 0034 前上传的）。
// 后台任务 material-file-meta-backfill：扫 live file 行中 checksum 或图片宽高缺失者，
// 从 materialsS3 拉对象 → sha256 + image-meta 解析 → 回写；params.enrich=true 时顺带给
// 未识别过的图片调度 AI 识别（LLM 未配置仍会 skipped，不影响元数据回填）。
// 手动一次性任务，管理员在「后台任务」创建执行；未配置资料存储 → 422。
import { and, eq, isNull, isNotNull, or } from "drizzle-orm";

import { createHash } from "node:crypto";

import { MATERIAL_FILE_KIND } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { deliveryMaterials } from "../../db/schema.js";
import { S3Error, s3GetObject, type S3ClientConfig } from "../../lib/s3.js";
import { unprocessable } from "../../plugins/error-handler.js";
import { getMaterialsS3Config, isS3RemoteReady } from "../system/repo.js";
import { scheduleMaterialEnrich } from "./enrich.js";
import { isPreviewableImage } from "./file-meta.js";
import { parseImageDimensions } from "./image-meta.js";

export interface MaterialBackfillResult {
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  enrichEnqueued: number;
}

/** 需要回填的行：checksum 缺失，或（图片疑似且宽高缺失——非图片宽高本就该是 NULL） */
function listBackfillRows(db: Db) {
  return db
    .select()
    .from(deliveryMaterials)
    .where(
      and(
        eq(deliveryMaterials.kind, MATERIAL_FILE_KIND),
        isNull(deliveryMaterials.deletedAt),
        or(
          isNull(deliveryMaterials.checksum),
          and(
            isNull(deliveryMaterials.imageWidth),
            isNotNull(deliveryMaterials.originalFilename),
          ),
        ),
      ),
    )
    .all();
}

export async function runMaterialMetaBackfillJob(
  db: Db,
  params: { enrich?: boolean },
  audit: { now: number; userId: number | null },
  opts: { fetchFn?: typeof fetch; isCancelled?: () => boolean } = {},
): Promise<MaterialBackfillResult> {
  const cfg = getMaterialsS3Config(db);
  if (!cfg?.enabled || !isS3RemoteReady(cfg)) {
    throw unprocessable("请先在系统设置中启用并保存资料存储配置");
  }
  const client: S3ClientConfig = {
    endpoint: cfg.endpoint!,
    region: cfg.region,
    bucket: cfg.bucket!,
    accessKeyId: cfg.accessKeyId!,
    secretAccessKey: cfg.secretAccessKey!,
  };

  const rows = listBackfillRows(db);
  const result: MaterialBackfillResult = {
    total: rows.length,
    updated: 0,
    skipped: 0,
    failed: 0,
    enrichEnqueued: 0,
  };
  for (const row of rows) {
    if (opts.isCancelled?.()) break;
    try {
      const got = await s3GetObject(client, row.objectKey!, {
        fetchFn: opts.fetchFn,
        timeoutMs: 60_000,
      });
      const body = Buffer.isBuffer(got.body) ? got.body : Buffer.from(got.body);
      const dims = isPreviewableImage(row.contentType, row.originalFilename)
        ? parseImageDimensions(body)
        : null;
      // 只补缺：已有值（并发或部分回填过的）不动
      const checksum = row.checksum ?? checksumOf(body);
      const imageWidth = row.imageWidth ?? dims?.width ?? null;
      const imageHeight = row.imageHeight ?? dims?.height ?? null;
      db.update(deliveryMaterials)
        .set({
          checksum,
          imageWidth,
          imageHeight,
          updatedAt: audit.now,
          updatedBy: audit.userId,
        })
        .where(eq(deliveryMaterials.id, row.id))
        .run();
      result.updated += 1;
      if (params.enrich && row.aiStatus == null && isPreviewableImage(row.contentType, row.originalFilename)) {
        const scheduled = scheduleMaterialEnrich(
          db,
          { ...row, checksum, imageWidth, imageHeight },
          audit,
        );
        if (scheduled === "pending") result.enrichEnqueued += 1;
      }
    } catch (err) {
      if (err instanceof S3Error) {
        result.failed += 1;
        continue;
      }
      throw err;
    }
  }
  return result;
}

function checksumOf(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
