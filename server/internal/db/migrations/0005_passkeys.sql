-- 通行密钥（WebAuthn 凭据）。单用户，所以不分用户；可以登记多个，各自独立。
-- credential 是 webauthn.Credential 的 JSON（公钥、签名计数、标志位等），库升级后字段由库自己兼容；
-- extra 是预留的 JSON，供之后挂载每个通行密钥各自的附加数据（例如 PRF 包裹的主密钥，见 issue #29），
-- 现在恒为 '{}'。凭据按 rp_id 区分：通行密钥只在登记它的域名下可用。
CREATE TABLE passkeys (
    id           TEXT    PRIMARY KEY,           -- 凭据 ID 的 base64url
    name         TEXT    NOT NULL,
    rp_id        TEXT    NOT NULL,
    credential   TEXT    NOT NULL,
    extra        TEXT    NOT NULL DEFAULT '{}',
    created_at   INTEGER NOT NULL,              -- unix 毫秒
    last_used_at INTEGER NOT NULL DEFAULT 0     -- unix 毫秒；0 表示从未使用
) WITHOUT ROWID;
