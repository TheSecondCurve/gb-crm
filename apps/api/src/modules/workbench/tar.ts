// K61 工作台发布包解析：tar.gz（`git archive --format=tar.gz` 产物）→ 文件条目。
// 零依赖手写 ustar/pax 读取器（house style 同 lib/s3.ts 的 SigV4）：只读不写，只支持
// git archive 会产出的形态——ustar 头 + pax 扩展头（'x' 覆盖下一文件，'g' 全局注释）；
// GNU L/K 长名、符号/硬链接、设备与 FIFO 一律显式拒绝（gb-content 不该有，静默跳过更危险）。
// 安全面：逐条目路径校验（拒绝对路径 / .. / . / 空段 / 反斜杠 / 控制字符与制表符——
// 制表符会破坏 manifest.tsv 的列结构）；条目数 / 单文件 / 解压总量三重上限防解压炸弹；
// 头部 checksum 逐块校验（无符号/有符号取其一通过，tar 世界的两种实现都认）。
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { ApiError } from "../../plugins/error-handler.js";

export interface TarEntry {
  path: string;
  /** 规范化权限位：任一 x 位 → 0o755，否则 0o644（manifest 只表达这两档） */
  mode: number;
  data: Buffer;
}

const BLOCK = 512;
/** 条目数上限（防超大包慢速 DoS；gb-content 现状 37 文件，留足增长空间） */
export const TAR_MAX_ENTRIES = 50_000;
/** 解压总量上限（防 gzip 炸弹；multipart 上传侧另有 32MB 压缩包上限） */
export const TAR_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** 单条目路径上限（字节；UTF-8 中文按 3 字节计） */
export const TAR_MAX_PATH_BYTES = 1024;

function invalid(msg: string): ApiError {
  return new ApiError(422, "VALIDATION", `发布包不合法：${msg}`);
}

/** 读 header 字符字段：NUL 截断，UTF-8 解码（pax path 记录已是 UTF-8） */
function field(buf: Buffer, off: number, len: number): string {
  const raw = buf.subarray(off, off + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/** 八进制字段解析：trim 空白与 NUL；非纯 [0-7] → null */
function parseOctal(raw: string): number | null {
  // eslint-disable-next-line no-control-regex -- tar 头字段以 NUL 填充，须显式剔除
  const t = raw.replace(/[\s\u0000]/g, "");
  if (t === "") return null;
  if (!/^[0-7]+$/.test(t)) return null;
  return parseInt(t, 8);
}

/** 头部 checksum（offset 148..156）按 8 个空格参与累加；无符号或有符号任一匹配即通过 */
function checksumOk(header: Buffer): boolean {
  const stored = parseOctal(field(header, 148, 8));
  if (stored === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const b = i >= 148 && i < 156 ? 0x20 : header[i]!;
    unsigned += b;
    signed += b < 128 ? b : b - 256;
  }
  return unsigned === stored || signed === stored;
}

/** pax 记录流解析：`<len> <key>=<value>\n`，len 为整条（含换行）的十进制字节数 */
function parsePaxRecords(data: Buffer): Map<string, string> {
  const map = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp === -1) throw invalid("pax 扩展头缺少长度分隔符");
    const lenStr = data.toString("ascii", pos, sp);
    if (!/^\d+$/.test(lenStr)) throw invalid("pax 扩展头长度不是十进制数");
    const len = parseInt(lenStr, 10);
    if (len <= sp - pos + 1 || pos + len > data.length) throw invalid("pax 扩展头长度越界");
    // kv 段从长度前缀之后开始（前缀本身不是 key 的一部分）
    const kv = data.toString("utf8", sp + 1, pos + len);
    const eq = kv.indexOf("=");
    if (eq === -1) throw invalid("pax 扩展头记录缺少 =");
    map.set(kv.slice(0, eq), kv.slice(eq + 1).replace(/\n$/, ""));
    pos += len;
  }
  return map;
}

/** 路径安全与规范校验（zip-slip 防护 + TSV 安全） */
function validateTarPath(p: string): string {
  if (p.length === 0) throw invalid("出现空路径");
  if (Buffer.byteLength(p, "utf8") > TAR_MAX_PATH_BYTES) throw invalid(`路径超长：${p.slice(0, 50)}…`);
  if (p.startsWith("/")) throw invalid(`出现绝对路径：${p}`);
  if (p.includes("\\")) throw invalid(`路径含反斜杠：${p}`);
  for (const ch of p) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) throw invalid(`路径含控制字符（含制表符）：${p}`);
  }
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      throw invalid(`路径含非法片段（空段 / . / ..）：${p}`);
    }
  }
  return p;
}

/**
 * 解析 tar.gz 发布包为文件条目数组（目录条目跳过，只返回普通文件）。
 * 任何结构性问题（非 gzip / 非 ustar / checksum 不符 / 截断 / 非法路径 / 链接条目 /
 * 重复路径 / 超上限）抛 422 VALIDATION。
 */
export function parseTarGz(bundle: Buffer): TarEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(bundle);
  } catch {
    throw invalid("不是合法的 tar.gz（gunzip 失败）");
  }
  if (tar.length === 0 || tar.length % BLOCK !== 0) throw invalid("解压后长度未按 512 字节块对齐");
  if (tar.length > TAR_MAX_TOTAL_BYTES) throw invalid("解压后超过总量上限（512MB）");

  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let pos = 0;
  // 'g' 全局 pax（git archive 会写 comment=commit id，记录仅忽略）；'x' 只覆盖下一文件
  let pendingPax: Map<string, string> | null = null;

  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break; // 结束零块，其后视为 padding
    if (!checksumOk(header)) throw invalid("头部校验和不符（包损坏）");
    const magic = field(header, 257, 6);
    if (!magic.startsWith("ustar")) throw invalid("缺 ustar magic（非 ustar 格式）");
    // GNU base-256 尺寸（>8GB 才会出现）按上限语义直接拒绝
    if ((header[124]! & 0x80) !== 0) throw invalid("不支持 base-256 尺寸字段（条目超过 8GB）");

    const typeflag = String.fromCharCode(header[156]!);
    let size = parseOctal(field(header, 124, 12));
    if (size === null) throw invalid("尺寸字段非法");
    // pax size 记录为十进制字符串，覆盖 octal 头（仅在头部写不下时由 git archive 产出）
    const paxSize = pendingPax?.get("size");
    if (paxSize !== undefined) {
      if (!/^\d+$/.test(paxSize)) throw invalid("pax size 记录非法");
      size = parseInt(paxSize, 10);
    }
    if (size > TAR_MAX_TOTAL_BYTES) throw invalid("单条目超过尺寸上限");

    const dataStart = pos + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw invalid("条目数据越界（包被截断）");
    const data = tar.subarray(dataStart, dataEnd);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "g") {
      parsePaxRecords(data); // 仅校验结构，全局记录（comment 等）不参与解析
      continue;
    }
    if (typeflag === "x") {
      pendingPax = parsePaxRecords(data);
      continue;
    }

    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const rawPath = pendingPax?.get("path") ?? (prefix !== "" ? `${prefix}/${name}` : name);
    pendingPax = null;

    if (typeflag === "5") continue; // 目录条目：文件路径由自身条目表达，跳过
    if (typeflag === "1" || typeflag === "2") {
      throw invalid(`包含链接条目（${rawPath}），工作台快照不支持链接`);
    }
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "7") {
      throw invalid(`不支持的特殊条目类型 '${typeflag}'（${rawPath}）`);
    }

    const path = validateTarPath(rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath);
    if (seen.has(path)) throw invalid(`重复路径：${path}`);
    const modeOct = parseOctal(field(header, 100, 8)) ?? 0o644;
    const mode = (modeOct & 0o111) !== 0 ? 0o755 : 0o644;

    total += data.length;
    if (total > TAR_MAX_TOTAL_BYTES) throw invalid("解压后超过总量上限（512MB）");
    if (entries.length >= TAR_MAX_ENTRIES) throw invalid(`条目数超过上限（${TAR_MAX_ENTRIES}）`);

    seen.add(path);
    entries.push({ path, mode, data });
  }

  // 入口已保证 tar.length 按 512 对齐：循环结束意味着 pos 精确到尾或停在结束零块
  // （其后为 padding，tar 规范允许在读到首个零块后停止）。
  if (entries.length === 0) throw invalid("包内没有任何文件");
  return entries;
}

/** 条目内容 sha256（hex），manifest 的对象 key */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
