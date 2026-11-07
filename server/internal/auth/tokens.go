package auth

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// API token 的权限。
const (
	ScopeRead  = "read"  // 只读：搜索、读取、列出
	ScopeWrite = "write" // 读写：另外可以新建、修改、移动、删除笔记
)

// TokenPrefix 是 API token 明文的前缀，便于在配置文件和日志里辨认（也方便密钥扫描工具识别）。
const TokenPrefix = "lode_"

var (
	// ErrInvalidToken 表示 token 不存在、已吊销或格式错误。
	ErrInvalidToken = errors.New("invalid token")
	// ErrTokenNotFound 表示要吊销的 token 不存在。
	ErrTokenNotFound = errors.New("token not found")
	// ErrInvalidTokenInput 表示创建 token 的名称或权限不合法。
	ErrInvalidTokenInput = errors.New("invalid token input")
)

// APIToken 是 API token 的元数据（不含明文）。
type APIToken struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Scope      string `json:"scope"`
	CreatedAt  int64  `json:"created_at"`   // unix 毫秒
	LastUsedAt int64  `json:"last_used_at"` // unix 毫秒；0 表示从未使用
}

// CanWrite 判断 token 是否有写权限。
func (t APIToken) CanWrite() bool { return t.Scope == ScopeWrite }

// CreateToken 创建 API token，返回元数据和明文。明文只在这里出现一次，库里只存 SHA-256 哈希：
// token 含 32 字节随机数，熵足够高，不需要慢哈希。
func (a *Auth) CreateToken(ctx context.Context, name, scope string) (APIToken, string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 64 || (scope != ScopeRead && scope != ScopeWrite) {
		return APIToken{}, "", ErrInvalidTokenInput
	}
	secret := TokenPrefix + randomToken(32)
	t := APIToken{ID: randomToken(9), Name: name, Scope: scope, CreatedAt: a.now().UnixMilli()}
	_, err := a.db.ExecContext(ctx, `INSERT INTO api_tokens(id, name, scope, token_hash, created_at) VALUES (?,?,?,?,?)`,
		t.ID, t.Name, t.Scope, hashToken(secret), t.CreatedAt)
	if err != nil {
		return APIToken{}, "", err
	}
	return t, secret, nil
}

// ListTokens 按创建时间倒序列出全部 token。
func (a *Auth) ListTokens(ctx context.Context) ([]APIToken, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT id, name, scope, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIToken{}
	for rows.Next() {
		var t APIToken
		if err := rows.Scan(&t.ID, &t.Name, &t.Scope, &t.CreatedAt, &t.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// RevokeToken 吊销（删除）token，之后用它的请求立即被拒绝。
func (a *Auth) RevokeToken(ctx context.Context, id string) error {
	res, err := a.db.ExecContext(ctx, `DELETE FROM api_tokens WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrTokenNotFound
	}
	return nil
}

// VerifyToken 校验明文 token，有效时返回其元数据并记录最后使用时间（每分钟最多写一次库）。
func (a *Auth) VerifyToken(ctx context.Context, secret string) (APIToken, error) {
	if !strings.HasPrefix(secret, TokenPrefix) {
		return APIToken{}, ErrInvalidToken
	}
	var t APIToken
	err := a.db.QueryRowContext(ctx, `SELECT id, name, scope, created_at, last_used_at FROM api_tokens WHERE token_hash = ?`,
		hashToken(secret)).Scan(&t.ID, &t.Name, &t.Scope, &t.CreatedAt, &t.LastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return APIToken{}, ErrInvalidToken
	}
	if err != nil {
		return APIToken{}, err
	}
	now := a.now().UnixMilli()
	if now-t.LastUsedAt >= time.Minute.Milliseconds() {
		if _, err := a.db.ExecContext(ctx, `UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, now, t.ID); err == nil {
			t.LastUsedAt = now
		}
	}
	return t, nil
}
