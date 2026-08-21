// 飞书一次性导入主路径（设计 §11）+ CLI 接线：
//   pnpm db:import                          # 读 FEISHU_* env，走飞书开放 API
//   pnpm db:import -- --from=csv <dir>      # CSV 回退（Alternative H）
//
// 网络层是可注入的 fetcher（默认 global fetch）：CI / 单测注入假 fetcher，不打 live。
// 记录按「字段中文名」解析（附录 A 摘录没有 fld*，禁止编造 field id）。
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { parseScriptEnv } from "../src/env.js";
import { formatReport, importDump, type FeishuDump, type FeishuRecord } from "./import-core.js";
import { loadCsvDump } from "./import-csv.js";

// ---------------------------------------------------------------------------
// 飞书开放 API（网络层可注入）

const FEISHU_ORIGIN = "https://open.feishu.cn";

/** 返回解析后的 JSON body；非 2xx 也应尽量返回 body 让上层报 code。 */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json: unknown }>;

export const defaultFetcher: Fetcher = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: await res.json() };
};

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  baseToken: string;
}

/** table_id 取自附录 A 摘录（未复核声明；有 live dump 后在此补 fld* 注释）。 */
const FEISHU_TABLES: { key: keyof FeishuDump; name: string; tableId: string }[] = [
  { key: "users", name: "团队成员", tableId: "tbl7HlE2tDnNCbwC" },
  { key: "channels", name: "渠道资产", tableId: "tblx3PGzNONP3Ugk" },
  { key: "products", name: "产品目录", tableId: "tblljYU2iuLOOb5F" },
  { key: "customers", name: "客户名单", tableId: "tblvKLGIHObVQ3dV" },
];

interface FeishuApiBody {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  data?: {
    items?: { record_id?: string; fields?: Record<string, unknown> }[];
    has_more?: boolean;
    page_token?: string;
  };
}

function assertOk(body: FeishuApiBody, ctx: string): void {
  if (typeof body.code !== "number" || body.code !== 0) {
    throw new Error(`飞书 API 失败（${ctx}）：code=${String(body.code)} msg=${String(body.msg)}`);
  }
}

export async function fetchTenantAccessToken(
  creds: FeishuCredentials,
  fetcher: Fetcher = defaultFetcher,
): Promise<string> {
  const { json } = await fetcher(`${FEISHU_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  const body = json as FeishuApiBody;
  assertOk(body, "tenant_access_token");
  if (typeof body.tenant_access_token !== "string" || body.tenant_access_token === "") {
    throw new Error("飞书 API 失败（tenant_access_token）：响应缺少 token");
  }
  return body.tenant_access_token;
}

async function fetchTableRecords(
  baseToken: string,
  tableId: string,
  token: string,
  fetcher: Fetcher,
): Promise<FeishuRecord[]> {
  const records: FeishuRecord[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `${FEISHU_ORIGIN}/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
    );
    url.searchParams.set("page_size", "500");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const { json } = await fetcher(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = json as FeishuApiBody;
    assertOk(body, `list records ${tableId}`);
    for (const item of body.data?.items ?? []) {
      if (typeof item.record_id !== "string" || item.record_id === "") continue;
      // fields 以字段中文名为键，原样交给 import-core 归一化
      records.push({ recordId: item.record_id, fields: item.fields ?? {} });
    }
    pageToken = body.data?.has_more ? body.data.page_token : undefined;
  } while (pageToken);
  return records;
}

/** 拉取四张主表（分页），返回与 CSV 回退一致的 FeishuDump。 */
export async function fetchFeishuDump(
  creds: FeishuCredentials,
  fetcher: Fetcher = defaultFetcher,
): Promise<FeishuDump> {
  const token = await fetchTenantAccessToken(creds, fetcher);
  const dump = { users: [], channels: [], products: [], customers: [] } as FeishuDump;
  for (const { key, tableId } of FEISHU_TABLES) {
    dump[key] = await fetchTableRecords(creds.baseToken, tableId, token, fetcher);
  }
  return dump;
}

// ---------------------------------------------------------------------------
// CLI

function parseCsvDirArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--from=csv") {
      const dir = argv[i + 1];
      if (!dir) throw new Error("--from=csv 需要目录参数");
      return dir;
    }
    if (arg.startsWith("--from=csv=")) return arg.slice("--from=csv=".length);
  }
  return null;
}

export async function runImport(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const scriptEnv = parseScriptEnv(env);
  const csvDir = parseCsvDirArg(argv);

  let dump: FeishuDump;
  if (csvDir !== null) {
    dump = loadCsvDump(csvDir);
    console.log(`source: csv ${csvDir}`);
  } else {
    if (!scriptEnv.FEISHU_APP_ID || !scriptEnv.FEISHU_APP_SECRET) {
      throw new Error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET；或用 --from=csv <dir> 走 CSV 回退");
    }
    dump = await fetchFeishuDump({
      appId: scriptEnv.FEISHU_APP_ID,
      appSecret: scriptEnv.FEISHU_APP_SECRET,
      baseToken: scriptEnv.FEISHU_BASE_TOKEN,
    });
    console.log(`source: feishu base ${scriptEnv.FEISHU_BASE_TOKEN}`);
  }

  const { sqlite, close } = createDb(scriptEnv.DATABASE_PATH);
  try {
    migrateDb(sqlite); // 幂等；保证脚本可直接灌新库
    const report = importDump(sqlite, dump);
    console.log(formatReport(report));
  } finally {
    close();
  }
}

// CLI 入口：pnpm --filter @gb-crm/api db:import [-- --from=csv <dir>]
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runImport(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
