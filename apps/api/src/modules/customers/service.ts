// customers 业务规则（§3 service 层）：
// - PATCH 内核用收口后的 lib/patch-kernel.ts（K24）：键存在才 SET；updatedAt 必带 OCC；
//   changes===0 → 软删 404，否则 409 且 data 带当前完整行（含 expansions）；
// - 关系数组（K24）：tagCodes/ownerIds/upsellOwnerIds/sourceChannelIds/communityChannelIds
//   缺席=不动、[]=清空、[ids]=事务内整表替换并 bump updated_at；
//   引用的用户/渠道必须存在且未软删，否则 422；tagCodes 枚举由 Zod 挡 422；
// - parentId 始终校验（K15）：拒绝自指、拒绝环（新父是自己的子孙）、拒绝深度 > 2
//   （只允许 企业 → 下属 一层：新父自身有父 → 拒绝；自己已有 live 下属再被指为子 → 拒绝）；
//   父已软删 → 422；PATCH parentId=null → 清空允许；
// - wechatOpenid 可空唯一（live 行内）：冲突 → 409；软删后释放可复用（partial unique 兜底）；
// - create：nickname 必填（shared schema 要求 min(1)）；「未命名客户」默认值由 web/导入侧决定，
//   API 不代填；customerType 默认 customer（schema default）。
// - 删除 = 软删，五张 join 行保留（K9/K33）。
import type { CustomerListQuery, CustomerPatch, CustomerWrite } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { applyScalarPatch } from "../../lib/patch-kernel.js";
import { conflict, notFound, unprocessable } from "../../plugins/error-handler.js";
import { assembleCustomer, assembleCustomers, type CustomerDto } from "./assemble.js";
import {
  findLiveByWechatOpenid,
  findLiveChannelIds,
  findLiveUserIds,
  getCustomerByIdAny,
  hasLiveChildren,
  insertCustomer,
  listCustomers,
  occUpdateCustomer,
  replaceCustomerCommunityChannels,
  replaceCustomerOwners,
  replaceCustomerSourceChannels,
  replaceCustomerTags,
  replaceCustomerUpsellOwners,
  softDeleteCustomer,
} from "./repo.js";

// better-sqlite3 事务是同步的；tx 与 Db 的查询接口同构，收窄类型以复用 repo 函数
function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

function assertLiveUsers(db: Db, ids: readonly number[], path: string, label: string): void {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const live = findLiveUserIds(db, unique);
  const missing = unique.filter((id) => !live.has(id));
  if (missing.length > 0) {
    throw unprocessable(`${label}不存在或已删除`, [
      { path, message: `无效用户 id: ${missing.join(",")}` },
    ]);
  }
}

function assertLiveChannels(db: Db, ids: readonly number[], path: string, label: string): void {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const live = findLiveChannelIds(db, unique);
  const missing = unique.filter((id) => !live.has(id));
  if (missing.length > 0) {
    throw unprocessable(`${label}不存在或已删除`, [
      { path, message: `无效渠道 id: ${missing.join(",")}` },
    ]);
  }
}

/**
 * parentId 校验（K15，始终执行——create 与 PATCH 都走这里；selfId=null 表示新建尚无 id）。
 * 深度语义：只允许 企业 → 下属 一层（最深 2 层）。由此：
 * - 新父自身已有父（新父是别人的下属）→ 再挂会到第 3 层，拒绝；
 * - 自己已有 live 下属 → 自己必须是顶层，再被指为子会到第 3 层，拒绝；
 * - 环：深度 ≤2 不变式下环只能是直接的——新父是自己的子（newParent.parentId === selfId）。
 */
function assertValidParent(db: Db, selfId: number | null, parentId: number): void {
  if (selfId !== null && parentId === selfId) {
    throw unprocessable("父客户不能是自己", [{ path: "parentId", message: "不允许自指" }]);
  }
  const parent = getCustomerByIdAny(db, parentId);
  if (!parent || parent.deletedAt !== null) {
    throw unprocessable("父客户不存在或已删除", [
      { path: "parentId", message: `无效客户 id: ${parentId}` },
    ]);
  }
  if (selfId !== null && parent.parentId === selfId) {
    throw unprocessable("不能形成父子环", [
      { path: "parentId", message: "新父客户是自己的下属客户" },
    ]);
  }
  if (parent.parentId !== null) {
    throw unprocessable("父客户层级最多两层（企业 → 下属）", [
      { path: "parentId", message: "新父客户自身已有父客户" },
    ]);
  }
  if (selfId !== null && hasLiveChildren(db, selfId)) {
    throw unprocessable("父客户层级最多两层（企业 → 下属）", [
      { path: "parentId", message: "该客户已有下属客户，不能再指定父客户" },
    ]);
  }
}

/** wechatOpenid 可空唯一（live 行内）；冲突 → 409。null/缺席不校验 */
function assertWechatOpenidFree(db: Db, openid: string, excludeId?: number): void {
  if (findLiveByWechatOpenid(db, openid, excludeId)) {
    throw conflict("wechatOpenid 已被其它客户占用");
  }
}

/** 关系键校验（存在才校验；同事务替换在 PATCH 标量成功后执行） */
function assertRelations(db: Db, body: {
  ownerIds?: number[];
  upsellOwnerIds?: number[];
  sourceChannelIds?: number[];
  communityChannelIds?: number[];
}): void {
  if (body.ownerIds !== undefined) assertLiveUsers(db, body.ownerIds, "ownerIds", "归属人");
  if (body.upsellOwnerIds !== undefined) {
    assertLiveUsers(db, body.upsellOwnerIds, "upsellOwnerIds", "升单人");
  }
  if (body.sourceChannelIds !== undefined) {
    assertLiveChannels(db, body.sourceChannelIds, "sourceChannelIds", "来源渠道");
  }
  if (body.communityChannelIds !== undefined) {
    assertLiveChannels(db, body.communityChannelIds, "communityChannelIds", "所在社群");
  }
}

/** 关系整表替换（仅处理出现的键；调用方保证在事务内） */
function replaceRelations(
  db: Db,
  id: number,
  body: {
    tagCodes?: string[];
    ownerIds?: number[];
    upsellOwnerIds?: number[];
    sourceChannelIds?: number[];
    communityChannelIds?: number[];
  },
): void {
  if (body.tagCodes !== undefined) replaceCustomerTags(db, id, body.tagCodes);
  if (body.ownerIds !== undefined) replaceCustomerOwners(db, id, body.ownerIds);
  if (body.upsellOwnerIds !== undefined) replaceCustomerUpsellOwners(db, id, body.upsellOwnerIds);
  if (body.sourceChannelIds !== undefined) {
    replaceCustomerSourceChannels(db, id, body.sourceChannelIds);
  }
  if (body.communityChannelIds !== undefined) {
    replaceCustomerCommunityChannels(db, id, body.communityChannelIds);
  }
}

export function listCustomersResult(
  db: Db,
  query: CustomerListQuery,
): { data: CustomerDto[]; total: number } {
  const { rows, total } = listCustomers(db, query);
  return { data: assembleCustomers(db, rows), total };
}

export function getCustomerResult(db: Db, id: number): CustomerDto {
  const row = getCustomerByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("客户不存在");
  return assembleCustomer(db, row);
}

export function createCustomer(db: Db, body: CustomerWrite, ctx: AuditContext): CustomerDto {
  return inTx(db, (tx) => {
    const { tagCodes, ownerIds, upsellOwnerIds, sourceChannelIds, communityChannelIds, ...fields } =
      body;
    assertRelations(tx, { ownerIds, upsellOwnerIds, sourceChannelIds, communityChannelIds });
    if (fields.parentId != null) assertValidParent(tx, null, fields.parentId);
    if (fields.wechatOpenid != null) assertWechatOpenidFree(tx, fields.wechatOpenid);

    const id = insertCustomer(tx, { ...fields, ...createAudit(ctx) });
    replaceRelations(tx, id, {
      tagCodes,
      ownerIds,
      upsellOwnerIds,
      sourceChannelIds,
      communityChannelIds,
    });
    return assembleCustomer(tx, getCustomerByIdAny(tx, id)!);
  });
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证；关系键走整表替换，不在此列） */
const PATCHABLE_KEYS = new Set([
  "nickname",
  "realName",
  "title",
  "phone",
  "wechat",
  "otherSocial",
  "wechatChannelsAccount",
  "xiaoyuzhouAccount",
  "xiaohongshuAccount",
  "weiboAccount",
  "douyinAccount",
  "country",
  "city",
  "originStory",
  "notes",
  "profileUrl",
  "customerType",
  "parentId",
  "wechatOpenid",
  "lastFollowedAt",
  "feishuCreatedDate",
]);

export function patchCustomer(
  db: Db,
  id: number,
  patch: CustomerPatch,
  ctx: AuditContext,
): CustomerDto {
  return inTx(db, (tx) => {
    // 先校验（422 先于任何写入；事务回滚兜底）
    assertRelations(tx, patch);
    if (patch.parentId !== undefined && patch.parentId !== null) {
      assertValidParent(tx, id, patch.parentId);
    }
    if (patch.wechatOpenid !== undefined && patch.wechatOpenid !== null) {
      assertWechatOpenidFree(tx, patch.wechatOpenid, id);
    }

    // 标量内核：键存在才 SET + 行级 OCC；409 data 带当前完整行（含 expansions）
    applyScalarPatch(patch, ctx, {
      scalarKeys: PATCHABLE_KEYS,
      occUpdate: (set) => occUpdateCustomer(tx, id, patch.updatedAt, set),
      getRowAny: () => getCustomerByIdAny(tx, id),
      isDeleted: (row) => row.deletedAt !== null,
      serialize: (row) => assembleCustomer(tx, row),
      notFoundMessage: "客户不存在",
    });

    // 关系键：缺席=不动；[]=清空；[ids]=整表替换（与标量同一事务，updated_at 已 bump）
    replaceRelations(tx, id, patch);
    return assembleCustomer(tx, getCustomerByIdAny(tx, id)!);
  });
}

export function deleteCustomer(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteCustomer(db, id, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("客户不存在");
}
