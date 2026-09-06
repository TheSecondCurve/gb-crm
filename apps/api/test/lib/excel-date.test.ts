// excelDate：exceljs 写日期单元格不带时区（dateToExcel 直接写 epoch 序列数，Excel 按 UTC 墙钟解读），
// 导出统一转 Asia/Shanghai 墙钟，与 UI（浏览器本地）一致。
import { describe, expect, it } from "vitest";

import { excelDate, excelDayText } from "../../src/lib/excel-date.js";

describe("excelDate（导出日期 → 上海墙钟的伪 UTC Date）", () => {
  it("UTC 2026-08-31 16:00（= 上海 09-01 00:00）→ 墙钟 09-01 00:00，不再显示成 08-31", () => {
    const ts = Date.UTC(2026, 7, 31, 16, 0, 0); // 前端 date input 2026-09-01 在上海时区存的 epoch
    const d = excelDate(ts);
    expect(d.getTime()).toBe(Date.UTC(2026, 8, 1, 0, 0, 0));
  });

  it("保留时分：上海 2026-07-01 08:00（= UTC 00:00）→ 墙钟 08:00", () => {
    const ts = Date.UTC(2026, 6, 1, 0, 0, 0);
    expect(excelDate(ts).getTime()).toBe(Date.UTC(2026, 6, 1, 8, 0, 0));
  });

  it("excelDayText：按上海墙钟输出 YYYY-MM-DD", () => {
    expect(excelDayText(Date.UTC(2026, 7, 31, 16, 0, 0))).toBe("2026-09-01");
    expect(excelDayText(Date.UTC(2026, 0, 1, 15, 59, 59))).toBe("2026-01-01"); // 上海 23:59:59 同日
    expect(excelDayText(Date.UTC(2026, 0, 1, 16, 0, 0))).toBe("2026-01-02"); // 上海跨天
  });
});
