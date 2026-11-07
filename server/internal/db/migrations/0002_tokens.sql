-- API token：供 MCP 和脚本使用。只存 SHA-256 哈希，明文只在创建时返回一次。
CREATE TABLE api_tokens (
    id           TEXT    PRIMARY KEY,
    name         TEXT    NOT NULL,
    scope        TEXT    NOT NULL,           -- read | write
    token_hash   TEXT    NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,           -- unix 毫秒
    last_used_at INTEGER NOT NULL DEFAULT 0  -- unix 毫秒；0 表示从未使用
) WITHOUT ROWID;

-- MCP 调用审计日志，只保留最近约 1000 条。
CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL, -- unix 毫秒
    token_id   TEXT    NOT NULL,
    token_name TEXT    NOT NULL,
    tool       TEXT    NOT NULL,
    target     TEXT    NOT NULL DEFAULT '', -- 涉及的路径（或查询词、标签）
    ok         INTEGER NOT NULL,
    error      TEXT    NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0
);
