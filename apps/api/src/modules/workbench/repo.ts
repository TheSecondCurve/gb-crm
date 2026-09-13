// K61 workbench_versions 表访问：版本为不可变记录，只有插入 / 查询 / 滚动硬删。
import { desc, eq } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { workbenchVersions } from "../../db/schema.js";

export interface WorkbenchVersionRow {
  id: number;
  commitSha: string;
  commitSubject: string | null;
  note: string | null;
  fileCount: number;
  totalBytes: number;
  manifestJson: string;
  publishedBy: number | null;
  publishedAt: number;
}

export interface WorkbenchVersionMeta {
  id: number;
  manifestJson: string;
}

export function insertWorkbenchVersion(
  db: Db,
  values: {
    commitSha: string;
    commitSubject: string | null;
    note: string | null;
    fileCount: number;
    totalBytes: number;
    manifestJson: string;
    publishedBy: number;
    publishedAt: number;
  },
): number {
  const result = db.insert(workbenchVersions).values(values).run();
  return Number(result.lastInsertRowid);
}

/** 分页列表（id 倒序 = 最新在前） */
export function listWorkbenchVersions(
  db: Db,
  opts: { page: number; pageSize: number },
): { rows: WorkbenchVersionRow[]; total: number } {
  const all = db.select().from(workbenchVersions).orderBy(desc(workbenchVersions.id)).all();
  const total = all.length;
  const start = (opts.page - 1) * opts.pageSize;
  return { rows: all.slice(start, start + opts.pageSize), total };
}

export function latestWorkbenchVersion(db: Db): WorkbenchVersionRow | undefined {
  return db.select().from(workbenchVersions).orderBy(desc(workbenchVersions.id)).get();
}

export function workbenchVersionById(db: Db, id: number): WorkbenchVersionRow | undefined {
  return db.select().from(workbenchVersions).where(eq(workbenchVersions.id, id)).get();
}

/** 全量版本元数据（id 倒序），发布后滚动保留与对象 GC 用 */
export function listWorkbenchVersionMetas(db: Db): WorkbenchVersionMeta[] {
  return db
    .select({ id: workbenchVersions.id, manifestJson: workbenchVersions.manifestJson })
    .from(workbenchVersions)
    .orderBy(desc(workbenchVersions.id))
    .all();
}

export function deleteWorkbenchVersion(db: Db, id: number): void {
  db.delete(workbenchVersions).where(eq(workbenchVersions.id, id)).run();
}
