// Package auth 实现单用户鉴权：首启设密码（argon2id）、会话、登录失败限速。
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"runtime/debug"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

var (
	// ErrAlreadyInitialized 表示密码已设置过。
	ErrAlreadyInitialized = errors.New("already initialized")
	// ErrNotInitialized 表示尚未设置密码。
	ErrNotInitialized = errors.New("not initialized")
	// ErrBadPassword 表示密码错误。
	ErrBadPassword = errors.New("wrong password")
	// ErrWeakPassword 表示密码不满足最低要求。
	ErrWeakPassword = errors.New("password too short")
)

// MinPasswordLen 是密码最短长度（按字符计）。
const MinPasswordLen = 8

// SessionTTL 是会话有效期（每次使用会顺延）。
const SessionTTL = 30 * 24 * time.Hour

// argon2id 参数：OWASP 推荐的低内存配置（19 MiB, t=2, p=1），适合 512MB 内存的机器。
const (
	argonMemory  = 19 * 1024
	argonTime    = 2
	argonThreads = 1
	argonKeyLen  = 32
)

// Auth 管理密码与会话。
type Auth struct {
	db      *sql.DB
	now     func() time.Time
	Limiter *Limiter
}

// New 创建 Auth。
func New(db *sql.DB) *Auth {
	return &Auth{db: db, now: time.Now, Limiter: NewLimiter(5, time.Minute, time.Minute)}
}

// Initialized 判断是否已设置密码。
func (a *Auth) Initialized(ctx context.Context) (bool, error) {
	var n int
	err := a.db.QueryRowContext(ctx, `SELECT count(*) FROM settings WHERE key = 'password_hash'`).Scan(&n)
	return n > 0, err
}

// Setup 首次设置密码。已设置过时返回 ErrAlreadyInitialized。
func (a *Auth) Setup(ctx context.Context, password string) error {
	if len([]rune(password)) < MinPasswordLen {
		return ErrWeakPassword
	}
	h, err := HashPassword(password)
	if err != nil {
		return err
	}
	res, err := a.db.ExecContext(ctx, `INSERT OR IGNORE INTO settings(key, value) VALUES ('password_hash', ?)`, h)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrAlreadyInitialized
	}
	return nil
}

// SetPassword 直接重置密码并吊销所有会话（用于 reset-password 子命令）。
func (a *Auth) SetPassword(ctx context.Context, password string) error {
	if len([]rune(password)) < MinPasswordLen {
		return ErrWeakPassword
	}
	h, err := HashPassword(password)
	if err != nil {
		return err
	}
	if _, err := a.db.ExecContext(ctx, `INSERT OR REPLACE INTO settings(key, value) VALUES ('password_hash', ?)`, h); err != nil {
		return err
	}
	_, err = a.db.ExecContext(ctx, `DELETE FROM sessions`)
	return err
}

// CheckPassword 校验密码。
func (a *Auth) CheckPassword(ctx context.Context, password string) error {
	var h string
	err := a.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = 'password_hash'`).Scan(&h)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotInitialized
	}
	if err != nil {
		return err
	}
	ok, err := VerifyPassword(password, h)
	if err != nil {
		return err
	}
	if !ok {
		return ErrBadPassword
	}
	return nil
}

// CreateSession 创建会话，返回写入 cookie 的明文 token；库里只存哈希。
func (a *Auth) CreateSession(ctx context.Context, userAgent string) (string, time.Time, error) {
	token := randomToken(32)
	now := a.now()
	exp := now.Add(SessionTTL)
	_, err := a.db.ExecContext(ctx, `INSERT INTO sessions(token_hash, created_at, expires_at, last_seen_at, user_agent) VALUES (?,?,?,?,?)`,
		hashToken(token), now.UnixMilli(), exp.UnixMilli(), now.UnixMilli(), truncate(userAgent, 200))
	return token, exp, err
}

// ValidateSession 校验会话 token，有效时顺延过期时间（每小时最多写一次库）。
func (a *Auth) ValidateSession(ctx context.Context, token string) (bool, error) {
	if token == "" {
		return false, nil
	}
	h := hashToken(token)
	var exp, last int64
	err := a.db.QueryRowContext(ctx, `SELECT expires_at, last_seen_at FROM sessions WHERE token_hash = ?`, h).Scan(&exp, &last)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	now := a.now()
	if now.UnixMilli() > exp {
		_, _ = a.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, h)
		return false, nil
	}
	if now.UnixMilli()-last > time.Hour.Milliseconds() {
		_, _ = a.db.ExecContext(ctx, `UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?`,
			now.UnixMilli(), now.Add(SessionTTL).UnixMilli(), h)
	}
	return true, nil
}

// DeleteSession 注销会话。
func (a *Auth) DeleteSession(ctx context.Context, token string) error {
	_, err := a.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, hashToken(token))
	return err
}

// PurgeExpired 清理过期会话。
func (a *Auth) PurgeExpired(ctx context.Context) error {
	_, err := a.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < ?`, a.now().UnixMilli())
	return err
}

// HashPassword 用 argon2id 生成 PHC 格式的哈希串。
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	defer debug.FreeOSMemory() // argon2 临时占用约 19MB，尽快归还给系统
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword 校验密码与 PHC 格式哈希串是否匹配。
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("无法识别的密码哈希格式")
	}
	var m uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, err
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(want)))
	defer debug.FreeOSMemory()
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

// truncate 最多保留 n 个字节，且不切断 UTF-8 字符。
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// Limiter 是登录失败限速器：窗口内失败 max 次后锁定 lock 时长。按客户端（IP）分别计数。
type Limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	lock   time.Duration
	now    func() time.Time
	state  map[string]*limitState
}

type limitState struct {
	failures    []time.Time
	lockedUntil time.Time
}

// NewLimiter 创建限速器。
func NewLimiter(max int, window, lock time.Duration) *Limiter {
	return &Limiter{max: max, window: window, lock: lock, now: time.Now, state: map[string]*limitState{}}
}

// Allow 判断该客户端当前能否尝试登录；不能时返回需要等待的时长。
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	st := l.state[key]
	if st == nil {
		return true, 0
	}
	now := l.now()
	if now.Before(st.lockedUntil) {
		return false, st.lockedUntil.Sub(now)
	}
	return true, 0
}

// Fail 记录一次失败；达到阈值时锁定并返回 true。
func (l *Limiter) Fail(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	st := l.state[key]
	if st == nil {
		st = &limitState{}
		l.state[key] = st
	}
	kept := st.failures[:0]
	for _, t := range st.failures {
		if now.Sub(t) < l.window {
			kept = append(kept, t)
		}
	}
	st.failures = append(kept, now)
	if len(st.failures) >= l.max {
		st.lockedUntil = now.Add(l.lock)
		st.failures = nil
		return true
	}
	// 顺手清理长期不用的条目，防止内存增长
	if len(l.state) > 1000 {
		for k, v := range l.state {
			if len(v.failures) == 0 && now.After(v.lockedUntil) {
				delete(l.state, k)
			}
		}
	}
	return false
}

// Success 清除该客户端的失败记录。
func (l *Limiter) Success(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.state, key)
}
