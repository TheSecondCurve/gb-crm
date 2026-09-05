#!/usr/bin/env python3
"""重生成 SKILL.md 各表的「列名/类型」表（含义列保留手写内容，新列标 —）。

用法:
  python3 gen-schema.py [sqlite路径]      # 默认 ./data/gb-crm.sqlite（相对仓库根）

脚本扫描 SKILL.md 中的 <!-- SCHEMA:<table> --> ... <!-- /SCHEMA:<table> --> 区块，
用 sqlite `PRAGMA table_info` 重建每表的 列名/类型/PK/非空，并保留该表已写的「含义」列。
- 新增列自动出现（含义暂时为「—」，去 SKILL.md 补一句即可）；
- 删除列自动消失；
- 非文档化表（如 FTS 虚表、无标记的表）不动。

需要先跑过 migration 的 sqlite（仓库 data/gb-crm.sqlite，或任一生效库）。
"""
from __future__ import annotations

import pathlib
import re
import sqlite3
import sys

REPO = pathlib.Path(__file__).resolve().parents[3]
SKILL_PATH = REPO / "skills" / "gb-crm" / "SKILL.md"
DEFAULT_DB = REPO / "data" / "gb-crm.sqlite"

TABLE_RE = re.compile(r"<!-- SCHEMA:(\w+) -->(.*?)<!-- /SCHEMA:\1 -->", re.S)
# 表格数据行：| 列 | 类型 | 含义 |
ROW_RE = re.compile(r"^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$")


def parse_meanings(block: str) -> dict[str, str]:
    """从当前 markdown 表格提取 列名 → 含义（跳过表头/分隔行）。

    兼容「一列放多个列名」的写法（如 `username / password_hash`）：
    按 ` / ` 拆开，把同一含义赋给每个列，避免重生成后含义丢失。
    """
    meanings: dict[str, str] = {}
    for line in block.splitlines():
        m = ROW_RE.match(line)
        if not m:
            continue
        cols = [c.strip() for c in m.group(1).split("/")]
        meaning = m.group(3).strip()
        for col in cols:
            if col in ("列", "---", "--"):
                continue
            meanings[col] = meaning
    return meanings


def gen_table(db: sqlite3.Connection, table: str, meanings: dict[str, str]) -> str:
    """PRAGMA table_info → markdown 表格；含义保留手写，新列用「—」。"""
    try:
        rows = db.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.OperationalError:
        return ""
    lines = ["| 列 | 类型 | 含义 |", "| --- | --- | --- |"]
    for _cid, name, typ, notnull, _dflt, pk in rows:
        t = typ
        if pk:
            t += " PK"
        if notnull:
            t += " NOT NULL"
        meaning = meanings.get(name, "—")
        lines.append(f"| {name} | {t} | {meaning} |")
    return "\n".join(lines)


def main() -> int:
    db_path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DB
    if not db_path.is_file():
        print(f"找不到数据库: {db_path}（先跑 npm run db:migrate）", file=sys.stderr)
        return 2
    if not SKILL_PATH.is_file():
        print(f"找不到 SKILL.md: {SKILL_PATH}", file=sys.stderr)
        return 2

    text = SKILL_PATH.read_text(encoding="utf-8")
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)

    def repl(m: re.Match) -> str:
        table = m.group(1)
        meanings = parse_meanings(m.group(2))
        body = gen_table(db, table, meanings)
        if not body:
            print(f"警告: 表 {table} 不存在于库中，跳过", file=sys.stderr)
            return m.group(0)
        return f"<!-- SCHEMA:{table} -->\n{body}\n<!-- /SCHEMA:{table} -->"

    updated, n = TABLE_RE.subn(repl, text)
    db.close()
    if n == 0:
        print("SKILL.md 里没有找到 <!-- SCHEMA:... --> 标记", file=sys.stderr)
        return 2
    SKILL_PATH.write_text(updated, encoding="utf-8")
    print(f"已更新 {n} 张表结构")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
