import path from "node:path";

import { defineConfig } from "@playwright/test";

// 冒烟（K28：不挡合并）。webServer 起生产模式 api（:3101），种子库由 run-server.sh 重建。
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3101",
  },
  webServer: {
    command: "bash run-server.sh",
    cwd: path.dirname(new URL(import.meta.url).pathname),
    url: "http://127.0.0.1:3101/api/v1/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
