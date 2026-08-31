// materials 业务规则（§3 service 层）：
// - kind↔content/url 组合校验（K54）：文本类（transcript/text）content 可空（后补）、媒体类 url 必填；
//   create 由 Zod superRefine 挡 422，PATCH 在「现有行 + patch」合并后重跑（只改 kind 也会触发）；
// - 关联预检：deliveryId 非空必须指向 live 交付（软删 → 422）；customerIds 存在时全部 live 客户否则 422；
// - PATCH 内核（K24）：标量键存在才 SET + updatedAt OCC；customerIds 关系数组缺席不动、[] 清空、
//   事务内整表替换；changes===0 → 软删 404，否则 409 且 data 带当前完整行（DetailDto）；
// - 删除 = 软删（join 行保留、不展开，K9）。
import type { MaterialListQuery, MaterialPatch, MaterialWrite } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { applyScalarPatch } from "../../lib/patch-kernel.js";
import { notFound, unprocessable } from "../../plugins/error-handler.js";
import { getDeliveryById } from "../deliveries/repo.js";
import {
  assembleMaterialDetail,
  assembleMaterials,
  type MaterialDetailDto,
  type MaterialDto,
} from "./assemble.js";
import {
  findLiveCustomerIds,
  getMaterialByIdAny,
  insertMaterial,
  listMaterials,
  occUpdateMaterial,
  replaceMaterialCustomers,
  softDeleteMaterial,
} from "./repo.js";

// better-sqlite3 事务是同步的；tx 与 Db 的查询接口同构，收窄类型以复用 repo 函数
function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

const TEXT_KINDS: ReadonlySet<string> = new Set(["transcript", "text"]);

/** kind↔url 组合校验（K54；create/PATCH 合并值后调用）：文本类 content 可空，媒体类 url 必填 */
function assertKindCombo(kind: string, url: string | null): void {
  if (!TEXT_KINDS.has(kind) && !url) {
    throw unprocessable("媒体类资料必须填写链接", [
      { path: "url", message: "audio/video/link 必须有 url" },
    ]);
  }
}

/** deliveryId 预检：null/缺席跳过；非 null 必须指向 live 交付 */
function assertLiveDelivery(db: Db, deliveryId: number | null | undefined): void {
  if (deliveryId == null) return;
  if (!getDeliveryById(db, deliveryId)) {
    throw unprocessable("交付单不存在或已删除", [
      { path: "deliveryId", message: `无效交付单 id: ${deliveryId}` },
    ]);
  }
}

/** customerIds 预检：键存在才校验（空数组合法）；全部必须 live 客户 */
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

export function listMaterialsResult(
  db: Db,
  query: MaterialListQuery,
): { data: MaterialDto[]; total: number } {
  const { rows, total } = listMaterials(db, query);
  return { data: assembleMaterials(db, rows), total };
}

export function getMaterialResult(db: Db, id: number): MaterialDetailDto {
  const row = getMaterialByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("资料不存在");
  return assembleMaterialDetail(db, row);
}

export function createMaterial(
  db: Db,
  body: MaterialWrite,
  ctx: AuditContext,
): MaterialDetailDto {
  return inTx(db, (tx) => {
    const { customerIds, ...fields } = body;
    // Zod 已挡组合违规，此处与 PATCH 共用同一规则兜底
    assertKindCombo(fields.kind, fields.url ?? null);
    assertLiveDelivery(tx, fields.deliveryId);
    assertLiveCustomers(tx, customerIds);

    const id = insertMaterial(tx, { ...fields, ...createAudit(ctx) });
    if (customerIds !== undefined) replaceMaterialCustomers(tx, id, customerIds);
    return assembleMaterialDetail(tx, getMaterialByIdAny(tx, id)!);
  });
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证；customerIds 关系键走整表替换） */
const PATCHABLE_KEYS = new Set(["title", "kind", "url", "content", "deliveryId"]);

export function patchMaterial(
  db: Db,
  id: number,
  patch: MaterialPatch,
  ctx: AuditContext,
): MaterialDetailDto {
  return inTx(db, (tx) => {
    const existing = getMaterialByIdAny(tx, id);
    if (!existing || existing.deletedAt !== null) throw notFound("资料不存在");

    // 组合校验：合并现有行 + patch 后重跑（只改 kind 也会触发；缺席键用现有值）
    assertKindCombo(
      patch.kind ?? existing.kind,
      patch.url !== undefined ? patch.url : existing.url,
    );
    assertLiveDelivery(tx, patch.deliveryId);
    assertLiveCustomers(tx, patch.customerIds);

    // 标量内核：键存在才 SET + 行级 OCC；409 data 带当前完整行（DetailDto）
    applyScalarPatch(patch, ctx, {
      scalarKeys: PATCHABLE_KEYS,
      occUpdate: (set) => occUpdateMaterial(tx, id, patch.updatedAt, set),
      getRowAny: () => getMaterialByIdAny(tx, id),
      isDeleted: (row) => row.deletedAt !== null,
      serialize: (row) => assembleMaterialDetail(tx, row),
      notFoundMessage: "资料不存在",
    });

    // 关系键：缺席=不动；[]=清空；[ids]=整表替换（与标量同一事务，updated_at 已 bump）
    if (patch.customerIds !== undefined) replaceMaterialCustomers(tx, id, patch.customerIds);
    return assembleMaterialDetail(tx, getMaterialByIdAny(tx, id)!);
  });
}

export function deleteMaterial(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteMaterial(db, id, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("资料不存在");
}

