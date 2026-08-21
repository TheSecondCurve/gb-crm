// 每个测试一个临时 sqlite 文件（os.tmpdir + 随机名），跑完 migration 后返回。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDb, type DbHandle } from "../../src/db/client.js";
import { migrateDb } from "../../src/db/migrate.js";

export interface TmpDb extends DbHandle {
  dbPath: string;
  cleanup: () => void;
}

export function createTmpDb(): TmpDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-crm-test-"));
  const dbPath = path.join(dir, "test.sqlite");
  const handle = createDb(dbPath);
  migrateDb(handle.sqlite);

  let closed = false;
  return {
    ...handle,
    dbPath,
    cleanup: () => {
      if (closed) return;
      closed = true;
      handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
