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
