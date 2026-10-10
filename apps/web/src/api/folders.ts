// K63 素材文件夹 API（列表/新建/改名移动/删除）+ 识别重跑。
// 文件夹量级小：全量列表不分类；查询键 "material-folders" 供素材库页与弹窗共用。
import { api } from "./client";
import type { MaterialFolderDto } from "./types";

export const FOLDERS_KEY = ["material-folders"] as const;

export async function listFolders(): Promise<MaterialFolderDto[]> {
  return (await api.get<{ data: MaterialFolderDto[] }>("/material-folders"))?.data ?? [];
}

export async function createFolder(name: string, parentId: number | null): Promise<MaterialFolderDto> {
  const res = await api.post<{ data: MaterialFolderDto }>("/material-folders", { name, parentId });
  return res!.data;
}

/** 改名 / 移动（parentId null = 移到根）；OCC updatedAt */
export async function patchFolder(
  id: number,
  patch: { name?: string; parentId?: number | null; updatedAt: number },
): Promise<MaterialFolderDto> {
  const res = await api.patch<{ data: MaterialFolderDto }>(`/material-folders/${id}`, patch);
  return res!.data;
}

export async function deleteFolder(id: number): Promise<void> {
  await api.delete(`/material-folders/${id}`);
}

/** K63 AI 识别重跑（失败/跳过的图片重新入队） */
export async function rerunEnrich(id: number): Promise<void> {
  await api.post(`/materials/${id}/enrich`);
}
