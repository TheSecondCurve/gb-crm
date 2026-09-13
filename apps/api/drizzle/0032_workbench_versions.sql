-- 2026-09 产品决策（K61）：工作台快照分发（gb-content 系统层经 CRM 以 HTTP 快照发到成员机）。
-- workbench_versions：发布版本（不可变记录）。文件体不入库——按内容寻址存 S3
-- （{prefix}workbench/objects/<sha256>），本表只存 manifest（每文件 path/sha256/size/mode）。
-- 无 updated_* /软删：版本是分发日志而非业务记录，滚动保留 WORKBENCH_VERSIONS_KEEP 份，
-- 超出的硬删（语义同备份滚动清理）；被删版本独占的对象由发布时 GC 尽力删除。

CREATE TABLE workbench_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_sha TEXT NOT NULL,                -- 发布时 gb-content 的 HEAD commit（7~40 hex）
  commit_subject TEXT,                     -- HEAD commit subject（更新说明默认值）
  note TEXT,                               -- 发布备注（可覆盖 subject）
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,            -- Σ 文件字节数（未压缩）
  manifest_json TEXT NOT NULL,             -- {"v":1,"files":[{path,sha256,size,mode}]}（按 path 排序）
  published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at INTEGER NOT NULL            -- epoch ms UTC
);

CREATE INDEX workbench_versions_published_idx ON workbench_versions(published_at);
