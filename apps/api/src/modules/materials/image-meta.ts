// K63 图片元信息：零依赖手写 header 解析（PNG IHDR / JPEG SOF / GIF / WebP）→ 像素宽高。
// 不引入 sharp 等原生图片库（本仓零依赖先例：SigV4、tar 读取器均为手写）。
// 只读文件头几十字节，O(1)；不识别的格式返回 null（不抛错）。
// 注：JPEG EXIF 方向不做处理，存原始像素宽高（v1 不做 EXIF 解析）。

export interface ImageDimensions {
  width: number;
  height: number;
}

function parsePng(buf: Buffer): ImageDimensions | null {
  // 89 50 4E 47 0D 0A 1A 0A + IHDR（首个 chunk 固定在偏移 8：4 长度 + "IHDR" + 4 宽 + 4 高）
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function parseGif(buf: Buffer): ImageDimensions | null {
  // GIF87a/GIF89a + 2 字节宽 LE + 2 字节高 LE
  if (buf.length < 10) return null;
  if (buf.toString("ascii", 0, 3) !== "GIF") return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function parseJpeg(buf: Buffer): ImageDimensions | null {
  // FF D8 起扫 marker：FF xx + 2 字节段长；SOF0/1/2/3/5/6/7/9/10/11/13/14/15 段内 高(2)宽(2)
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return null; // 段间必须 FF 打头
    const marker = buf[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // 无长度段
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    if (marker === 0xda) return null; // SOS：到图像数据了还没见 SOF
    offset += 2 + segLen;
  }
  return null;
}

function parseWebp(buf: Buffer): ImageDimensions | null {
  // RIFF....WEBP + VP8 / VP8L / VP8X chunk
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    // lossy：帧 tag 3 字节后接 2 字节宽 2 字节高（低 14 位有效），起始偏移 20（chunk 头 8 + tag 3 - 起点 12）
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    if (width === 0 || height === 0) return null;
    return { width, height };
  }
  if (chunk === "VP8L") {
    // lossless：1 字节签名 0x2f + 4 字节 packed（宽 14 位、高 14 位，均减一存储）
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (chunk === "VP8X") {
    // extended：24 字节 flags 后 3 字节宽-1、3 字节高-1
    const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
    const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
    return { width, height };
  }
  return null;
}

/** 按魔数识别格式并解析宽高；非图片/解析失败 → null */
export function parseImageDimensions(buf: Buffer): ImageDimensions | null {
  return parsePng(buf) ?? parseGif(buf) ?? parseJpeg(buf) ?? parseWebp(buf);
}
