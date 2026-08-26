// cron 纯函数单测（K52）：parseField / parseCron / cronNext。
// 固定进程时区为 UTC，保证绝对时间断言稳定（Date 构造按本地时区求值）。
import { describe, expect, it } from "vitest";

import { cronNext, parseCron, parseField } from "../../src/lib/cron.js";

// cron 按进程本地时区求值——测试统一用 UTC，避免容器/主机时区差异导致脆弱
process.env.TZ = "UTC";

describe("parseField", () => {
  it("支持 *、数字、范围、步进、逗号", () => {
    expect([...parseField("*", 0, 59, "minute")]).toHaveLength(60);
    expect([...parseField("0", 0, 23, "hour")]).toEqual([0]);
    expect([...parseField("0-6", 0, 23, "hour")]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...parseField("*/15", 0, 59, "minute")]).toEqual([0, 15, 30, 45]);
    // `a/n` → a..max 步进
    expect([...parseField("5/15", 0, 59, "minute")]).toEqual([5, 20, 35, 50]);
    expect([...parseField("1,15,30", 0, 59, "minute")]).toEqual([1, 15, 30]);
  });

  it("非法输入抛错", () => {
    expect(() => parseField("", 0, 59, "minute")).toThrow();
    expect(() => parseField("abc", 0, 59, "minute")).toThrow();
    expect(() => parseField("60", 0, 59, "minute")).toThrow();
    expect(() => parseField("10-5", 0, 59, "minute")).toThrow();
    expect(() => parseField("*/0", 0, 59, "minute")).toThrow();
  });
});

describe("parseCron", () => {
  it("5 字段校验 + dow 7 归一为 0", () => {
    expect(() => parseCron("* * * *")).toThrow();
    const f = parseCron("0 0 * * 7");
    expect(f.dow.has(7)).toBe(true);
    expect(f.dow.has(0)).toBe(true);
  });
});

describe("cronNext", () => {
  const at = (iso: string) => new Date(iso).getTime();

  it("严格大于 fromMs（下一整分钟）", () => {
    const from = at("2026-08-26T06:56:20Z");
    expect(cronNext("* * * * *", from)).toBe(at("2026-08-26T06:57:00Z"));
  });

  it("*/15 每刻钟", () => {
    const from = at("2026-08-26T06:56:00Z");
    expect(cronNext("*/15 * * * *", from)).toBe(at("2026-08-26T07:00:00Z"));
  });

  it("每日 02:00", () => {
    const from = at("2026-08-26T06:56:00Z");
    expect(cronNext("0 2 * * *", from)).toBe(at("2026-08-27T02:00:00Z"));
  });

  it("范围 + 月度：每月 1 日 01:30", () => {
    const from = at("2026-08-26T06:56:00Z");
    expect(cronNext("30 1 1 * *", from)).toBe(at("2026-09-01T01:30:00Z"));
  });

  it("月域 2 月 + 工作日：2027-02-01 起逐日", () => {
    const from = at("2026-08-26T06:56:00Z");
    // `0 0 * 2 1-5`：2 月内工作日 00:00
    const next = new Date(cronNext("0 0 * 2 1-5", from)!);
    expect(next.getUTCMonth()).toBe(1); // 二月
    expect([1, 2, 3, 4, 5].includes(next.getUTCDay())).toBe(true);
  });

  it("dom/dow OR 语义：每月 1 日 或 周日", () => {
    const from = at("2026-08-26T06:56:00Z");
    const next = cronNext("0 0 1 * 0", from)!;
    const d = new Date(next);
    const isFirst = d.getUTCDate() === 1;
    const isSunday = d.getUTCDay() === 0;
    expect(isFirst || isSunday).toBe(true);
  });

  it("不可达（2 月 31 日）→ null", () => {
    expect(cronNext("0 0 31 2 *", at("2026-08-26T06:56:00Z"))).toBeNull();
  });

  it("dow 7 = 周日（与 0 等价）", () => {
    const from = at("2026-08-26T06:56:00Z"); // 周三
    const a = cronNext("0 0 * * 0", from);
    const b = cronNext("0 0 * * 7", from);
    expect(a).toBe(b);
  });
});
