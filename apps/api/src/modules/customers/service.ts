// customers 业务规则（§3 service 层）：
// - PATCH 内核用收口后的 lib/patch-kernel.ts（K24）：键存在才 SET；updatedAt 必带 OCC；
//   changes===0 → 软删 404，否则 409 且 data 带当前完整行（含 expansions）；
// - 关系数组（K24）：tagCodes/ownerIds/sourceChannelIds
//   缺席=不动、[]=清空、[ids]=事务内整表替换并 bump updated_at；
//   引用的用户/渠道必须存在且未软删，否则 422；tagCodes 枚举由 Zod 挡 422；
// - wechatOpenid 可空唯一（live 行内）：冲突 → 409；软删后释放可复用（partial unique 兜底）；
// - create：nickname 必填（shared schema 要求 min(1)）；「未命名客户」默认值由 web/导入侧决定，
//   API 不代填；customerType 默认 customer（schema default）。
// - 删除 = 软删，三张 join 行保留（K9/K33）。
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
  insertCustomer,
  listAllCustomers,
  listCustomers,
  occUpdateCustomer,
  replaceCustomerOwners,
  replaceCustomerSourceChannels,
  replaceCustomerTags,
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

/** wechatOpenid 可空唯一（live 行内）；冲突 → 409。null/缺席不校验 */
function assertWechatOpenidFree(db: Db, openid: string, excludeId?: number): void {
  if (findLiveByWechatOpenid(db, openid, excludeId)) {
    throw conflict("wechatOpenid 已被其它客户占用");
  }
}

/** 关系键校验（存在才校验；同事务替换在 PATCH 标量成功后执行） */
function assertRelations(db: Db, body: {
  ownerIds?: number[];
  sourceChannelIds?: number[];
}): void {
  if (body.ownerIds !== undefined) assertLiveUsers(db, body.ownerIds, "ownerIds", "归属人");
  if (body.sourceChannelIds !== undefined) {
    assertLiveChannels(db, body.sourceChannelIds, "sourceChannelIds", "来源渠道");
  }
}

/** 关系整表替换（仅处理出现的键；调用方保证在事务内） */
function replaceRelations(
  db: Db,
  id: number,
  body: {
    tagCodes?: string[];
    ownerIds?: number[];
    sourceChannelIds?: number[];
  },
): void {
  if (body.tagCodes !== undefined) replaceCustomerTags(db, id, body.tagCodes);
  if (body.ownerIds !== undefined) replaceCustomerOwners(db, id, body.ownerIds);
  if (body.sourceChannelIds !== undefined) {
    replaceCustomerSourceChannels(db, id, body.sourceChannelIds);
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

/** 导出：与列表同一 WHERE（含筛选），不分页取全部 live 行并展开 */
export function exportCustomers(db: Db, query: CustomerListQuery): CustomerDto[] {
  return assembleCustomers(db, listAllCustomers(db, query));
}

export function createCustomer(db: Db, body: CustomerWrite, ctx: AuditContext): CustomerDto {
  return inTx(db, (tx) => {
    const { tagCodes, ownerIds, sourceChannelIds, ...fields } = body;
    assertRelations(tx, { ownerIds, sourceChannelIds });
    if (fields.wechatOpenid != null) assertWechatOpenidFree(tx, fields.wechatOpenid);

    const id = insertCustomer(tx, { ...fields, ...createAudit(ctx) });
    replaceRelations(tx, id, { tagCodes, ownerIds, sourceChannelIds });
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
  "customerType",
  "wechatOpenid",
  "lastFollowedAt",
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
