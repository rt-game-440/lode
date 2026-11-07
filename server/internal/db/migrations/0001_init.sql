-- 笔记索引。num 是稳定的整数主键，供 FTS rowid 使用；id 是对外的稳定 id。
CREATE TABLE notes (
    num        INTEGER PRIMARY KEY,
    id         TEXT    NOT NULL UNIQUE,
    path       TEXT    NOT NULL UNIQUE,
    pkey       TEXT    NOT NULL UNIQUE, -- 小写、去掉 .md 的路径，用于链接解析和大小写不敏感查重
    base       TEXT    NOT NULL,        -- 小写、去掉 .md 的文件名
    rev        INTEGER NOT NULL,
    hash       TEXT    NOT NULL,
    size       INTEGER NOT NULL,
    mtime      INTEGER NOT NULL, -- 文件 mtime，unix 纳秒
    created_at INTEGER NOT NULL, -- unix 毫秒
    updated_at INTEGER NOT NULL  -- unix 毫秒
);
CREATE INDEX notes_base ON notes(base);

-- 全文索引：trigram 分词以支持中文。rowid = notes.num。
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tokenize = 'trigram');

-- 出链。target 是规范化后的目标（小写、去掉 .md 和 #标题）。
CREATE TABLE links (
    src_num INTEGER NOT NULL REFERENCES notes(num) ON DELETE CASCADE,
    target  TEXT    NOT NULL,
    line    INTEGER NOT NULL
);
CREATE INDEX links_target ON links(target);
CREATE INDEX links_src ON links(src_num);

CREATE TABLE tags (
    note_num INTEGER NOT NULL REFERENCES notes(num) ON DELETE CASCADE,
    tag      TEXT    NOT NULL,
    PRIMARY KEY (note_num, tag)
) WITHOUT ROWID;
CREATE INDEX tags_tag ON tags(tag);

-- 文件夹（包括空文件夹）。
CREATE TABLE folders (
    path TEXT PRIMARY KEY
) WITHOUT ROWID;

-- 历史版本：每次保存记一版。
CREATE TABLE versions (
    note_id    TEXT    NOT NULL,
    rev        INTEGER NOT NULL,
    content    TEXT    NOT NULL,
    hash       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    device_id  TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (note_id, rev)
) WITHOUT ROWID;

-- 全局变更序号。
CREATE TABLE changes (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id     TEXT    NOT NULL,
    type        TEXT    NOT NULL, -- upsert | move | delete
    path        TEXT    NOT NULL,
    rev         INTEGER NOT NULL,
    device_id   TEXT    NOT NULL DEFAULT '',
    device_name TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
);

-- 回收站。file 是 DATA_DIR/trash 下的文件名。
CREATE TABLE trash (
    id         TEXT    PRIMARY KEY, -- 原笔记 id，恢复时沿用
    orig_path  TEXT    NOT NULL,
    file       TEXT    NOT NULL,
    rev        INTEGER NOT NULL,
    hash       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE sessions (
    token_hash   TEXT    PRIMARY KEY,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent   TEXT    NOT NULL DEFAULT ''
) WITHOUT ROWID;
