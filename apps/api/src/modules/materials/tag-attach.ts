// K58 资料标签：解析 tagIds + newTagNames，校验 domain=material，整表替换。
import { unprocessable } from "../../plugins/error-handler.js";
import { createAudit, type AuditContext } from "../../lib/audit.js";
import type { Db } from "../../db/client.js";
import { ensureLiveTag, findLiveTagIds } from "../tags/repo.js";
import { listMaterialTagRows, replaceMaterialTags } from "./repo.js";

export interface MaterialTagPatch {
  tagIds?: number[];
  newTagNames?: string[];
}

/** 缺席 tagIds 且无新词 → undefined（调用方不动）；否则返回合并后的 id 列表 */
export function resolveMaterialTagIds(
  db: Db,
  patch: MaterialTagPatch,
  ctx: AuditContext,
  existingIds: number[],
): number[] | undefined {
  if (patch.tagIds === undefined && patch.newTagNames === undefined) return undefined;
  const base = patch.tagIds !== undefined ? [...patch.tagIds] : existingIds;
  if (base.length > 0) {
    const live = findLiveTagIds(db, base, "material");
    const missing = [...new Set(base)].filter((id) => !live.has(id));
    if (missing.length > 0) {
      throw unprocessable("标签不存在、已删除或不是资料标签", [
        { path: "tagIds", message: `无效标签 id: ${missing.join(",")}` },
      ]);
    }
  }
  const ids = [...base];
  for (const raw of patch.newTagNames ?? []) {
    const name = raw.trim();
    if (!name) continue;
    ids.push(ensureLiveTag(db, name, "material", createAudit(ctx)));
  }
  return [...new Set(ids)];
}

export function existingMaterialTagIds(db: Db, materialId: number): number[] {
  return listMaterialTagRows(db, [materialId]).map((r) => r.tagId);
}

export function applyMaterialTags(
  db: Db,
  materialId: number,
  patch: MaterialTagPatch,
  ctx: AuditContext,
  existingIds: number[] = [],
): void {
  const resolved = resolveMaterialTagIds(db, patch, ctx, existingIds);
  if (resolved === undefined) return;
  const audit = createAudit(ctx);
  replaceMaterialTags(db, materialId, resolved, {
    createdAt: audit.createdAt,
    createdBy: audit.createdBy,
  });
}
