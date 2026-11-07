-- 阶段 5：Agent 助手。API key 用 AES-GCM 加密后存 key_enc，明文不落库；key_last4 用于界面辨认。
CREATE TABLE llm_providers (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    kind       TEXT    NOT NULL,             -- openai | anthropic | gemini
    base_url   TEXT    NOT NULL DEFAULT '',  -- 空表示官方地址
    key_enc    TEXT    NOT NULL DEFAULT '',
    key_last4  TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE llm_models (
    id             TEXT    PRIMARY KEY,
    provider_id    TEXT    NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
    model          TEXT    NOT NULL,              -- 供应商的模型 ID
    name           TEXT    NOT NULL DEFAULT '',   -- 显示名
    enabled        INTEGER NOT NULL DEFAULT 1,
    context_window INTEGER NOT NULL,
    max_output     INTEGER NOT NULL,
    reasoning      INTEGER NOT NULL DEFAULT 0,    -- 是否支持推理强度
    effort         TEXT    NOT NULL DEFAULT 'medium',
    modalities     TEXT    NOT NULL DEFAULT '["text"]', -- JSON 数组：text image pdf audio
    tools          INTEGER NOT NULL DEFAULT 1,
    temperature    REAL,                          -- NULL 表示不发送
    created_at     INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX llm_models_provider ON llm_models(provider_id);

CREATE TABLE agent_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE agent_chats (
    id             TEXT    PRIMARY KEY,
    title          TEXT    NOT NULL DEFAULT '',
    model_id       TEXT    NOT NULL DEFAULT '',  -- llm_models.id
    effort         TEXT    NOT NULL DEFAULT '',  -- 本对话的推理强度覆盖，空表示用模型默认
    input_tokens   INTEGER NOT NULL DEFAULT 0,   -- 累计
    output_tokens  INTEGER NOT NULL DEFAULT 0,   -- 累计
    context_tokens INTEGER NOT NULL DEFAULT 0,   -- 最近一次请求的输入 token
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX agent_chats_updated ON agent_chats(updated_at DESC);

CREATE TABLE agent_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id       TEXT    NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE,
    role          TEXT    NOT NULL,              -- user | assistant
    parts         TEXT    NOT NULL,              -- JSON：llm.Part 数组
    meta          TEXT    NOT NULL DEFAULT '{}', -- JSON：@ 的笔记、是否被停止等
    model         TEXT    NOT NULL DEFAULT '',   -- 生成这条消息的模型 ID
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
);
CREATE INDEX agent_messages_chat ON agent_messages(chat_id, id);

-- 等待用户批准的写操作。
CREATE TABLE agent_pending (
    chat_id    TEXT    NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE,
    call_id    TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    args       TEXT    NOT NULL,
    preview    TEXT    NOT NULL, -- JSON：操作、路径、diff
    created_at INTEGER NOT NULL,
    UNIQUE (chat_id, call_id)
);
