// 资料创建/更新：文本与媒体走 JSON；对象存储（kind=file）走 multipart。
import { MATERIAL_FILE_KIND, MATERIAL_TEXT_KINDS } from "@gb-crm/shared";

import { api } from "./client";
import type { MaterialDetailDto } from "./types";

export function materialFileUrl(id: number, download = false): string {
  return `/api/v1/materials/${id}/file${download ? "?download=1" : ""}`;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function submitMaterial(
  body: Record<string, unknown>,
  file: File | undefined,
  existing: MaterialDetailDto | null,
): Promise<MaterialDetailDto | null> {
  const kind = String(body.kind ?? existing?.kind ?? "");
  if (kind === MATERIAL_FILE_KIND) {
    if (!existing) {
      if (!file) throw new Error("请选择要上传的文件");
      const form = new FormData();
      form.append("title", String(body.title ?? ""));
      if (body.deliveryId != null) form.append("deliveryId", String(body.deliveryId));
      if (Array.isArray(body.customerIds)) {
        form.append("customerIds", JSON.stringify(body.customerIds));
      }
      // K58：标签关系数组 / 随手建词，multipart 里以 JSON 数组字符串携带
      if (Array.isArray(body.tagIds)) {
        form.append("tagIds", JSON.stringify(body.tagIds));
      }
      if (Array.isArray(body.newTagNames)) {
        form.append("newTagNames", JSON.stringify(body.newTagNames));
      }
      form.append("file", file);
      const res = await api.postForm<{ data: MaterialDetailDto }>("/materials/upload", form);
      return res?.data ?? null;
    }
    let current: MaterialDetailDto = existing;
    if (file) {
      const form = new FormData();
      form.append("updatedAt", String(current.updatedAt));
      form.append("file", file);
      const res = await api.postForm<{ data: MaterialDetailDto }>(
        `/materials/${current.id}/file`,
        form,
      );
      if (!res?.data) return null;
      current = res.data;
    }
    const patch: Record<string, unknown> = {
      updatedAt: current.updatedAt,
      title: body.title,
      deliveryId: body.deliveryId,
      customerIds: body.customerIds,
    };
    // K58：标签键缺席不动（调用方没动标签区就不透传）
    if (body.tagIds !== undefined) patch.tagIds = body.tagIds;
    if (body.newTagNames !== undefined) patch.newTagNames = body.newTagNames;
    const saved = await api.patch<{ data: MaterialDetailDto }>(`/materials/${current.id}`, patch);
    return saved?.data ?? current;
  }

  if (existing) {
    const saved = await api.patch<{ data: MaterialDetailDto }>(`/materials/${existing.id}`, body);
    return saved?.data ?? null;
  }
  const res = await api.post<{ data: MaterialDetailDto }>("/materials", body);
  return res?.data ?? null;
}

export function shouldOpenEditor(kind: string): boolean {
  return (MATERIAL_TEXT_KINDS as readonly string[]).includes(kind);
}
