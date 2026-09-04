// kind=file 的图片预览判定（assemble 与 file 模块共用，避免循环依赖）

const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

export function isPreviewableImage(contentType: string | null, filename: string | null): boolean {
  const ct = (contentType ?? "").toLowerCase().split(";")[0]!.trim();
  if (PREVIEWABLE_IMAGE_TYPES.has(ct)) return true;
  const base = (filename ?? "").split(/[/\\]/).pop() ?? "";
  const m = base.match(/(\.[A-Za-z0-9]{1,10})$/);
  const ext = m ? m[1]!.toLowerCase() : "";
  return IMAGE_EXT.has(ext);
}
