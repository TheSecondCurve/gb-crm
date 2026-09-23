#!/usr/bin/env node
// e2e 报告汇总：读取 Playwright JSON 报告（e2e/report/results.json），
// 生成 e2e/report/summary.md 并在控制台输出摘要；退出码 = 失败用例数（>0 即非零）。
// 用法：npx playwright test --config e2e/playwright.config.ts 之后 node e2e/scripts/report.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const jsonPath = path.join(e2eRoot, "report", "results.json");
const summaryPath = path.join(e2eRoot, "report", "summary.md");

if (!fs.existsSync(jsonPath)) {
  console.error(`[e2e-report] 未找到 ${jsonPath} —— 先运行 playwright test`);
  process.exit(2);
}

const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const suites = report.suites ?? [];

/** 拍平 spec 树 → 用例列表 */
function collect(suiteList, prefix = "") {
  const out = [];
  for (const s of suiteList) {
    const title = prefix ? `${prefix} › ${s.title}` : s.title;
    for (const sp of s.suites ?? []) out.push(...collect([sp], title));
    for (const sp of s.specs ?? []) {
      for (const t of sp.tests ?? []) {
        out.push({
          suite: title,
          title: sp.title,
          ok: t.results?.every((r) => r.status === "passed") ?? false,
          duration: (t.results ?? []).reduce((a, r) => a + (r.duration ?? 0), 0),
          retries: (t.results ?? []).filter((r) => r.status === "retry").length,
          error: t.results?.find((r) => r.status !== "passed")?.error?.message?.split("\n")[0] ?? null,
        });
      }
    }
  }
  return out;
}

const cases = collect(suites);
const passed = cases.filter((c) => c.ok);
const failed = cases.filter((c) => !c.ok);
const totalMs = cases.reduce((a, c) => a + c.duration, 0);

const lines = [];
lines.push(`# gb-crm E2E 测试报告`);
lines.push(``);
lines.push(`- 生成时间：${new Date().toISOString()}`);
lines.push(`- 服务：生产模式 API（:3101）+ 种子库全量重建（apps/api/scripts/e2e-seed.ts）`);
lines.push(`- 结果：**${passed.length} 通过 / ${failed.length} 失败 / 共 ${cases.length} 用例**，耗时 ${(totalMs / 1000).toFixed(1)}s`);
lines.push(``);
if (failed.length > 0) {
  lines.push(`## ❌ 失败用例`);
  lines.push(``);
  for (const c of failed) {
    lines.push(`- **${c.suite} › ${c.title}**`);
    if (c.error) lines.push(`  - ${c.error}`);
  }
  lines.push(``);
}
lines.push(`## ✅ 通过用例`);
lines.push(``);
for (const c of passed) lines.push(`- ${c.suite} › ${c.title}（${(c.duration / 1000).toFixed(1)}s）`);
lines.push(``);
lines.push(`## 查看细节`);
lines.push(``);
lines.push(`- 交互式 HTML 报告：\`e2e/report/html/index.html\``);
lines.push(`- 失败用例的 trace/截图：\`e2e/test-results/\`（Playwright trace viewer 打开 *.zip）`);

const md = lines.join("\n");
fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, md);

console.log(`[e2e-report] ${passed.length} passed, ${failed.length} failed, ${cases.length} total (${(totalMs / 1000).toFixed(1)}s)`);
console.log(`[e2e-report] summary: ${summaryPath}`);
if (failed.length > 0) {
  console.log(`[e2e-report] 失败用例：`);
  for (const c of failed) console.log(`  ✗ ${c.suite} › ${c.title}${c.error ? ` — ${c.error}` : ""}`);
}
process.exit(failed.length > 0 ? 1 : 0);
