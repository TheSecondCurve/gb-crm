// tags 业务规则（§3 service 层）：
// - PATCH 内核（K24）与 products 同构：键存在才 SET（null → SET NULL），updatedAt 必带 OCC；
//   changes===0 → 软删 404，否则 409 且 data 带当前完整行；
// - enabled：API boolean ↔ 库 0/1 在本层转换；
// - name live-unique：create/PATCH 改名冲突 → 409；软删后名字可复用；
// - 删除 = 软删（join 行保留、不展开，K9/K45）。
import type { TagListQuery, TagPatch, TagWrite } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { conflict, notFound } from "../../plugins/error-handler.js";
import { assembleTag, assembleTags, type TagDto } from "./assemble.js";
import {
  getLiveTagByName,
  getTagByIdAny,
  insertTag,
  listTags,
  occUpdateTag,
  softDeleteTag,
} from "./repo.js";

export function listTagsResult(db: Db, query: TagListQuery): { data: TagDto[]; total: number } {
  const { rows, total } = listTags(db, query);
  return { data: assembleTags(db, rows), total };
}

export function getTagResult(db: Db, id: number): TagDto {
  const row = getTagByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("标签不存在");
  return assembleTag(db, row);
}

function assertNameFree(db: Db, name: string, excludeId?: number): void {
  if (getLiveTagByName(db, name, excludeId)) {
    throw conflict(`标签「${name}」已存在`);
  }
}

export function createTag(db: Db, body: TagWrite, ctx: AuditContext): TagDto {
  const { enabled, ...fields } = body;
  assertNameFree(db, fields.name);
  const id = insertTag(db, {
    ...fields,
    enabled: enabled ? 1 : 0,
    ...createAudit(ctx),
  });
  return assembleTag(db, getTagByIdAny(db, id)!);
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证不是数据列） */
const PATCHABLE_KEYS = new Set(["name", "scope", "sort", "enabled"]);

export function patchTag(db: Db, id: number, patch: TagPatch, ctx: AuditContext): TagDto {
  if (patch.name !== undefined) assertNameFree(db, patch.name, id);

  const set: Record<string, unknown> = { ...updateAudit(ctx) };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "updatedAt" || value === undefined) continue;
    if (key === "enabled") {
      set.enabled = value ? 1 : 0; // API boolean ↔ 库 0/1
      continue;
    }
    if (!PATCHABLE_KEYS.has(key)) continue;
    set[key] = value;
  }

  const changes = occUpdateTag(db, id, patch.updatedAt, set);
  if (changes === 0) {
    const row = getTagByIdAny(db, id);
    if (!row || row.deletedAt !== null) throw notFound("标签不存在");
    throw conflict("数据已被他人修改，请刷新后重试", assembleTag(db, row));
  }
  return assembleTag(db, getTagByIdAny(db, id)!);
}

export function deleteTag(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteTag(db, id, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("标签不存在");
}
