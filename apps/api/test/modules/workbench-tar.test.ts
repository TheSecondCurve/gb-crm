// K61 tar 读取器单测：ustar/pax 正常路径 + 各类畸形包的拒绝面。
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { parseTarGz } from "../../src/modules/workbench/tar.js";
import { dirBlock, fileBlock, paxBlock, tarGz, ustarHeader } from "../helpers/tar-builder.js";

describe("parseTarGz 正常路径", () => {
  it("普通文件：路径 / 内容 / 644 与 755 规范化", () => {
    const gz = tarGz([
      fileBlock({ path: "docs/readme.md", content: "你好，世界" }),
      fileBlock({ path: "scripts/run.sh", content: "#!/bin/sh\n", mode: 0o755 }),
    ]);
    const entries = parseTarGz(gz);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ path: "docs/readme.md", mode: 0o644 });
    expect(entries[0]!.data.toString("utf8")).toBe("你好，世界");
    expect(entries[1]).toMatchObject({ path: "scripts/run.sh", mode: 0o755 });
  });

  it("目录条目跳过，不产出文件", () => {
    const gz = tarGz([dirBlock("docs"), fileBlock({ path: "docs/a.md", content: "A" })]);
    const entries = parseTarGz(gz);
    expect(entries.map((e) => e.path)).toEqual(["docs/a.md"]);
  });

  it("pax path 覆盖：非 ASCII 长路径走扩展头（git archive 形态）", () => {
    const path = "_工作区仓库/业务上下文/产品/女商私董群二〇二六年度运营计划与产品体系总览.md";
    const gz = tarGz([
      paxBlock({ path }),
      ustarHeader({ name: "short-placeholder", size: 3 }),
      Buffer.from("abc" + "\0".repeat(509)),
    ]);
    const entries = parseTarGz(gz);
    expect(entries[0]!.path).toBe(path);
    expect(entries[0]!.data.toString("utf8")).toBe("abc");
  });

  it("ustar prefix + name 拼接路径", () => {
    const gz = tarGz([
      Buffer.concat([
        ustarHeader({ name: "a.md", prefix: "a/b/c", size: 1 }),
        Buffer.from("X" + "\0".repeat(511)),
      ]),
    ]);
    expect(parseTarGz(gz)[0]!.path).toBe("a/b/c/a.md");
  });

  it("全局 pax 头（'g'，git archive 的 comment）被忽略", () => {
    const gz = tarGz([
      paxBlock({ comment: "0f1e2d3c" }, "g"),
      fileBlock({ path: "a.txt", content: "A" }),
    ]);
    expect(parseTarGz(gz)).toHaveLength(1);
  });

  it("同一内容多路径允许（内容寻址去重由 service 处理）", () => {
    const gz = tarGz([
      fileBlock({ path: "a.txt", content: "SAME" }),
      fileBlock({ path: "b/deep/c.txt", content: "SAME" }),
    ]);
    expect(parseTarGz(gz)).toHaveLength(2);
  });
});

describe("parseTarGz 拒绝面", () => {
  it("非 gzip 内容 → 422", () => {
    expect(() => parseTarGz(Buffer.from("not a tar at all"))).toThrowError(/tar\.gz/);
  });

  it("zip-slip：../ 逃逸路径 → 422", () => {
    const gz = tarGz([fileBlock({ path: "../escape.txt", content: "X" })]);
    expect(() => parseTarGz(gz)).toThrowError(/非法片段/);
  });

  it("绝对路径 → 422", () => {
    const gz = tarGz([
      paxBlock({ path: "/etc/passwd" }),
      ustarHeader({ name: "x", size: 1 }),
      Buffer.from("X" + "\0".repeat(511)),
    ]);
    expect(() => parseTarGz(gz)).toThrowError(/绝对路径/);
  });

  it("路径含反斜杠 → 422", () => {
    const gz = tarGz([fileBlock({ path: "a\\b.txt", content: "X" })]);
    expect(() => parseTarGz(gz)).toThrowError(/反斜杠/);
  });

  it("符号链接条目 → 422", () => {
    const gz = tarGz([
      ustarHeader({ name: "link", size: 6, typeflag: "2", linkname: "target" }),
      Buffer.from("target" + "\0".repeat(506)),
    ]);
    expect(() => parseTarGz(gz)).toThrowError(/链接/);
  });

  it("重复路径 → 422", () => {
    const gz = tarGz([
      fileBlock({ path: "a.txt", content: "1" }),
      fileBlock({ path: "a.txt", content: "2" }),
    ]);
    expect(() => parseTarGz(gz)).toThrowError(/重复/);
  });

  it("头部被篡改（checksum 不符）→ 422", () => {
    const block = fileBlock({ path: "a.txt", content: "X" });
    block[3] = block[3]! ^ 0x20; // 破坏 name 字段，checksum 失配
    expect(() => parseTarGz(tarGz([block]))).toThrowError(/校验和/);
  });

  it("数据截断（size 越界）→ 422", () => {
    const header = ustarHeader({ name: "a.txt", size: 4096 });
    const truncated = Buffer.concat([header, Buffer.alloc(512)]);
    expect(() => parseTarGz(gzipSync(truncated))).toThrowError(/越界|截断/);
  });

  it("缺 ustar magic → 422", () => {
    const header = ustarHeader({ name: "a.txt", size: 1 });
    header.write("xxxxx\0", 257, "ascii");
    // 重算 checksum 保持一致，隔离出「magic 缺失」这一个变量
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    const gz = tarGz([Buffer.concat([header, Buffer.from("X" + "\0".repeat(511))])]);
    expect(() => parseTarGz(gz)).toThrowError(/ustar/);
  });

  it("空包（零条目）→ 422", () => {
    expect(() => parseTarGz(tarGz([]))).toThrowError(/没有任何文件/);
  });
});
