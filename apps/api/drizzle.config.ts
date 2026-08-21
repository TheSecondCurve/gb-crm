// drizzle-kit 配置：schema 以 src/db/schema.ts 为准生成对照，
// 但 migration 以 drizzle/ 下手写 SQL 为准（设计要求：generate 后人工对齐，不盲信 generator）。
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
