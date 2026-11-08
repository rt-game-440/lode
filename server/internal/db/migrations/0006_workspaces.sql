-- 多工作空间（docs/workspaces.md 第 3、7 节）。
-- 工作空间登记表只在全局库 app.db 里有意义；index.db 跑同一套迁移，会多一张没人读的表。
-- vault_dir 为空表示内置位置：默认工作空间是 data/vault，其他是 data/workspaces/<id>/vault；
-- 否则是外部目录的绝对路径。
CREATE TABLE workspaces (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    vault_dir  TEXT    NOT NULL DEFAULT '',
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL             -- unix 毫秒
) WITHOUT ROWID;

-- 默认工作空间自动登记，原有 data/vault 和 app.db 原地不动。只写常量，不读其他表（见 db 包注释）。
INSERT INTO workspaces(id, name, vault_dir, sort, created_at)
VALUES ('default', '笔记', '', 0, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));

-- MCP token 绑定一个工作空间（#59 使用），已有 token 属于默认工作空间。
ALTER TABLE api_tokens ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';

-- 审计日志记录调用发生在哪个工作空间（#59 使用）。
ALTER TABLE audit_log ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
