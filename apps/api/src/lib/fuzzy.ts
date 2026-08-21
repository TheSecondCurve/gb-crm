// 模糊搜索（§9）：q 按空白切 token，token 之间 AND、字段之间 OR；
// LIKE 模式转义 `\` `%` `_`，用 ESCAPE '\' 声明转义符。
// 返回 drizzle where 片段；q 为空（或全空白）→ undefined（不加条件）。
import { and, or, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export function fuzzyTokens(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean);
}

/** LIKE 模式转义：`\` `%` `_` 前补 `\`（配合 ESCAPE '\'） */
export function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function fuzzyWhere(q: string, columns: readonly AnySQLiteColumn[]): SQL | undefined {
  const tokens = fuzzyTokens(q);
  if (tokens.length === 0 || columns.length === 0) return undefined;
  const perToken = tokens.map((token) => {
    const pattern = `%${escapeLike(token)}%`;
    return or(...columns.map((col) => sql`${col} LIKE ${pattern} ESCAPE '\\'`));
  });
  return and(...perToken);
}
