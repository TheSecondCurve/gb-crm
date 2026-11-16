// K68 语料同步读模型（delivery_materials 的文本类投影，repo 层）。
// 变更流语义：
// - updatedSince 缺席 = 全量：仅 live 行，套用内容过滤；
// - updatedSince 给定 = 增量：live 更新行（套内容过滤）+ 墓碑行（软删，**不受内容过滤影响**
//   ——删除事实必须总能传到消费方，消费方按 id 从索引移除）；
// - 排序固定 updated_at 升序（默认）并列 id 升序：消费方翻完所有页后以 meta.nextSince 接力，
//   updated_at 单调递增 + 幂等 upsert 保证排空不丢行（desc 仅供「探最新」反向翻阅）。
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { MATERIAL_TEXT_KINDS, type CorpusDocumentsQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { deliveryMaterialTags, deliveryMaterials } from "../../db/schema.js";
import { toOffset } from "../../lib/pagination.js";
import { liveDeliveryOfKind, searchWhere, type MaterialRow } from "../materials/repo.js";

/** live 行内容过滤（q / 标签 AND / 交付类型）；墓碑行不套用 */
function liveFilter(db: Db, query: CorpusDocumentsQuery): SQL[] {
  const conds: SQL[] = [];
  if (query.q !== undefined) {
    const search = searchWhere(db, query.q);
    if (search) conds.push(search);
  }
  for (const tagId of query.tagIds ?? []) {
    conds.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(deliveryMaterialTags)
          .where(
            and(
              eq(deliveryMaterialTags.materialId, deliveryMaterials.id),
              eq(deliveryMaterialTags.tagId, tagId),
            ),
          ),
      ),
    );
  }
  if (query.deliveryKind !== undefined) {
    conds.push(
      query.deliveryKind === "other"
        ? not(liveDeliveryOfKind(db, ["consulting", "activity", "circle"]))
        : liveDeliveryOfKind(db, [query.deliveryKind]),
    );
  }
  return conds;
}

export function listCorpusDocuments(
  db: Db,
  query: CorpusDocumentsQuery,
): { rows: MaterialRow[]; total: number } {
  const textKinds = inArray(deliveryMaterials.kind, [...MATERIAL_TEXT_KINDS]) as SQL;
  const where =
    query.updatedSince === undefined
      ? and(textKinds, isNull(deliveryMaterials.deletedAt), ...liveFilter(db, query))
      : and(
          textKinds,
          gt(deliveryMaterials.updatedAt, query.updatedSince),
          or(
            and(isNull(deliveryMaterials.deletedAt), ...liveFilter(db, query)),
            isNotNull(deliveryMaterials.deletedAt),
          ),
        );

  const dir = query.order === "desc" ? desc : asc;
  const rows = db
    .select()
    .from(deliveryMaterials)
    .where(where)
    .orderBy(dir(deliveryMaterials.updatedAt), asc(deliveryMaterials.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total =
    db.select({ value: count() }).from(deliveryMaterials).where(where).get()?.value ?? 0;
  return { rows, total };
}

/** 单条补拉：仅 live 文本类（软删 / 非文本 → undefined → 404） */
export function getCorpusDocumentRow(db: Db, id: number): MaterialRow | undefined {
  return db
    .select()
    .from(deliveryMaterials)
    .where(
      and(
        eq(deliveryMaterials.id, id),
        isNull(deliveryMaterials.deletedAt),
        inArray(deliveryMaterials.kind, [...MATERIAL_TEXT_KINDS]),
      ),
    )
    .get();
}

/** 水位探针：latestUpdatedAt 含已删行（墓碑也推进前沿）；liveDocuments 只数 live 文本类 */
export function corpusHeadState(db: Db): { latestUpdatedAt: number | null; liveDocuments: number } {
  const row = db
    .select({
      latest: max(deliveryMaterials.updatedAt),
      live: sql<number | null>`SUM(CASE WHEN ${deliveryMaterials.deletedAt} IS NULL THEN 1 ELSE 0 END)`,
    })
    .from(deliveryMaterials)
    .where(inArray(deliveryMaterials.kind, [...MATERIAL_TEXT_KINDS]))
    .get();
  return { latestUpdatedAt: row?.latest ?? null, liveDocuments: row?.live ?? 0 };
}
