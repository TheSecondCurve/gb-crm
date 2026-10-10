// K63 image-meta：零依赖图片头解析（PNG/GIF/JPEG/WebP）——合成最小 buffer 验证。
import { describe, expect, it } from "vitest";

import { parseImageDimensions } from "../../src/modules/materials/image-meta.js";

function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeGif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function makeJpeg(width: number, height: number): Buffer {
  // SOI + APP0(空) + SOF0(高 2 字节、宽 2 字节)
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

function makeWebpLossless(width: number, height: number): Buffer {
  const packed = (width - 1) | ((height - 1) << 14);
  const body = Buffer.alloc(5);
  body[0] = 0x2f;
  body.writeUInt32LE(packed, 1);
  const chunk = Buffer.concat([Buffer.from("VP8L", "ascii"), Buffer.from([body.length, 0, 0, 0]), body]);
  const buf = Buffer.alloc(32);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(chunk.length, 4);
  buf.write("WEBP", 8, "ascii");
  buf.set(chunk, 12);
  return buf;
}

describe("parseImageDimensions（K63）", () => {
  it("PNG IHDR", () => {
    expect(parseImageDimensions(makePng(640, 480))).toEqual({ width: 640, height: 480 });
    expect(parseImageDimensions(makePng(1, 1))).toEqual({ width: 1, height: 1 });
  });

  it("GIF logical screen descriptor", () => {
    expect(parseImageDimensions(makeGif(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("JPEG SOF0（含前置 APP0 段）", () => {
    expect(parseImageDimensions(makeJpeg(600, 300))).toEqual({ width: 600, height: 300 });
  });

  it("WebP VP8L lossless（-1 存储）", () => {
    expect(parseImageDimensions(makeWebpLossless(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("非图片 / 截断 buffer / 未知格式 → null", () => {
    expect(parseImageDimensions(Buffer.from("hello world, not an image at all"))).toBeNull();
    expect(parseImageDimensions(Buffer.alloc(4))).toBeNull();
    expect(parseImageDimensions(Buffer.alloc(0))).toBeNull();
    const junk = Buffer.alloc(64, 0xab);
    expect(parseImageDimensions(junk)).toBeNull();
  });
});
