import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      // 门禁覆盖范围见设计文档 §10 / K28；PR 1 阶段这些目录尚无实现文件，
      // 空 include 时各项指标记为 100%，阈值不会被误伤；后续 PR 按业务填满。
      include: ["src/modules/**", "src/plugins/**", "src/lib/**", "src/db/**"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
