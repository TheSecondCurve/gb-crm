// material_folders 业务规则（§3 service 层）：
// - live 唯一「同级不重名」（coalesce(parent_id,0) 语义）：create/PATCH 改名/移动冲突 → 409；跨级可重名；
// - 移动防环：新父的祖先链含自身 → 422（path 非落库列，移动天然零联动）；
// - 删除 = 软删，**仅空文件夹可删**（无 live 直接子文件夹、无 live 直接资料，否则 409 带计数）；
// - 路径推导：全量 live 文件夹一次载入内存拼 parent 链（文件夹量级小；深度上限防御环数据）；
// - ensureFolderPath：逐级缺则建（创建/上传时 folderPath 的落地；幂等）。
import { FOLDER_PATH_MAX_SEGMENTS } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { conflict, notFound, unprocessable } from "../../plugins/error-handler.js";
import {
  countLiveChildFolders,
  countLiveMaterialsByFolder,
  countLiveMaterialsInFolder,
  getFolderByIdAny,
  getLiveFolderByName,
  insertFolder,
  listLiveFolders,
  occUpdateFolder,
  softDeleteFolder,
  type MaterialFolderRow,
} from "./folder-repo.js";

export interface MaterialFolderDto {
  id: number;
  name: string;
  parentId: number | null;
  /** 根到本级的完整路径（a/b/c） */
  path: string;
  /** 直接挂的 live 资料数（不含子文件夹） */
  materialCount: number;
  createdAt: number;
  updatedAt: number;
}

/** 防御环数据的深度上限（正常移动防环后不会出现） */
const MAX_PATH_DEPTH = 50;

/** 全量 live 文件夹 → id 映射 + 路径推导（batch 场景一次载入） */
export function folderPathIndex(db: Db): Map<number, MaterialFolderRow> {
  return new Map(listLiveFolders(db).map((f) => [f.id, f]));
}

export function pathOfFolder(row: MaterialFolderRow, byId: Map<number, MaterialFolderRow>): string {
  const segments: string[] = [];
  let cur: MaterialFolderRow | undefined = row;
  const seen = new Set<number>();
  while (cur && cur.parentId !== null) {
    if (seen.has(cur.id)) break; // 防御环数据
    seen.add(cur.id);
    segments.unshift(cur.name);
    if (segments.length > MAX_PATH_DEPTH) break;
    cur = byId.get(cur.parentId);
  }
  if (cur && cur.parentId === null) segments.unshift(cur.name);
  return segments.join("/");
}

export function assembleFolders(db: Db, rows: readonly MaterialFolderRow[]): MaterialFolderDto[] {
  const byId = folderPathIndex(db);
  const counts = countLiveMaterialsByFolder(db);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    path: pathOfFolder(row, byId),
    materialCount: counts.get(row.id) ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export function listFoldersResult(db: Db): { data: MaterialFolderDto[] } {
  // 列表按 path 排序：树形展示稳定（同级聚在一起）
  const data = assembleFolders(db, listLiveFolders(db)).sort((a, b) =>
    a.path.localeCompare(b.path, "zh-Hans-CN"),
  );
  return { data };
}

export function getFolderResult(db: Db, id: number): MaterialFolderDto {
  return assembleFolders(db, [getLiveFolder(db, id)])[0]!;
}

function getLiveFolder(db: Db, id: number): MaterialFolderRow {
  const row = getFolderByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("文件夹不存在");
  return row;
}

/** parentId 预检：null/缺席跳过；非 null 必须 live 文件夹 */
export function assertLiveFolder(db: Db, folderId: number | null | undefined): void {
  if (folderId == null) return;
  const row = getFolderByIdAny(db, folderId);
  if (!row || row.deletedAt !== null) {
    throw unprocessable("文件夹不存在或已删除", [
      { path: "folderId", message: `无效文件夹 id: ${folderId}` },
    ]);
  }
}

function assertNameFree(
  db: Db,
  parentId: number | null,
  name: string,
  excludeId?: number,
): void {
  const hit = getLiveFolderByName(db, parentId, name);
  if (hit && hit.id !== excludeId) {
    throw conflict(`同级已存在文件夹「${name}」`);
  }
}

/** parentId 活性 + 祖先链含 self → 422（移动防环） */
function assertMovable(db: Db, id: number, newParentId: number | null): void {
  if (newParentId == null) return;
  assertLiveFolder(db, newParentId);
  let cur = getFolderByIdAny(db, newParentId);
  const seen = new Set<number>();
  while (cur && cur.parentId !== null) {
    if (cur.id === id) {
      throw unprocessable("不能把文件夹移动到它自己的子级下", [
        { path: "parentId", message: "目标父文件夹是当前文件夹的后代" },
      ]);
    }
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = getFolderByIdAny(db, cur.parentId);
  }
}

export function createFolder(
  db: Db,
  body: { name: string; parentId?: number | null },
  ctx: AuditContext,
): MaterialFolderDto {
  const parentId = body.parentId ?? null;
  assertLiveFolder(db, parentId);
  assertNameFree(db, parentId, body.name);
  const id = insertFolder(db, { parentId, name: body.name, ...createAudit(ctx) });
  return assembleFolders(db, [getFolderByIdAny(db, id)!])[0]!;
}

export function patchFolder(
  db: Db,
  id: number,
  patch: { name?: string; parentId?: number | null; updatedAt: number },
  ctx: AuditContext,
): MaterialFolderDto {
  const existing = getFolderByIdAny(db, id);
  if (!existing || existing.deletedAt !== null) throw notFound("文件夹不存在");
  const nextName = patch.name ?? existing.name;
  const nextParent = patch.parentId !== undefined ? (patch.parentId ?? null) : existing.parentId;
  if (patch.name !== undefined || patch.parentId !== undefined) {
    if (patch.parentId !== undefined) assertMovable(db, id, nextParent);
    // 名字与父任一变化，都在目标层级查重（排除自身）
    assertNameFree(db, nextParent, nextName, id);
  }
  const set: Partial<MaterialFolderRow> = { ...updateAudit(ctx) };
  if (patch.name !== undefined) set.name = nextName;
  if (patch.parentId !== undefined) set.parentId = nextParent;
  const changes = occUpdateFolder(db, id, patch.updatedAt, set);
  if (changes === 0) {
    const again = getFolderByIdAny(db, id);
    if (!again || again.deletedAt !== null) throw notFound("文件夹不存在");
    throw conflict("数据已被他人修改，请刷新后重试", assembleFolders(db, [again])[0]);
  }
  return assembleFolders(db, [getFolderByIdAny(db, id)!])[0]!;
}

export function deleteFolder(db: Db, id: number, ctx: AuditContext): void {
  getLiveFolder(db, id);
  const materials = countLiveMaterialsInFolder(db, id);
  const children = countLiveChildFolders(db, id);
  if (materials > 0 || children > 0) {
    throw conflict(
      `文件夹不为空：${materials} 份资料、${children} 个子文件夹，请先移走后再删除`,
    );
  }
  softDeleteFolder(db, id, { deletedAt: ctx.now, ...updateAudit(ctx) });
}

export function splitFolderPath(path: string): string[] {
  const segments = path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (segments.length === 0) {
    throw unprocessable("文件夹路径不能为空", [{ path: "folderPath", message: "路径不能为空" }]);
  }
  if (segments.length > FOLDER_PATH_MAX_SEGMENTS) {
    throw unprocessable(`文件夹路径层级不能超过 ${FOLDER_PATH_MAX_SEGMENTS} 层`, [
      { path: "folderPath", message: `层级超过 ${FOLDER_PATH_MAX_SEGMENTS}` },
    ]);
  }
  for (const s of segments) {
    if (s.length > 100) {
      throw unprocessable("文件夹名称不能超过 100 字", [
        { path: "folderPath", message: `段「${s.slice(0, 20)}…」过长` },
      ]);
    }
  }
  return segments;
}

/**
 * 逐级缺则建（创建/上传 folderPath 的落地）：返回末级文件夹 id。
 * 调用方负责事务（与资料行同 tx；失败整体回滚）。
 */
export function ensureFolderPath(db: Db, path: string, ctx: AuditContext): number {
  let parentId: number | null = null;
  let id: number | null = null;
  for (const segment of splitFolderPath(path)) {
    const existing = getLiveFolderByName(db, parentId, segment);
    if (existing) {
      id = existing.id;
      parentId = existing.id;
      continue;
    }
    id = insertFolder(db, { parentId, name: segment, ...createAudit(ctx) });
    parentId = id;
  }
  return id!;
}

/** 只读解析（列表过滤 folderPath 用）：解析不到返回 null（调用方按空结果处理） */
export function resolveFolderPath(db: Db, path: string): number | null {
  let parentId: number | null = null;
  let id: number | null = null;
  for (const segment of splitFolderPath(path)) {
    const hit = getLiveFolderByName(db, parentId, segment);
    if (!hit) return null;
    id = hit.id;
    parentId = hit.id;
  }
  return id;
}
