// material_folders 表 Drizzle 查询（§3 repo 层）。
// K63：live 唯一「同级不重名」由表达式索引 (coalesce(parent_id,0), name) WHERE deleted_at IS NULL 保证
// （NULL 视为 0 参与唯一，根目录下也不重名）；路径不落库，由 service 递归推导。
import { and, count, eq, isNotNull, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { deliveryMaterials, materialFolders } from "../../db/schema.js";

export type MaterialFolderRow = typeof materialFolders.$inferSelect;

export function listLiveFolders(db: Db): MaterialFolderRow[] {
  return db
    .select()
    .from(materialFolders)
    .where(isNull(materialFolders.deletedAt))
    .orderBy(materialFolders.name, materialFolders.id)
    .all();
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getFolderByIdAny(db: Db, id: number): MaterialFolderRow | undefined {
  return db.select().from(materialFolders).where(eq(materialFolders.id, id)).get();
}

/** 同级下 live 同名文件夹（唯一性预检） */
export function getLiveFolderByName(
  db: Db,
  parentId: number | null,
  name: string,
): MaterialFolderRow | undefined {
  return db
    .select()
    .from(materialFolders)
    .where(
      and(
        isNull(materialFolders.deletedAt),
        eq(materialFolders.name, name),
        parentId === null
          ? isNull(materialFolders.parentId)
          : eq(materialFolders.parentId, parentId),
      ),
    )
    .get();
}

export function insertFolder(
  db: Db,
  values: typeof materialFolders.$inferInsert,
): number {
  return Number(db.insert(materialFolders).values(values).run().lastInsertRowid);
}

/** PATCH 内核 + 行级 OCC（K24） */
export function occUpdateFolder(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof materialFolders.$inferInsert>,
): number {
  return db
    .update(materialFolders)
    .set(set)
    .where(
      and(
        eq(materialFolders.id, id),
        eq(materialFolders.updatedAt, expectedUpdatedAt),
        isNull(materialFolders.deletedAt),
      ),
    )
    .run().changes;
}

export function softDeleteFolder(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(materialFolders)
    .set(set)
    .where(and(eq(materialFolders.id, id), isNull(materialFolders.deletedAt)))
    .run().changes;
}

/** 直接子级 live 文件夹数（删除预检） */
export function countLiveChildFolders(db: Db, id: number): number {
  return Number(
    db
      .select({ value: count() })
      .from(materialFolders)
      .where(and(eq(materialFolders.parentId, id), isNull(materialFolders.deletedAt)))
      .get()?.value ?? 0,
  );
}

/** 直接挂在文件夹下的 live 资料数（删除预检：仅空文件夹可删） */
export function countLiveMaterialsInFolder(db: Db, id: number): number {
  return Number(
    db
      .select({ value: count() })
      .from(deliveryMaterials)
      .where(
        and(
          eq(deliveryMaterials.folderId, id),
          isNull(deliveryMaterials.deletedAt),
        ),
      )
      .get()?.value ?? 0,
  );
}

/** 每个文件夹直接挂的 live 资料数（列表计数，GROUP BY 一次拿全；不含子文件夹） */
export function countLiveMaterialsByFolder(db: Db): Map<number, number> {
  const rows = db
    .select({ folderId: deliveryMaterials.folderId, value: count() })
    .from(deliveryMaterials)
    .where(and(isNotNull(deliveryMaterials.folderId), isNull(deliveryMaterials.deletedAt)))
    .groupBy(deliveryMaterials.folderId)
    .all();
  return new Map(rows.map((r) => [r.folderId!, Number(r.value)]));
}
