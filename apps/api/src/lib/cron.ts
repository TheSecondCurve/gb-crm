// 最小 5 字段 cron 求值（零依赖，K52）：`minute hour day-of-month month day-of-week`。
// 支持：`*`、逗号列表、范围 `a-b`、步进 `/n`（含 `*/n`、`a/n`、`a-b/n`）。
// dow 允许 0-7，`7` 归一为 `0`（0=周日）。dom/dow 遵循标准 OR 语义：
//   两者都是 `*` → 任意日；仅一位受限 → 按受限者；两者都受限 → 任一命中即匹配。
// 时区：按进程本地时区求值（生产容器建议 TZ=Asia/Shanghai，见 docs/design.md K52）。
// 纯函数，供 job-schedules 校验/next-fire 与单侧使用；非法表达式抛 Error（调用方转 422 VALIDATION）。

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** dom 字段原始是否为 `*`（OR 语义判定用） */
  domWildcard: boolean;
  /** dow 字段原始是否为 `*`（OR 语义判定用） */
  dowWildcard: boolean;
}

function parseNum(spec: string, label: string): number {
  if (!/^\d+$/.test(spec)) throw new Error(`${label} 字段含非数字：'${spec}'`);
  const n = Number(spec);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} 字段数值过大：'${spec}'`);
  return n;
}

function parseStep(spec: string, label: string): number {
  const n = parseNum(spec, label);
  if (n <= 0) throw new Error(`${label} 步进必须 ≥1：'${spec}'`);
  return n;
}

/** 拆分 `a-b/c` 的回退：`range` 与 `step`；step 缺省为 null */
function splitStep(part: string, label: string): [string, string | null] {
  const at = part.indexOf("/");
  if (at === -1) return [part, null];
  const range = part.slice(0, at);
  const step = part.slice(at + 1);
  if (range === "" || step === "") throw new Error(`${label} 字段步进写法非法：'${part}'`);
  return [range, step];
}

/** 解析单个字段为允许值集合（0 基字段用 min/max；dow 允许 7，调用方再归一化 7→0） */
export function parseField(spec: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  if (spec === "") throw new Error(`${label} 字段为空`);
  for (const rawPart of spec.split(",")) {
    const part = rawPart.trim();
    if (part === "") throw new Error(`${label} 字段存在空项`);
    const [range, stepStr] = splitStep(part, label);
    const hasStep = stepStr !== null;
    const step = hasStep ? parseStep(stepStr, label) : 1;

    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const dash = range.indexOf("-");
      const s = range.slice(0, dash);
      const e = range.slice(dash + 1);
      start = parseNum(s, label);
      end = parseNum(e, label);
      if (start > end) throw new Error(`${label} 范围起点大于终点：'${range}'`);
    } else {
      start = parseNum(range, label);
      end = hasStep ? max : start; // `a/n` → a..max 步进；裸 `a` → 仅 a
    }
    if (start < min || end > max) {
      throw new Error(`${label} 数值越界（${min}~${max}）：'${range}'`);
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

/** 解析完整 5 字段 cron 表达式 */
export function parseCron(cron: string): CronFields {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 需为 5 个字段（收到 ${parts.length} 个）：'${cron}'`);
  }
  const [minute, hour, dom, month, dow] = [
    parts[0]!,
    parts[1]!,
    parts[2]!,
    parts[3]!,
    parts[4]!,
  ];
  const minuteSet = parseField(minute, 0, 59, "minute");
  const hourSet = parseField(hour, 0, 23, "hour");
  const domSet = parseField(dom, 1, 31, "day of month");
  const monthSet = parseField(month, 1, 12, "month");
  const dowSet = parseField(dow, 0, 7, "day of week");
  if (dowSet.has(7)) dowSet.add(0); // 7 = 周日
  return {
    minute: minuteSet,
    hour: hourSet,
    dom: domSet,
    month: monthSet,
    dow: dowSet,
    domWildcard: dom.trim() === "*",
    dowWildcard: dow.trim() === "*",
  };
}

function dayMatches(f: CronFields, dom: number, dow: number): boolean {
  if (f.domWildcard && f.dowWildcard) return true;
  if (f.domWildcard) return f.dow.has(dow);
  if (f.dowWildcard) return f.dom.has(dom);
  return f.dom.has(dom) || f.dow.has(dow);
}

const YEAR_IN_MS = 366 * 24 * 60 * 60 * 1000;
/** 搜索窗口：5 年内找不到下一个触发即认为不可达（用于校验 cron 合法性） */
const MAX_WINDOW_MS = 5 * YEAR_IN_MS;

/**
 * 求严格大于 fromMs（epoch 毫秒）的下一次触发时间；窗口内不可达返回 null。
 * 用「逐字段跳进」：月不匹配跳下月首日、日不匹配跳次日、时/分不匹配跳下一整格。
 */
export function cronNext(cron: string, fromMs: number): number | null {
  const f = parseCron(cron);
  const deadline = fromMs + MAX_WINDOW_MS;
  let t = Math.floor(fromMs / 60_000) * 60_000 + 60_000; // 下一个整分钟（严格 > fromMs）

  while (t <= deadline) {
    const d = new Date(t);
    if (!f.month.has(d.getMonth() + 1)) {
      t = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); // 下月首日 00:00
      continue;
    }
    if (!dayMatches(f, d.getDate(), d.getDay())) {
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); // 次日 00:00
      continue;
    }
    if (!f.hour.has(d.getHours())) {
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime(); // 下一整点
      continue;
    }
    if (!f.minute.has(d.getMinutes())) {
      t += 60_000;
      continue;
    }
    return t;
  }
  return null;
}
