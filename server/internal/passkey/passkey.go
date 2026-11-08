// Package passkey 实现通行密钥（WebAuthn）的登记与登录仪式，以及凭据存储。
//
// 服务是单用户的：只有一个固定的用户句柄，所有凭据都属于它。登录用“可发现凭据”（discoverable credential），
// 浏览器直接列出本域名下的通行密钥，用户不用先输入用户名。
//
// RP ID 和 origin 从请求推导（见 RPFromHost），每次仪式单独构造 webauthn 实例，仪式开始时的
// RP ID/origin 存进仪式记录，完成时沿用，所以登记和登录都被绑定在同一个 origin 上。
package passkey

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

var (
	// ErrUnsupportedHost 表示当前访问地址不能用通行密钥（IP 地址、不合法的域名）。
	ErrUnsupportedHost = errors.New("passkeys need a domain name")
	// ErrNoCeremony 表示仪式不存在或已过期，需要重新开始。
	ErrNoCeremony = errors.New("ceremony expired")
	// ErrVerify 表示认证器的响应没有通过校验。
	ErrVerify = errors.New("passkey verification failed")
	// ErrNotFound 表示通行密钥不存在。
	ErrNotFound = errors.New("passkey not found")
	// ErrInvalidName 表示名称为空或过长。
	ErrInvalidName = errors.New("invalid passkey name")
)

// MaxNameLen 是通行密钥名称的最大长度（按字符计）。
const MaxNameLen = 64

const (
	ceremonyTTL = 5 * time.Minute
	maxPending  = 64 // 同时进行的仪式上限，防止未完成的 begin 请求撑大内存
	rpName      = "Lode"
	userName    = "lode"
	handleKey   = "passkey_user_handle"
)

// RP 是一次仪式的依赖方：ID 是域名（不含端口），Origin 是浏览器地址栏里的源（含协议和端口）。
type RP struct {
	ID     string
	Origin string
}

// RPFromHost 由请求的 Host（可含端口）和协议推导 RP。IP 地址不能作为 RP ID，返回 ErrUnsupportedHost。
func RPFromHost(host string, https bool) (RP, error) {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return RP{}, ErrUnsupportedHost
	}
	name := h
	if hh, _, err := net.SplitHostPort(h); err == nil {
		name = hh
	}
	name = strings.TrimSuffix(strings.Trim(name, "[]"), ".")
	if protocol.ValidateRPID(name) != nil {
		return RP{}, ErrUnsupportedHost
	}
	scheme := "http"
	if https {
		scheme = "https"
	}
	return RP{ID: name, Origin: scheme + "://" + h}, nil
}

// Info 是返回给前端的通行密钥信息，不含密钥材料。
type Info struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	CreatedAt  int64  `json:"created_at"`
	LastUsedAt int64  `json:"last_used_at"` // 0 表示从未使用
}

// Service 管理通行密钥。
type Service struct {
	db  *sql.DB
	log *slog.Logger
	now func() time.Time

	// RegistrationOptions 和 LoginOptions 追加到每次仪式的选项里，是加扩展的入口：
	// #29 在这里加 webauthn.WithExtensions(webauthn.WithExtensionPRFSupport()) 等 PRF 选项，
	// 把 PRF 结果用于包裹每个通行密钥各自的 API key 主密钥（存在 passkeys.extra）。
	RegistrationOptions []webauthn.RegistrationOption
	LoginOptions        []webauthn.LoginOption

	mu      sync.Mutex
	pending map[string]*ceremony
}

type ceremony struct {
	kind    string // register | login
	rp      RP
	session webauthn.SessionData
	name    string
	expires time.Time
}

// New 创建服务。
func New(db *sql.DB, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{db: db, log: log, now: time.Now, pending: map[string]*ceremony{}}
}

// ---- 用户 ----

type user struct {
	handle []byte
	creds  []webauthn.Credential
}

func (u *user) WebAuthnID() []byte                         { return u.handle }
func (u *user) WebAuthnName() string                       { return userName }
func (u *user) WebAuthnDisplayName() string                { return rpName }
func (u *user) WebAuthnCredentials() []webauthn.Credential { return u.creds }

func (s *Service) userHandle(ctx context.Context) ([]byte, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, handleKey).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		// 并发时以先写入的为准
		if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)`,
			handleKey, base64.RawURLEncoding.EncodeToString(b)); err != nil {
			return nil, err
		}
		err = s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, handleKey).Scan(&v)
	}
	if err != nil {
		return nil, err
	}
	return base64.RawURLEncoding.DecodeString(v)
}

// credentials 返回某个 RP ID 下登记的全部凭据。
func (s *Service) credentials(ctx context.Context, rpID string) ([]webauthn.Credential, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT credential FROM passkeys WHERE rp_id = ? ORDER BY created_at`, rpID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []webauthn.Credential
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var c webauthn.Credential
		if err := json.Unmarshal([]byte(raw), &c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func newWebAuthn(rp RP) (*webauthn.WebAuthn, error) {
	return webauthn.New(&webauthn.Config{RPID: rp.ID, RPDisplayName: rpName, RPOrigins: []string{rp.Origin}})
}

// ---- 仪式记录 ----

func (s *Service) put(c *ceremony) string {
	b := make([]byte, 18)
	_, _ = rand.Read(b)
	id := base64.RawURLEncoding.EncodeToString(b)
	now := s.now()
	c.expires = now.Add(ceremonyTTL)
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.pending {
		if now.After(v.expires) {
			delete(s.pending, k)
		}
	}
	for len(s.pending) >= maxPending { // 仍然太多：丢弃最早的
		var oldest string
		for k, v := range s.pending {
			if oldest == "" || v.expires.Before(s.pending[oldest].expires) {
				oldest = k
			}
		}
		delete(s.pending, oldest)
	}
	s.pending[id] = c
	return id
}

// take 取出并删除仪式记录（每个仪式只能完成一次，失败后要重新开始）。
func (s *Service) take(id, kind string) (*ceremony, error) {
	s.mu.Lock()
	c, ok := s.pending[id]
	delete(s.pending, id)
	s.mu.Unlock()
	if !ok || c.kind != kind || s.now().After(c.expires) {
		return nil, ErrNoCeremony
	}
	return c, nil
}

// ---- 登记 ----

// BeginRegistration 开始登记，返回仪式 ID 和交给 navigator.credentials.create 的选项。
// 要求可发现凭据和用户验证（指纹、面容或 PIN），已登记过的凭据列入排除列表，避免同一个认证器重复登记。
func (s *Service) BeginRegistration(ctx context.Context, rp RP, name string) (string, *protocol.CredentialCreation, error) {
	name, err := cleanName(name)
	if err != nil {
		return "", nil, err
	}
	w, err := newWebAuthn(rp)
	if err != nil {
		return "", nil, fmt.Errorf("%w: %v", ErrUnsupportedHost, err)
	}
	h, err := s.userHandle(ctx)
	if err != nil {
		return "", nil, err
	}
	creds, err := s.credentials(ctx, rp.ID)
	if err != nil {
		return "", nil, err
	}
	exclude := make([]protocol.CredentialDescriptor, 0, len(creds))
	for _, c := range creds {
		exclude = append(exclude, c.Descriptor())
	}
	opts := []webauthn.RegistrationOption{
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			RequireResidentKey: protocol.ResidentKeyRequired(),
			UserVerification:   protocol.VerificationRequired,
		}),
		webauthn.WithExclusions(exclude),
		webauthn.WithRegistrationOrigin(rp.Origin),
	}
	opts = append(opts, s.RegistrationOptions...)
	creation, session, err := w.BeginRegistration(&user{handle: h, creds: creds}, opts...)
	if err != nil {
		return "", nil, err
	}
	id := s.put(&ceremony{kind: "register", rp: rp, session: *session, name: name})
	return id, creation, nil
}

// FinishRegistration 校验认证器返回的新凭据（请求体是 PublicKeyCredential 的 JSON）并保存。
func (s *Service) FinishRegistration(ctx context.Context, id string, r *http.Request) (Info, error) {
	c, err := s.take(id, "register")
	if err != nil {
		return Info{}, err
	}
	w, err := newWebAuthn(c.rp)
	if err != nil {
		return Info{}, err
	}
	h, err := s.userHandle(ctx)
	if err != nil {
		return Info{}, err
	}
	cred, err := w.FinishRegistration(&user{handle: h}, c.session, r)
	if err != nil {
		s.log.Debug("通行密钥登记校验失败", "err", err)
		return Info{}, fmt.Errorf("%w: %v", ErrVerify, err)
	}
	raw, err := json.Marshal(cred)
	if err != nil {
		return Info{}, err
	}
	now := s.now().UnixMilli()
	info := Info{ID: base64.RawURLEncoding.EncodeToString(cred.ID), Name: c.name, CreatedAt: now}
	_, err = s.db.ExecContext(ctx, `INSERT INTO passkeys(id, name, rp_id, credential, created_at) VALUES (?,?,?,?,?)`,
		info.ID, info.Name, c.rp.ID, string(raw), now)
	if err != nil {
		return Info{}, err
	}
	return info, nil
}

// ---- 登录 ----

// BeginLogin 开始登录，返回仪式 ID 和交给 navigator.credentials.get 的选项。
// 不限定 allowCredentials：浏览器列出本域名下的通行密钥让用户选。
func (s *Service) BeginLogin(rp RP) (string, *protocol.CredentialAssertion, error) {
	w, err := newWebAuthn(rp)
	if err != nil {
		return "", nil, fmt.Errorf("%w: %v", ErrUnsupportedHost, err)
	}
	opts := []webauthn.LoginOption{
		webauthn.WithUserVerification(protocol.VerificationRequired),
		webauthn.WithLoginOrigin(rp.Origin),
	}
	opts = append(opts, s.LoginOptions...)
	assertion, session, err := w.BeginDiscoverableLogin(opts...)
	if err != nil {
		return "", nil, err
	}
	id := s.put(&ceremony{kind: "login", rp: rp, session: *session})
	return id, assertion, nil
}

// FinishLogin 校验认证器的签名（请求体是 PublicKeyCredential 的 JSON）。通过时更新签名计数和最后使用时间。
func (s *Service) FinishLogin(ctx context.Context, id string, r *http.Request) (Info, error) {
	c, err := s.take(id, "login")
	if err != nil {
		return Info{}, err
	}
	w, err := newWebAuthn(c.rp)
	if err != nil {
		return Info{}, err
	}
	h, err := s.userHandle(ctx)
	if err != nil {
		return Info{}, err
	}
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		if subtle.ConstantTimeCompare(userHandle, h) != 1 {
			return nil, errors.New("unknown user handle")
		}
		creds, err := s.credentials(ctx, c.rp.ID)
		if err != nil {
			return nil, err
		}
		return &user{handle: h, creds: creds}, nil
	}
	cred, err := w.FinishDiscoverableLogin(handler, c.session, r)
	if err != nil {
		s.log.Debug("通行密钥登录校验失败", "err", err)
		return Info{}, fmt.Errorf("%w: %v", ErrVerify, err)
	}
	pid := base64.RawURLEncoding.EncodeToString(cred.ID)
	if cred.Authenticator.CloneWarning {
		// 签名计数没有递增：凭据可能被复制。有密码兜底，只记录不拒绝。
		s.log.Warn("通行密钥的签名计数异常，凭据可能被复制", "id", pid)
	}
	raw, err := json.Marshal(cred)
	if err != nil {
		return Info{}, err
	}
	now := s.now().UnixMilli()
	if _, err := s.db.ExecContext(ctx, `UPDATE passkeys SET credential = ?, last_used_at = ? WHERE id = ?`, string(raw), now, pid); err != nil {
		return Info{}, err
	}
	return s.get(ctx, pid)
}

// ---- 管理 ----

// List 返回全部通行密钥，按创建时间排序。
func (s *Service) List(ctx context.Context) ([]Info, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Info{}
	for rows.Next() {
		var i Info
		if err := rows.Scan(&i.ID, &i.Name, &i.CreatedAt, &i.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (s *Service) get(ctx context.Context, id string) (Info, error) {
	var i Info
	err := s.db.QueryRowContext(ctx, `SELECT id, name, created_at, last_used_at FROM passkeys WHERE id = ?`, id).
		Scan(&i.ID, &i.Name, &i.CreatedAt, &i.LastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Info{}, ErrNotFound
	}
	return i, err
}

// Delete 删除一个通行密钥；删除后它不能再用于登录。
func (s *Service) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM passkeys WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Clear 删除全部通行密钥（lode reset-password --clear-passkeys 使用），返回删除的数量。
func (s *Service) Clear(ctx context.Context) (int, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM passkeys`)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// AvailableFor 判断该 RP ID 下是否有已登记的通行密钥（登录页据此决定是否显示通行密钥按钮）。
func (s *Service) AvailableFor(ctx context.Context, rpID string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM passkeys WHERE rp_id = ?`, rpID).Scan(&n)
	return n > 0, err
}

func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > MaxNameLen {
		return "", ErrInvalidName
	}
	return name, nil
}
