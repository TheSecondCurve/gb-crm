// channels 业务规则（§3 service 层）：
// - K27 密钥字段：canSeeSecrets=false（assistant）时 GET list/one、PATCH 响应、409 data
//   一律把五个密钥字段置 null；「PATCH 含密钥键 → 403」的门槛在 routes preHandler
//   （对齐 users 的 updateRole 模式，策略唯一来源仍是 shared.can()）；
// - PATCH 内核（K24）与 users 同构：键存在才 SET（null → SET NULL 可空列）；updatedAt 必带 OCC；
//   changes===0 → 软删 404，否则 409 且 data 带当前完整行；
// - ownerIds：缺席=不动；[]=清空；[ids]=事务内整表替换并 bump updated_at；
//   引用不存在或已软删用户 → 422（K9：软删不剥 join 行，展开只含 live 用户）；
// - 删除 = 软删，channel_owners join 行保留。
import type { ChannelListQuery, ChannelPatch, ChannelWrite } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { conflict, notFound, unprocessable } from "../../plugins/error-handler.js";
import { assembleChannel, assembleChannels, type ChannelDto } from "./assemble.js";
import {
  findLiveUserIds,
  getChannelByIdAny,
  insertChannel,
  listChannels,
  occUpdateChannel,
  replaceChannelOwners,
  softDeleteChannel,
} from "./repo.js";

// better-sqlite3 事务是同步的；tx 与 Db 的查询接口同构，收窄类型以复用 repo 函数
function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

/** K27：assistant（无 channels.readChannelSecrets）看到的密钥字段一律 null */
function maskSecrets(dto: ChannelDto): ChannelDto {
  return {
    ...dto,
    accountId: null,
    registerPhone: null,
    registrant: null,
    realNamePerson: null,
    loginDevice: null,
  };
}

function assertLiveOwners(db: Db, ownerIds: readonly number[]): void {
  const unique = [...new Set(ownerIds)];
  if (unique.length === 0) return;
  const live = findLiveUserIds(db, unique);
  const missing = unique.filter((id) => !live.has(id));
  if (missing.length > 0) {
    throw unprocessable("负责人不存在或已删除", [
      { path: "ownerIds", message: `无效用户 id: ${missing.join(",")}` },
    ]);
  }
}

export function listChannelsResult(
  db: Db,
  query: ChannelListQuery,
  canSeeSecrets: boolean,
): { data: ChannelDto[]; total: number } {
  // M1：能否看密钥同时决定密钥列是否参与 q 搜索（防搜索命中神谕）
  const { rows, total } = listChannels(db, query, canSeeSecrets);
  const data = assembleChannels(db, rows);
  return { data: canSeeSecrets ? data : data.map(maskSecrets), total };
}

export function getChannelResult(db: Db, id: number, canSeeSecrets: boolean): ChannelDto {
  const row = getChannelByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("渠道不存在");
  const dto = assembleChannel(db, row);
  return canSeeSecrets ? dto : maskSecrets(dto);
}

export function createChannel(db: Db, body: ChannelWrite, ctx: AuditContext): ChannelDto {
  return inTx(db, (tx) => {
    const { ownerIds, ...fields } = body;
    if (ownerIds !== undefined) assertLiveOwners(tx, ownerIds);
    const id = insertChannel(tx, { ...fields, ...createAudit(ctx) });
    if (ownerIds !== undefined && ownerIds.length > 0) replaceChannelOwners(tx, id, ownerIds);
    return assembleChannel(tx, getChannelByIdAny(tx, id)!);
  });
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证不是数据列；ownerIds 走 join 整表替换） */
const PATCHABLE_KEYS = new Set([
  "name",
  "description",
  "accountId",
  "registerPhone",
  "registrant",
  "realNamePerson",
  "loginDevice",
  "notes",
  "platform",
  "channelType",
  "accountType",
  "status",
  "followerCount",
]);

export function patchChannel(
  db: Db,
  id: number,
  patch: ChannelPatch,
  ctx: AuditContext,
  canSeeSecrets: boolean,
): ChannelDto {
  const dto = inTx(db, (tx) => {
    // 关系键（K24）：缺席=不动；[]=清空；[ids]=事务内整表替换
    const ownerIds = patch.ownerIds;
    if (ownerIds !== undefined) assertLiveOwners(tx, ownerIds);

    // 键存在才 SET；缺席键不动。非空列传 null 已被 Zod 挡在 422。
    const set: Record<string, unknown> = { ...updateAudit(ctx) };
    for (const [key, value] of Object.entries(patch)) {
      if (key === "updatedAt" || key === "ownerIds" || value === undefined) continue;
      if (!PATCHABLE_KEYS.has(key)) continue;
      set[key] = value;
    }

    const changes = occUpdateChannel(tx, id, patch.updatedAt, set);
    if (changes === 0) {
      const row = getChannelByIdAny(tx, id);
      if (!row || row.deletedAt !== null) throw notFound("渠道不存在");
      const current = assembleChannel(tx, row);
      throw conflict("数据已被他人修改，请刷新后重试", canSeeSecrets ? current : maskSecrets(current));
    }

    if (ownerIds !== undefined) replaceChannelOwners(tx, id, ownerIds);
    return assembleChannel(tx, getChannelByIdAny(tx, id)!);
  });
  return canSeeSecrets ? dto : maskSecrets(dto);
}

export function deleteChannel(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteChannel(db, id, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("渠道不存在");
}
