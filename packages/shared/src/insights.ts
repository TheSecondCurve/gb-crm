// K62 客户全景驾驶舱 —— 口径常量（代码侧单一真相源）。
// 原则「口径即 API」：所有统计口径只活在服务端（apps/api/src/modules/insights），
// 引擎、Web tooltip、agent（经 GET /insights/* 响应的 meta.calibre）共同引用本文件；
// 人类可读的完整口径说明在 docs/design.md K62 行，两处必须同步修改。

// ── 温度模型 ──
// raw = Σ 事件权重 × 2^(−距今天数 / 半衰期)，温度 = clamp(round(raw × scale), 0, 100)。
// 标定参考：一周内 paid 成交 ≈ 76；近期 lead+follow_up ≈ 51；90 天前最后一次 follow_up ≈ 1。
export const TEMPERATURE = {
  halfLifeDays: 21,
  scale: 10,
  eventWeights: {
    /** 维护记录 kind → 权重（K55） */
    maintenance: { lead: 4, follow_up: 2, status_change: 1, note: 0.5, other: 0.5 } as Record<string, number>,
    /** 成交 stage → 权重（K42；refund 为负温度） */
    deal: { gift: 3, paid: 8, refunded: -6, closed: 1 } as Record<string, number>,
    /** 关联到客户的场次资料（transcript/text）落库 */
    materialSession: 2,
    /** 进行中交付：每周 +1、封顶 activeDeliveryCap（视为当下事件，不衰减） */
    activeDeliveryPerWeek: 1,
    activeDeliveryCap: 3,
  },
} as const;

/** 温度分档（透视台「温度」轴；边界归属：左闭右开） */
export const TEMPERATURE_BANDS = [
  { key: "frozen", label: "冰点（<25）", min: 0, max: 25 },
  { key: "warm", label: "温和（25-60）", min: 25, max: 60 },
  { key: "hot", label: "活跃（≥60）", min: 60, max: 101 },
] as const;
export type TemperatureBandKey = (typeof TEMPERATURE_BANDS)[number]["key"];

/** 温度分档判定（边界左闭右开） */
export function temperatureBandOf(temp: number): TemperatureBandKey {
  for (const b of TEMPERATURE_BANDS) if (temp >= b.min && temp < b.max) return b.key;
  return "frozen";
}

// ── 价值分档（已付款成交金额，分 → 档；透视台「价值」轴） ──
export const VALUE_BANDS = [
  { key: "zero", label: "无成交", min: -1, max: 0 },
  { key: "lt10k", label: "<1 万", min: 0, max: 1_000_000 },
  { key: "b10k50k", label: "1-5 万", min: 1_000_000, max: 5_000_000 },
  { key: "ge50k", label: "≥5 万", min: 5_000_000, max: Number.MAX_SAFE_INTEGER },
] as const;
export type ValueBandKey = (typeof VALUE_BANDS)[number]["key"];

/** 价值分档判定（paidTotalCents，分；边界左闭右开） */
export function valueBandOf(paidTotalCents: number): ValueBandKey {
  for (const b of VALUE_BANDS) if (paidTotalCents >= b.min && paidTotalCents < b.max) return b.key;
  return "ge50k";
}

// ── 产品阶梯（行为推导，非标签；透视台「产品阶梯」轴） ──
// 规则：live 成交按意向产品类型取梯级 ∪ live 参与交付按交付类型分类取梯级；
// 去重后非 none 梯级数 ≥ 2 → multi（多类复购，视为最高梯级）；否则取最高单梯级。
export const LADDER = {
  rungs: [
    { key: "none", label: "未成交" },
    { key: "event", label: "活动/知识" },
    { key: "consult", label: "咨询" },
    { key: "circle", label: "圈子" },
    { key: "multi", label: "多类复购" },
  ],
  /** products.product_type → 梯级 */
  productRung: {
    campaign: "event",
    knowledge: "event",
    ad_coop: "event",
    content_coop: "event",
    c_consulting: "consult",
    b_consulting: "consult",
    circle_sub: "circle",
    team_delivery: "consult",
  } as Record<string, "event" | "consult" | "circle">,
  /** delivery_types.kind → 梯级（无成交但参与过交付） */
  deliveryRung: {
    activity: "event",
    consulting: "consult",
    circle: "circle",
    other: "event",
  } as Record<string, "event" | "consult" | "circle">,
} as const;
export type LadderRunkKey = "none" | "event" | "consult" | "circle" | "multi";

/** 阶梯判定：传入去重后的成交产品梯级集合与交付梯级集合（Set 或数组皆可） */
export function ladderOf(
  productRungs: ReadonlySet<string> | readonly string[],
  deliveryRungs: ReadonlySet<string> | readonly string[],
): LadderRunkKey {
  const set = new Set<string>([...productRungs, ...deliveryRungs]);
  if (set.size === 0) return "none";
  if (set.size >= 2) return "multi";
  return ([...set][0] as LadderRunkKey) ?? "none";
}

// ── 大区派生（城市前缀匹配；不落库） ──
const REGION_RULES: { region: string; prefixes: string[] }[] = [
  { region: "华东", prefixes: ["上海", "江苏", "浙江", "安徽", "山东", "福建", "江西", "南京", "杭州", "苏州", "宁波", "无锡", "合肥", "济南", "青岛", "厦门", "福州", "南昌"] },
  { region: "华北", prefixes: ["北京", "天津", "河北", "山西", "内蒙古", "石家庄", "太原"] },
  { region: "华南", prefixes: ["广东", "广西", "海南", "深圳", "广州", "珠海", "佛山", "东莞", "南宁", "海口"] },
  { region: "华中", prefixes: ["河南", "湖北", "湖南", "郑州", "武汉", "长沙"] },
  { region: "西南", prefixes: ["四川", "重庆", "贵州", "云南", "西藏", "成都", "贵阳", "昆明"] },
  { region: "西北", prefixes: ["陕西", "甘肃", "青海", "宁夏", "新疆", "西安", "兰州"] },
  { region: "东北", prefixes: ["辽宁", "吉林", "黑龙江", "沈阳", "大连", "长春", "哈尔滨"] },
];

/** 城市名（可含省份前缀）→ 大区；空 → null（未填）；无法识别 → "其他" */
export function regionOfCity(city: string | null | undefined): string | null {
  if (!city) return null;
  for (const rule of REGION_RULES) {
    if (rule.prefixes.some((p) => city.startsWith(p))) return rule.region;
  }
  return "其他";
}

// ── 信号 TTL（天；null = 不过期，只被同主题新事实取代） ──
export const SIGNAL_TTL_DAYS = {
  intent: 90,
  need: 90,
  risk: 180,
  sentiment: 180,
  interest_hint: 180,
  supply: 365,
  growth: null,
  lifecycle: null,
} as const;

// ── 撮合引擎（K62 三期；口径先定死，实现随缘分清单落地） ──
// 两级召回：topic 精确相等 → 满分；词表 1-hop related 邻居 → 得分 × relatedDiscount。
export const MATCH = {
  base: 1,
  relatedDiscount: 0.7,
  /** 参与撮合的信号置信度下限（低于只展示、不进名单） */
  minConfidence: 0.6,
  boosts: { sameCity: 2, sameDelivery: 2, sameMaterial: 1, mention: 1 },
} as const;

// ── 透视台维度轴（x/y 白名单；页面下拉与服务端校验共用） ──
export const PIVOT_AXES = [
  { key: "stageTag", label: "阶段标签", scope: "stage" },
  { key: "identityTag", label: "身份标签", scope: "identity" },
  { key: "interestTag", label: "兴趣标签", scope: "interest" },
  { key: "city", label: "城市" },
  { key: "region", label: "大区" },
  { key: "customerType", label: "客户类型" },
  { key: "channel", label: "来源渠道" },
  { key: "owner", label: "归属销售" },
  { key: "temperatureBand", label: "温度" },
  { key: "valueBand", label: "价值" },
  { key: "ladder", label: "产品阶梯" },
  { key: "signal", label: "活跃信号" },
] as const;
export type PivotAxisKey = (typeof PIVOT_AXES)[number]["key"];
export const PIVOT_AXIS_KEYS = PIVOT_AXES.map((a) => a.key) as unknown as readonly PivotAxisKey[];
export const pivotAxisLabels: Record<PivotAxisKey, string> = Object.fromEntries(
  PIVOT_AXES.map((a) => [a.key, a.label]),
) as Record<PivotAxisKey, string>;

/** 时间机器窗口（天） */
export const INSIGHT_WINDOWS = [30, 90, 180, 365] as const;
export type InsightWindow = (typeof INSIGHT_WINDOWS)[number];

/** 全部口径打包（GET /insights/* 响应 meta.calibre 用；对象不可变快照） */
export function insightsCalibre(): Record<string, unknown> {
  return {
    temperature: TEMPERATURE,
    temperatureBands: TEMPERATURE_BANDS,
    valueBands: VALUE_BANDS,
    ladder: LADDER,
    signalTtlDays: SIGNAL_TTL_DAYS,
    match: MATCH,
    windows: INSIGHT_WINDOWS,
  };
}
