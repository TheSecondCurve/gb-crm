// exceljs 的 dateToExcel 直接把 epoch 写成 Excel 序列数，Excel 把序列数当 UTC 墙钟解读（日期单元格无时区概念）。
// 业务日期统一按 Asia/Shanghai 墙钟导出，与 UI（浏览器本地时区）一致：epoch → 上海墙钟的“伪 UTC”Date。
const TZ = "Asia/Shanghai";

const dtf = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function shanghaiParts(ts: number): Record<string, string> {
  return Object.fromEntries(dtf.formatToParts(ts).map(({ type, value }) => [type, value]));
}

/** epoch ms → Date（其 UTC 墙钟 = 上海墙钟），写入 xlsx 日期单元格用 */
export function excelDate(ts: number): Date {
  const p = shanghaiParts(ts);
  return new Date(
    Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)),
  );
}

/** epoch ms → YYYY-MM-DD（上海墙钟），导出里范围文本等纯文本场景用 */
export function excelDayText(ms: number): string {
  const p = shanghaiParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}
