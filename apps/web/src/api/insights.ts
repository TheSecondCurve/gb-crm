// K62 客户洞察 API 封装（透视台 / 深潜 / 信号）。口径以响应 meta.calibre 为准。
import type { PivotAxisKey } from "@gb-crm/shared";

import { api, buildQuery } from "./client";

export interface PivotCellDto {
  x: string;
  y: string;
  count: number;
  customerIds: number[];
  sample: string[];
}
export interface PivotDto {
  axes: { x: { key: PivotAxisKey; label: string }; y: { key: PivotAxisKey; label: string } };
  windowDays: number;
  total: number;
  rows: { y: string; total: number; cells: PivotCellDto[] }[];
  columns: { x: string; total: number }[];
}

export interface DepthSignalDto {
  id: number;
  type: string;
  typeLabel: string;
  topicName: string | null;
  content: string;
  sourceType: string;
  sourceAt: number;
  mentionCount: number;
  confidence: number;
  status: string;
  expiresAt: number | null;
}
export interface DepthDto {
  customer: {
    id: number;
    nickname: string;
    city: string | null;
    customerType: string;
    ownerName: string | null;
  };
  temperature: number;
  temperatureBand: string;
  temperatureSeries: { at: number; temp: number }[];
  paidTotalCents: number;
  ladder: string;
  signalTypes: string[];
  signals: DepthSignalDto[];
}

export function fetchPivot(params: { x: PivotAxisKey; y: PivotAxisKey; window: number; ownerId?: number }): Promise<PivotDto> {
  return api
    .get<{ data: PivotDto }>(`/insights/pivot${buildQuery(params)}`)
    .then((r) => r!.data);
}

export function fetchDepth(customerId: number): Promise<DepthDto> {
  return api.get<{ data: DepthDto }>(`/insights/customers/${customerId}/depth`).then((r) => r!.data);
}

// ── 二期决策台 DTO ──

export interface GeoDto {
  windowDays: number;
  total: number;
  conclusion: string;
  cities: {
    city: string;
    customers: number;
    warm: number;
    hot: number;
    paidTotalCents: number;
    activeNeeds: number;
    renewals: number;
    eventAttendance: number;
    customerIds: number[];
    sample: string[];
  }[];
}

export interface LadderDto {
  windowDays: number;
  conclusion: string;
  rungs: {
    key: string;
    label: string;
    count: number;
    sample: { id: number; nickname: string; temperature: number }[];
    customerIds: number[];
    upgradeReadyCount: number;
    upgradeReady: { customerId: number; nickname: string; nextLabel: string; evidence: string; topic: string | null }[];
  }[];
  staleTagCount: number;
  staleTagCandidates: { customerId: number; nickname: string; stageTags: string[] }[];
}

export interface IntentDto {
  windowDays: number;
  total: number;
  conclusion: string;
  crossSellCount: number;
  topics: { topic: string; count: number; cityCount: number }[];
  rows: {
    customerId: number;
    nickname: string;
    type: string;
    typeLabel: string;
    topic: string | null;
    content: string;
    sourceAt: number;
    temperature: number;
    city: string | null;
    crossSell: boolean;
    mentionCount: number;
  }[];
}

export interface GuardDto {
  windowDays: number;
  total: number;
  highCount: number;
  sleepingWhaleValueCents: number;
  conclusion: string;
  items: {
    kind: string;
    kindLabel: string;
    urgency: "high" | "mid";
    customerId: number;
    nickname: string;
    reason: string;
    action: string;
    at: number;
  }[];
}

export const fetchGeo = (): Promise<GeoDto> => api.get<{ data: GeoDto }>("/insights/geo").then((r) => r!.data);
export const fetchLadder = (): Promise<LadderDto> => api.get<{ data: LadderDto }>("/insights/ladder").then((r) => r!.data);
export const fetchIntent = (): Promise<IntentDto> => api.get<{ data: IntentDto }>("/insights/intent").then((r) => r!.data);
export const fetchGuard = (): Promise<GuardDto> => api.get<{ data: GuardDto }>("/insights/guard").then((r) => r!.data);

// ── 三期 缘分清单与词表 ──

export interface MatchDto {
  windowDays: number;
  total: number;
  conclusion: string;
  topics: { topic: string; needCount: number; supplyCount: number; cityCount: number }[];
  pairs: {
    needCustomerId: number;
    needNickname: string;
    supplyCustomerId: number;
    supplyNickname: string;
    topic: string;
    viaRelated: boolean;
    score: number;
    sameCity: boolean;
    sharedDeliveries: number;
    needEvidence: string;
    supplyEvidence: string;
  }[];
}

export interface TopicHealthRow {
  id: number;
  name: string;
  enabled: number;
  signalCount: number;
  needCount: number;
  supplyCount: number;
  relatedNames: string[];
}

export const fetchMatch = (): Promise<MatchDto> => api.get<{ data: MatchDto }>("/insights/match").then((r) => r!.data);
export const fetchTopics = (page = 1): Promise<{ data: TopicHealthRow[]; total: number }> =>
  api
    .get<{ data: TopicHealthRow[]; meta: { total: number } }>(`/insights/topics${buildQuery({ page, pageSize: 100 })}`)
    .then((r) => ({ data: r!.data, total: r!.meta.total }));
export const mergeTopic = (id: number, intoId: number): Promise<unknown> =>
  api.post(`/insights/topics/${id}/merge`, { intoId });

/** 四期 AI 经营备忘（LLM 可用时生成，否则回退规则版） */
export interface InsightsSummaryDto {
  source: "llm" | "rule";
  summary: string;
  generatedAt: number;
}
export const postSummary = (): Promise<InsightsSummaryDto> =>
  api.post<{ data: InsightsSummaryDto }>("/insights/summary", {}).then((r) => r!.data);
