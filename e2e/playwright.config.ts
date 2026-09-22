import path from "node:path";

import { defineConfig } from "@playwright/test";

// e2e 套件：webServer 起生产模式 api（:3101），种子库由 run-server.sh 每次重建。
// 失败留证：trace + 截图只在失败时保留（outputDir 下的 *.zip / *.png 随报告产物上传 CI）。
// 并发收敛为 2 workers：登录限流 10 次/分钟/IP，过多并行登录会触发 429 造成伪失败。
export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  timeout: 30_000,
  retries: 0,
  workers: 2,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [["github"], ["json", { outputFile: "report/results.json" }]]
    : [["list"], ["html", { outputFolder: "report/html", open: "never" }], ["json", { outputFile: "report/results.json" }]],
  use: {
    baseURL: "http://127.0.0.1:3101",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "zh-CN",
  },
  webServer: {
    command: "bash run-server.sh",
    cwd: path.dirname(new URL(import.meta.url).pathname),
    url: "http://127.0.0.1:3101/api/v1/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
