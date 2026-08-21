import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      // 门禁覆盖范围见设计文档 §10 / K28；PR 1 阶段这些目录尚无实现文件，
      // 空 include 时各项指标记为 100%，阈值不会被误伤；后续 PR 按业务填满。
      include: ["src/modules/**", "src/plugins/**", "src/lib/**", "src/db/**"],
      // schema.ts 是镜像 drizzle/0000_init.sql 的纯声明文件；其 FK 回调只被 drizzle-kit 等
      // 工具惰性调用，运行时不执行，而表级行为（CHECK / partial unique / FK）已在 SQL 层实测。
      exclude: ["src/db/schema.ts"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
