import { z } from "zod";

import { epochMsSchema } from "./common.js";

// K63 素材文件夹（material_folders 表，自引用树）。
// 权限复用 materials 资源（admin/operator 写、assistant 只读），不新开 ACL。
// 路径不落库：DTO.path 由服务端递归推导（rename/移动零联动）。
// 名称不含 '/'（路径分隔符）；live 唯一「同级不重名、跨级可重名」。

export const folderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((v) => !v.includes("/"), { message: "文件夹名称不能包含 /" });

/** folderPath 段数上限（防止误传超长路径建出深链） */
export const FOLDER_PATH_MAX_SEGMENTS = 10;

/** 斜杠路径（如「客户A/下午茶/现场图」）；段空白剥除，空段忽略 */
export const folderPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((v) => v.split("/").filter((s) => s.trim() !== "").length > 0, {
    message: "路径不能为空",
  });

export const materialFolderWriteSchema = z.object({
  name: folderNameSchema,
  /** NULL = 根目录 */
  parentId: z.number().int().positive().nullish(),
});
export type MaterialFolderWrite = z.infer<typeof materialFolderWriteSchema>;

// PATCH 内核（K24）：键存在才 SET；parentId null = 移到根
export const materialFolderPatchSchema = z.object({
  name: folderNameSchema.optional(),
  parentId: z.number().int().positive().nullish(),
  updatedAt: epochMsSchema,
});
export type MaterialFolderPatch = z.infer<typeof materialFolderPatchSchema>;
