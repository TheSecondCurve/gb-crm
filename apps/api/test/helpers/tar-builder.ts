// 测试用 tar 构造器：手工拼 ustar 头 + pax 扩展头，给 workbench tar 读取器造夹具
// （含 zip-slip / 链接 / 长路径 pax 覆盖等畸形场景）。
import { gzipSync } from "node:zlib";

const BLOCK = 512;

function pad(data: Buffer): Buffer {
  const rem = data.length % BLOCK;
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rem)]);
}

function octal(value: number, digits: number): string {
  return value.toString(8).padStart(digits, "0");
}

export interface HeaderOpts {
  name?: string;
  prefix?: string;
  size: number;
  mode?: number;
  typeflag?: string;
  linkname?: string;
  magic?: string;
}

export function ustarHeader(opts: HeaderOpts): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write((opts.name ?? "f.txt").slice(0, 99), 0, "utf8");
  h.write(octal(opts.mode ?? 0o644, 7), 100); // 7 位数字 + NUL（alloc 已零）
  h.write(octal(0, 7), 108); // uid
  h.write(octal(0, 7), 116); // gid
  h.write(octal(opts.size, 11), 124); // 11 位数字 + NUL
  h.write(octal(0, 11), 136); // mtime
  if (opts.linkname) h.write(opts.linkname.slice(0, 99), 157, "utf8");
  h.write(opts.typeflag ?? "0", 156, "ascii");
  h.write(opts.magic ?? "ustar\0", 257, "ascii"); // + version "00"（263..264）
  h.write("00", 263, "ascii");
  if (opts.prefix) h.write(opts.prefix.slice(0, 154), 345, "utf8");
  // checksum：148..156 按 8 个空格参与无符号累加，再回写 "%06o\0 "
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  }
  h.write(`${octal(sum, 6)}\0 `, 148, "ascii");
  return h;
}

/** pax 记录体：`<len> <key>=<value>\n`，len 含自身数字、空格与换行（按 UTF-8 字节计） */
export function paxBody(records: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(records)) {
    const rec = Buffer.from(`${k}=${v}\n`, "utf8");
    let len = rec.length + 2;
    for (;;) {
      const digits = String(len).length;
      if (digits + 1 + rec.length === len) break;
      len = digits + 1 + rec.length;
    }
    parts.push(Buffer.from(`${len} `, "ascii"), rec);
  }
  return Buffer.concat(parts);
}

/** pax 扩展头条目（typeflag 'x'，或传 'g' 做全局头） */
export function paxBlock(records: Record<string, string>, typeflag = "x"): Buffer {
  const data = paxBody(records);
  return Buffer.concat([ustarHeader({ name: "PaxHeader", size: data.length, typeflag }), pad(data)]);
}

export function dirBlock(path: string): Buffer {
  return ustarHeader({ name: `${path}/`, size: 0, mode: 0o755, typeflag: "5" });
}

export interface FileSpec {
  path: string;
  content: string | Buffer;
  mode?: number;
  /** 覆盖头内 name（默认用短占位名 + pax path 记录，模拟 git archive 的非 ASCII/长路径） */
  nameInHeader?: string;
}

export function fileBlock(spec: FileSpec): Buffer {
  const content = typeof spec.content === "string" ? Buffer.from(spec.content, "utf8") : spec.content;
  const blocks: Buffer[] = [];
  if (spec.nameInHeader !== undefined) {
    blocks.push(paxBlock({ path: spec.path }));
    blocks.push(ustarHeader({ name: spec.nameInHeader, size: content.length, mode: spec.mode }));
  } else {
    blocks.push(ustarHeader({ name: spec.path, size: content.length, mode: spec.mode }));
  }
  blocks.push(pad(content));
  return Buffer.concat(blocks);
}

/** 拼一个完整 tar（结尾双零块）并 gzip */
export function tarGz(blocks: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(BLOCK * 2)]));
}
