package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rt-game-440/lode/server/internal/agent"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/keyprotect"
	"github.com/rt-game-440/lode/server/internal/passkey"
	"github.com/rt-game-440/lode/server/internal/passkey/passkeytest"
	"github.com/rt-game-440/lode/server/internal/secret"
)

// kpEnv 是一份跨“重启”保留的数据：数据库（通行密钥、助手配置）和数据目录（secret.key）。
// 每次 newPasskeyClient(t, e.option()) 都相当于用这份数据重新启动一次服务。
type kpEnv struct {
	t      *testing.T
	dir    string
	db     *sql.DB
	envKey string
	logs   *lockedBuffer
}

func newKPEnv(t *testing.T, envKey string) *kpEnv {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return &kpEnv{t: t, dir: dir, db: d, envKey: envKey, logs: &lockedBuffer{}}
}

// option 按 main.go 的顺序组装：读开关 → 打开 Keeper → 助手存储 → 通行密钥 → 保护服务。
func (e *kpEnv) option() func(*Server) {
	return func(s *Server) {
		ctx := context.Background()
		log := slog.New(slog.NewTextHandler(e.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
		on, err := keyprotect.Enabled(ctx, e.db)
		if err != nil {
			e.t.Fatal(err)
		}
		keys, _, err := secret.OpenKeeper(e.envKey, e.dir, on)
		if err != nil {
			e.t.Fatal(err)
		}
		store := agent.NewStore(e.db, keys)
		s.Log = log
		s.Agent = &agent.Service{Store: store, Log: log}
		e.t.Cleanup(s.Agent.Close)
		s.Passkeys = passkey.New(e.db, log)
		kp, err := keyprotect.New(ctx, e.db, keys, s.Passkeys, store, log)
		if err != nil {
			e.t.Fatal(err)
		}
		s.Passkeys.PRFSalt = kp.LoginSalt
		s.KeyProtect = kp
	}
}

func (e *kpEnv) hasSecretFile() bool {
	_, err := os.Stat(filepath.Join(e.dir, secret.FileName))
	return err == nil
}

func (e *kpEnv) salt() []byte {
	var v string
	if err := e.db.QueryRow(`SELECT value FROM settings WHERE key = 'key_protection_salt'`).Scan(&v); err != nil {
		e.t.Fatal(err)
	}
	b, _ := base64.RawURLEncoding.DecodeString(v)
	return b
}

// kpStatus 读取 GET /api/key-protection。
func (c *pkClient) kpStatus() map[string]any {
	c.t.Helper()
	st, body, raw := c.call("GET", "/api/key-protection", "", nil, nil, nil)
	if st != 200 {
		c.t.Fatalf("读取保护状态 = %d %s", st, raw)
	}
	return body["key_protection"].(map[string]any)
}

// kpVerify 走一遍 begin → 认证器 → finish，返回 finish 的状态码和响应。
func (c *pkClient) kpVerify(a *passkeytest.Authenticator, action, passkeyID string) (int, map[string]any) {
	c.t.Helper()
	st, body, raw := c.call("POST", "/api/key-protection/begin", "", map[string]string{"action": action, "passkey": passkeyID}, nil, nil)
	if st != 200 {
		return st, body
	}
	cer, opts := optionsOf(c.t, raw)
	cred, err := a.Get(opts, c.origin())
	if err != nil {
		c.t.Fatalf("%s：认证器拒绝了验证：%v", action, err)
	}
	st, body, _ = c.call("POST", "/api/key-protection/finish?ceremony="+cer, "", nil, cred, nil)
	return st, body
}

func (c *pkClient) mustVerify(a *passkeytest.Authenticator, action, passkeyID string) map[string]any {
	c.t.Helper()
	st, body := c.kpVerify(a, action, passkeyID)
	if st != 200 {
		c.t.Fatalf("%s = %d %v", action, st, body)
	}
	return body["key_protection"].(map[string]any)
}

// providerTest 调用供应商的“测试连接”，返回状态码和原始响应。
func (c *pkClient) providerTest(id string) (int, string) {
	c.t.Helper()
	st, _, raw := c.call("POST", "/api/agent/providers/"+id+"/test", "", nil, nil, nil)
	return st, string(raw)
}

func (c *pkClient) addProvider(baseURL, key string) string {
	c.t.Helper()
	st, body, raw := c.call("POST", "/api/agent/providers", "", map[string]any{"name": "本地", "kind": "openai", "base_url": baseURL, "api_key": key}, nil, nil)
	if st != 201 {
		c.t.Fatalf("新建供应商 = %d %s", st, raw)
	}
	return body["id"].(string)
}

func wantCode(t *testing.T, what string, st int, body map[string]any, wantSt int, code string) {
	t.Helper()
	if st != wantSt || body["code"] != code {
		t.Fatalf("%s = %d %v，应为 %d %s", what, st, body, wantSt, code)
	}
}

func TestKeyProtectionLifecycle(t *testing.T) {
	const key = "sk-mock-e2e-1234"
	llmSrv := fakeOpenAI(t, key)
	e := newKPEnv(t, "")

	c := newPasskeyClient(t, e.option())
	c.setup()
	a := passkeytest.New()
	noPRF := passkeytest.New()
	noPRF.NoPRF = true
	aID := c.register(a, "电脑")
	nID := c.register(noPRF, "旧安全密钥")
	pid := c.addProvider(llmSrv.URL+"/v1", key)
	if !e.hasSecretFile() {
		t.Fatal("默认应生成 secret.key")
	}
	if st := c.kpStatus(); st["available"] != true || st["enabled"] != false {
		t.Fatalf("初始状态 = %v", st)
	}

	// 登记时只探测 PRF：列表里标出是否支持
	_, list, _ := c.call("GET", "/api/passkeys", "", nil, nil, nil)
	for _, p := range list["passkeys"].([]any) {
		m := p.(map[string]any)
		if want := m["id"] == aID; m["prf"] != want || m["key_wrapped"] != false {
			t.Fatalf("登记后的 PRF 标记不对：%v", m)
		}
	}

	// 不支持 PRF 的通行密钥不能开启；不能开启时 secret.key 原样保留
	st, body := c.kpVerify(noPRF, "enable", nID)
	wantCode(t, "用不支持 PRF 的通行密钥开启", st, body, 400, "prf_unsupported")
	if !e.hasSecretFile() {
		t.Fatal("开启失败时不应删除 secret.key")
	}

	// 开启
	if st := c.mustVerify(a, "enable", ""); st["enabled"] != true || st["unlocked"] != true || st["wrapped"] != float64(1) {
		t.Fatalf("开启后状态 = %v", st)
	}
	if e.hasSecretFile() {
		t.Fatal("开启后数据目录里不应再有 secret.key")
	}
	if st, raw := c.providerTest(pid); st != 200 || !strings.Contains(raw, `"ok":true`) {
		t.Fatalf("开启后助手照常可用：%d %s", st, raw)
	}
	st, body = c.kpVerify(a, "enable", "")
	wantCode(t, "重复开启", st, body, 409, "already_enabled")

	// 重启：锁定
	c = newPasskeyClient(t, e.option())
	c.setup()
	if st := c.kpStatus(); st["enabled"] != true || st["unlocked"] != false {
		t.Fatalf("重启后应锁定：%v", st)
	}
	_, cfg, _ := c.call("GET", "/api/agent/config", "", nil, nil, nil)
	if cfg["keys_locked"] != true || cfg["secret_key_set"] != true {
		t.Fatalf("助手配置应标出已锁定：%v", cfg)
	}
	st, body, _ = c.call("POST", "/api/agent/providers/"+pid+"/test", "", nil, nil, nil)
	wantCode(t, "锁定时测试连接", st, body, 409, "keys_locked")
	if msg, _ := body["message"].(string); !strings.Contains(msg, "锁定") || !strings.Contains(msg, "通行密钥") {
		t.Fatalf("锁定时的提示应说明原因和解法：%q", msg)
	}
	st, body, _ = c.call("PUT", "/api/agent/providers/"+pid, "", map[string]any{"name": "本地", "kind": "openai", "base_url": llmSrv.URL + "/v1", "api_key": key + "-x"}, nil, nil)
	if st != 400 || !strings.Contains(body["message"].(string), "已锁定") {
		t.Fatalf("锁定时保存 key 应给出明确提示：%d %v", st, body)
	}
	st, body = c.kpVerify(a, "enroll", aID)
	wantCode(t, "锁定时加入保护", st, body, 409, "keys_locked")

	// 用错误的 PRF（同一凭据、不同的 PRF 密钥）解锁失败
	wrong := *a
	wrong.PRFKey = []byte("0123456789abcdef0123456789abcdef")
	st, body = c.kpVerify(&wrong, "unlock", "")
	wantCode(t, "错误的 PRF 输出解锁", st, body, 400, "unwrap_failed")
	a.SignCount = wrong.SignCount

	// 通行密钥登录即解锁
	c.logout()
	if st, body := c.login(a, c.origin()); st != 204 {
		t.Fatalf("通行密钥登录 = %d %v", st, body)
	}
	if st := c.kpStatus(); st["unlocked"] != true {
		t.Fatalf("登录后应解锁：%v", st)
	}
	if st, raw := c.providerTest(pid); st != 200 || !strings.Contains(raw, `"ok":true`) {
		t.Fatalf("解锁后助手可用：%d %s", st, raw)
	}

	// 已解锁时新登记的通行密钥：登记就给出 PRF 的直接加入；只报告 enabled 的再验证一次加入
	b := passkeytest.New()
	bID := c.register(b, "手机")
	cc := passkeytest.New()
	cc.PRFAtCreate = true
	st, body, raw := c.call("POST", "/api/passkeys/begin", "", map[string]string{"name": "平板"}, nil, nil)
	cer, opts := optionsOf(t, raw)
	cred, _ := cc.Create(opts, c.origin())
	st, body, _ = c.call("POST", "/api/passkeys/finish?ceremony="+cer, "", nil, cred, nil)
	if p := body["passkey"].(map[string]any); st != 201 || p["key_wrapped"] != true {
		t.Fatalf("登记时给出 PRF 的通行密钥应直接加入保护：%d %v", st, body)
	}
	if st := c.kpStatus(); st["wrapped"] != float64(2) {
		t.Fatalf("加入后应有 2 个：%v", st)
	}
	if st := c.mustVerify(b, "enroll", bID); st["wrapped"] != float64(3) {
		t.Fatalf("再验证一次加入：%v", st)
	}
	st, body = c.kpVerify(noPRF, "enroll", nID)
	wantCode(t, "不支持 PRF 的通行密钥加入", st, body, 400, "prf_unsupported")

	// 立即锁定，用后加入的通行密钥解锁
	if st, body, _ := c.call("POST", "/api/key-protection/lock", "", nil, nil, nil); st != 200 || body["key_protection"].(map[string]any)["unlocked"] != false {
		t.Fatalf("锁定 = %d %v", st, body)
	}
	c.mustVerify(b, "unlock", "")

	// 删除：不是最后一个时直接删；最后一个要确认，确认后自动关闭保护，已解锁则 key 保留
	for _, id := range []string{aID, bID} {
		if st, body, _ := c.call("DELETE", "/api/passkeys/"+id, "", nil, nil, nil); st != 204 {
			t.Fatalf("删除 %s = %d %v", id, st, body)
		}
	}
	ccID := cc.ID()
	st, body, _ = c.call("DELETE", "/api/passkeys/"+ccID, "", nil, nil, nil)
	wantCode(t, "删除最后一个能解锁的通行密钥", st, body, 409, "last_key_passkey")
	if st, body, _ := c.call("DELETE", "/api/passkeys/"+ccID+"?force=1", "", nil, nil, nil); st != 204 {
		t.Fatalf("确认删除 = %d %v", st, body)
	}
	if st := c.kpStatus(); st["enabled"] != false || st["wrapped"] != float64(0) {
		t.Fatalf("删除最后一个后应自动关闭：%v", st)
	}
	if !e.hasSecretFile() {
		t.Fatal("自动关闭后应恢复 secret.key")
	}
	c = newPasskeyClient(t, e.option())
	c.setup()
	if st, raw := c.providerTest(pid); st != 200 || !strings.Contains(raw, `"ok":true`) {
		t.Fatalf("关闭后重启，已保存的 key 不丢：%d %s", st, raw)
	}

	// 日志里不能出现 PRF 输出
	salt := e.salt()
	for _, au := range []*passkeytest.Authenticator{a, b, cc} {
		out := au.PRF(salt)
		for _, enc := range []string{base64.RawURLEncoding.EncodeToString(out), base64.StdEncoding.EncodeToString(out), hex.EncodeToString(out)} {
			if strings.Contains(e.logs.String(), enc) {
				t.Fatal("日志里出现了 PRF 输出")
			}
		}
	}
	if strings.Contains(e.logs.String(), key) {
		t.Fatal("日志里出现了明文 key")
	}
}

func TestKeyProtectionDisable(t *testing.T) {
	const key = "sk-mock-e2e-1234"
	llmSrv := fakeOpenAI(t, key)
	e := newKPEnv(t, "")
	c := newPasskeyClient(t, e.option())
	c.setup()
	a := passkeytest.New()
	c.register(a, "电脑")
	pid := c.addProvider(llmSrv.URL+"/v1", key)
	c.mustVerify(a, "enable", "")

	// 已解锁时关闭：主密钥写回 secret.key，key 保留
	st, body, _ := c.call("POST", "/api/key-protection/disable", "", map[string]any{}, nil, nil)
	if st != 200 || body["cleared_keys"] != float64(0) || body["key_protection"].(map[string]any)["enabled"] != false {
		t.Fatalf("关闭 = %d %v", st, body)
	}
	if !e.hasSecretFile() {
		t.Fatal("关闭后应恢复 secret.key")
	}
	c = newPasskeyClient(t, e.option())
	c.setup()
	if st, raw := c.providerTest(pid); st != 200 || !strings.Contains(raw, `"ok":true`) {
		t.Fatalf("关闭后重启照常可用：%d %s", st, raw)
	}

	// 再开启后重启（锁定）：不放弃 key 就不能关闭；放弃则清除 key
	c.mustVerify(a, "enable", "")
	c = newPasskeyClient(t, e.option())
	c.setup()
	st, body, _ = c.call("POST", "/api/key-protection/disable", "", map[string]any{}, nil, nil)
	wantCode(t, "锁定时关闭", st, body, 409, "keys_locked")
	st, body, _ = c.call("POST", "/api/key-protection/disable", "", map[string]any{"discard": true}, nil, nil)
	if st != 200 || body["cleared_keys"] != float64(1) {
		t.Fatalf("放弃 key 并关闭 = %d %v", st, body)
	}
	_, cfg, _ := c.call("GET", "/api/agent/config", "", nil, nil, nil)
	if p := cfg["providers"].([]any)[0].(map[string]any); p["has_key"] != false || cfg["keys_locked"] != false {
		t.Fatalf("放弃后 key 应清除、不再锁定：%v", cfg)
	}
}

func TestKeyProtectionUnavailableWithEnvKey(t *testing.T) {
	e := newKPEnv(t, "e2e-only-secret-key")
	c := newPasskeyClient(t, e.option())
	c.setup()
	a := passkeytest.New()
	c.register(a, "电脑")
	if st := c.kpStatus(); st["available"] != false || st["reason"] != "env" {
		t.Fatalf("设置了 LODE_SECRET_KEY 时应不可用：%v", st)
	}
	st, body := c.kpVerify(a, "enable", "")
	wantCode(t, "env 模式下开启", st, body, 409, "env_secret_key")
	st, body = c.kpVerify(a, "unlock", "")
	wantCode(t, "未开启时解锁", st, body, 409, "not_enabled")
}

func TestKeyProtectionRequiresSession(t *testing.T) {
	e := newKPEnv(t, "")
	c := newPasskeyClient(t, e.option())
	c.setup()
	c.logout()
	for _, p := range []string{"/api/key-protection/begin", "/api/key-protection/finish", "/api/key-protection/lock", "/api/key-protection/disable"} {
		if st, _, _ := c.call("POST", p, "", map[string]any{}, nil, nil); st != 401 {
			t.Errorf("%s 未登录 = %d", p, st)
		}
	}
	if st, _, _ := c.call("GET", "/api/key-protection", "", nil, nil, nil); st != 401 {
		t.Errorf("状态接口未登录 = %d", st)
	}
}
