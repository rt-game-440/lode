package keyprotect

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rt-game-440/lode/server/internal/agent"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/llm"
	"github.com/rt-game-440/lode/server/internal/passkey"
	"github.com/rt-game-440/lode/server/internal/passkey/passkeytest"
	"github.com/rt-game-440/lode/server/internal/secret"
)

// 只在测试里使用的假 key
const apiKey = "sk-mock-e2e-1234"

// env 是一个实例：数据目录、数据库，以及按“启动”构造的 Keeper、助手存储和保护服务。重启就是重新调用 boot。
type env struct {
	t     *testing.T
	dir   string
	db    *sql.DB
	pk    *passkey.Service
	rp    passkey.RP
	keys  *secret.Keeper
	store *agent.Store
	kp    *Service
}

func newEnv(t *testing.T, envKey string) *env {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	rp, _ := passkey.RPFromHost("localhost:8787", false)
	e := &env{t: t, dir: dir, db: d, pk: passkey.New(d, nil), rp: rp}
	e.boot(envKey)
	return e
}

// boot 模拟一次启动：按数据库里的开关决定主密钥的模式。
func (e *env) boot(envKey string) {
	e.t.Helper()
	ctx := context.Background()
	on, err := Enabled(ctx, e.db)
	if err != nil {
		e.t.Fatal(err)
	}
	keys, _, err := secret.OpenKeeper(envKey, e.dir, on)
	if err != nil {
		e.t.Fatal(err)
	}
	e.keys = keys
	e.store = agent.NewStore(e.db, keys)
	e.kp, err = New(ctx, e.db, keys, e.pk, e.store, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	e.pk.PRFSalt = e.kp.LoginSalt
}

func (e *env) register(a *passkeytest.Authenticator, name string) string {
	e.t.Helper()
	ctx := context.Background()
	cer, creation, err := e.pk.BeginRegistration(ctx, e.rp, name)
	if err != nil {
		e.t.Fatal(err)
	}
	opts, _ := json.Marshal(creation)
	cred, err := a.Create(opts, e.rp.Origin)
	if err != nil {
		e.t.Fatal(err)
	}
	res, err := e.pk.FinishRegistration(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred)))
	if err != nil {
		e.t.Fatal(err)
	}
	return res.ID
}

// prf 让 a 做一次限定凭据的验证，返回服务端拿到的 PRF 输出（认证器不支持时为 nil）。
func (e *env) prf(a *passkeytest.Authenticator) []byte {
	e.t.Helper()
	ctx := context.Background()
	cer, assertion, err := e.pk.BeginAssert(ctx, e.rp, []string{a.ID()}, e.kp.Salt(), "test")
	if err != nil {
		e.t.Fatal(err)
	}
	opts, _ := json.Marshal(assertion)
	cred, err := a.Get(opts, e.rp.Origin)
	if err != nil {
		e.t.Fatal(err)
	}
	res, err := e.pk.FinishAssert(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred)))
	if err != nil {
		e.t.Fatal(err)
	}
	return res.PRF
}

// login 用 a 做一次通行密钥登录并调用 AfterLogin。
func (e *env) login(a *passkeytest.Authenticator) bool {
	e.t.Helper()
	ctx := context.Background()
	cer, assertion, err := e.pk.BeginLogin(e.rp)
	if err != nil {
		e.t.Fatal(err)
	}
	opts, _ := json.Marshal(assertion)
	cred, _ := a.Get(opts, e.rp.Origin)
	res, err := e.pk.FinishLogin(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred)))
	if err != nil {
		e.t.Fatal(err)
	}
	return e.kp.AfterLogin(ctx, res.ID, res.PRF)
}

func (e *env) addProvider() string {
	e.t.Helper()
	k := apiKey
	p, err := e.store.CreateProvider(context.Background(), agent.ProviderInput{Name: "测试", Kind: llm.KindOpenAI, APIKey: &k})
	if err != nil {
		e.t.Fatal(err)
	}
	return p.ID
}

// key 返回助手调用供应商时拿到的 key。
func (e *env) key(id string) (string, error) {
	cfg, err := e.store.Config(context.Background(), id)
	return cfg.APIKey, err
}

func (e *env) status() Status {
	e.t.Helper()
	st, err := e.kp.Status(context.Background())
	if err != nil {
		e.t.Fatal(err)
	}
	return st
}

func (e *env) secretFile() (string, bool) {
	b, err := os.ReadFile(filepath.Join(e.dir, secret.FileName))
	return strings.TrimSpace(string(b)), err == nil
}

// scan 检查数据目录里的所有文件都不含 needle。
func (e *env) scan(needle string) {
	e.t.Helper()
	filepath.WalkDir(e.dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, _ := os.ReadFile(p)
		if bytes.Contains(b, []byte(needle)) {
			e.t.Errorf("%s 里出现了不该有的内容", p)
		}
		return nil
	})
}

func TestEnableRestartUnlockDisable(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, "")
	a, b := passkeytest.New(), passkeytest.New()
	noPRF := passkeytest.New()
	noPRF.NoPRF = true
	e.register(a, "电脑")
	e.register(b, "手机")
	e.register(noPRF, "旧安全密钥")
	pid := e.addProvider()
	oldMaster, ok := e.secretFile()
	if !ok {
		t.Fatal("默认应有 secret.key")
	}
	if st := e.status(); !st.Available || st.Enabled {
		t.Fatalf("初始状态 = %+v", st)
	}

	// 不支持 PRF 的通行密钥不能用来开启
	if p := e.prf(noPRF); p != nil {
		t.Fatal("不支持 PRF 的认证器不应给出输出")
	}
	if err := e.kp.Enable(ctx, noPRF.ID(), nil); !errors.Is(err, ErrNoPRF) {
		t.Fatalf("应返回 ErrNoPRF：%v", err)
	}

	// 开启：secret.key 删除，主密钥换新，已保存的 key 改用新主密钥加密
	if err := e.kp.Enable(ctx, a.ID(), e.prf(a)); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.secretFile(); ok {
		t.Fatal("开启后不应再有 secret.key")
	}
	if st := e.status(); !st.Enabled || !st.Unlocked || st.Wrapped != 1 {
		t.Fatalf("开启后状态 = %+v", st)
	}
	if k, err := e.key(pid); err != nil || k != apiKey {
		t.Fatalf("开启后助手仍能拿到 key：%q %v", k, err)
	}
	var enc string
	e.db.QueryRow(`SELECT key_enc FROM llm_providers WHERE id = ?`, pid).Scan(&enc)
	if _, err := secret.New(oldMaster).Open(enc, pid); err == nil {
		t.Fatal("旧的 secret.key（比如以前的备份里的）不应还能解开开启后的 key")
	}
	if err := e.kp.Enable(ctx, a.ID(), e.prf(a)); !errors.Is(err, ErrEnabled) {
		t.Fatalf("重复开启：%v", err)
	}
	e.scan(apiKey)
	e.scan(oldMaster)

	// 重启：锁定，助手拿不到 key，也不能保存新 key
	e.boot("")
	if st := e.status(); !st.Enabled || st.Unlocked {
		t.Fatalf("重启后应锁定：%+v", st)
	}
	if _, err := e.key(pid); !errors.Is(err, secret.ErrLocked) {
		t.Fatalf("锁定时应返回 ErrLocked：%v", err)
	}
	k2 := "sk-mock-e2e-1234-x"
	if _, err := e.store.CreateProvider(ctx, agent.ProviderInput{Name: "x", Kind: llm.KindOpenAI, APIKey: &k2}); !errors.Is(err, agent.ErrInvalid) || !strings.Contains(err.Error(), "已锁定") {
		t.Fatalf("锁定时保存 key 应给出明确提示：%v", err)
	}

	// 错误的凭据：没加入保护的通行密钥、PRF 输出不一致的同一凭据
	if err := e.kp.Unlock(ctx, b.ID(), e.prf(b)); !errors.Is(err, ErrNotEnrolled) {
		t.Fatalf("没加入保护的通行密钥：%v", err)
	}
	wrong := *a
	wrong.PRFKey = bytes.Repeat([]byte{1}, 32)
	if err := e.kp.Unlock(ctx, a.ID(), e.prf(&wrong)); !errors.Is(err, ErrUnwrap) {
		t.Fatalf("PRF 输出不一致：%v", err)
	}
	if e.login(b) {
		t.Fatal("没加入保护的通行密钥登录不能解锁")
	}
	if !e.status().Enabled || e.status().Unlocked || e.status().Wrapped != 1 {
		t.Fatal("锁定时登录不应把通行密钥加入保护")
	}

	// 用加入保护的通行密钥登录：解锁，助手能拿到 key
	if !e.login(a) {
		t.Fatal("用加入保护的通行密钥登录应解锁")
	}
	if k, err := e.key(pid); err != nil || k != apiKey {
		t.Fatalf("解锁后：%q %v", k, err)
	}

	// 已解锁时，另一个通行密钥登录会顺便加入保护；也可以显式加入
	if !e.login(b) || e.status().Wrapped != 2 {
		t.Fatalf("已解锁时登录应把通行密钥加入保护：%+v", e.status())
	}
	if err := e.kp.Enroll(ctx, noPRF.ID(), e.prf(noPRF)); !errors.Is(err, ErrNoPRF) {
		t.Fatalf("不支持 PRF 的通行密钥不能加入：%v", err)
	}

	// 立即锁定后，用新加入的通行密钥也能解锁
	if err := e.kp.Lock(); err != nil {
		t.Fatal(err)
	}
	if err := e.kp.Enroll(ctx, a.ID(), e.prf(a)); !errors.Is(err, ErrLocked) {
		t.Fatalf("锁定时不能加入：%v", err)
	}
	if err := e.kp.Unlock(ctx, b.ID(), e.prf(b)); err != nil {
		t.Fatal(err)
	}

	// 关闭：主密钥写回 secret.key，重启后照常可用
	if _, err := e.kp.Disable(ctx, false); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.secretFile(); !ok {
		t.Fatal("关闭后应恢复 secret.key")
	}
	if st := e.status(); st.Enabled || st.Wrapped != 0 {
		t.Fatalf("关闭后状态 = %+v", st)
	}
	e.boot("")
	if e.keys.Mode() != secret.ModeFile {
		t.Fatalf("关闭后重启应是 file 模式：%v", e.keys.Mode())
	}
	if k, err := e.key(pid); err != nil || k != apiKey {
		t.Fatalf("关闭后已存的 key 不丢：%q %v", k, err)
	}
	if e.kp.LoginSalt() != nil {
		t.Fatal("关闭后登录不再请求 PRF")
	}
}

func TestDisableWhileLocked(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, "")
	a := passkeytest.New()
	e.register(a, "a")
	pid := e.addProvider()
	if err := e.kp.Enable(ctx, a.ID(), e.prf(a)); err != nil {
		t.Fatal(err)
	}
	e.boot("")
	if _, err := e.kp.Disable(ctx, false); !errors.Is(err, ErrLocked) {
		t.Fatalf("锁定时不放弃 key 就不能关闭：%v", err)
	}
	n, err := e.kp.Disable(ctx, true)
	if err != nil || n != 1 {
		t.Fatalf("放弃 key 并关闭 = %d %v", n, err)
	}
	if _, ok := e.secretFile(); !ok || e.keys.Mode() != secret.ModeFile {
		t.Fatal("应生成新的 secret.key 并回到 file 模式")
	}
	p, _ := e.store.Provider(ctx, pid)
	if p.HasKey {
		t.Fatal("找不回的 key 应清除，让用户重新填写")
	}
	k := apiKey
	if _, err := e.store.UpdateProvider(ctx, pid, agent.ProviderInput{Name: "测试", Kind: llm.KindOpenAI, APIKey: &k}); err != nil {
		t.Fatal(err)
	}
	if got, err := e.key(pid); err != nil || got != apiKey {
		t.Fatalf("重新填写后可用：%q %v", got, err)
	}
}

func TestUnavailableWithEnvKey(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, "e2e-only-secret-key")
	a := passkeytest.New()
	e.register(a, "a")
	if st := e.status(); st.Available || st.Reason != "env" {
		t.Fatalf("设置了 LODE_SECRET_KEY 时应不可用：%+v", st)
	}
	if err := e.kp.Enable(ctx, a.ID(), e.prf(a)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("应返回 ErrUnavailable：%v", err)
	}
}

func TestDeletingLastWrappedPasskey(t *testing.T) {
	ctx := context.Background()
	for _, locked := range []bool{false, true} {
		e := newEnv(t, "")
		a, b := passkeytest.New(), passkeytest.New()
		e.register(a, "a")
		e.register(b, "b")
		pid := e.addProvider()
		if err := e.kp.Enable(ctx, a.ID(), e.prf(a)); err != nil {
			t.Fatal(err)
		}
		if last, _ := e.kp.LastWrapped(ctx, b.ID()); last {
			t.Fatal("b 没加入保护，删除它不影响")
		}
		if last, _ := e.kp.LastWrapped(ctx, a.ID()); !last {
			t.Fatal("a 是唯一能解锁的通行密钥")
		}
		if locked {
			e.boot("")
		}
		if err := e.pk.Delete(ctx, a.ID()); err != nil {
			t.Fatal(err)
		}
		off, n, err := e.kp.AfterDelete(ctx)
		if err != nil || !off {
			t.Fatalf("删掉最后一个后应自动关闭：%v %v", off, err)
		}
		k, err := e.key(pid)
		switch {
		case !locked && (err != nil || k != apiKey || n != 0):
			t.Fatalf("已解锁时关闭应保留 key：%q %v %d", k, err, n)
		case locked && (n != 1 || k != ""):
			t.Fatalf("锁定时 key 找不回来，应清除：%q %d", k, n)
		}
		if _, ok := e.secretFile(); !ok {
			t.Fatal("关闭后应有 secret.key")
		}
	}
}

func TestResetOffline(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t, "")
	a := passkeytest.New()
	e.register(a, "a")
	pid := e.addProvider()
	if err := e.kp.Enable(ctx, a.ID(), e.prf(a)); err != nil {
		t.Fatal(err)
	}
	// lode reset-password --clear-passkeys：服务已停止
	if _, err := e.pk.Clear(ctx); err != nil {
		t.Fatal(err)
	}
	on, n, err := ResetOffline(ctx, e.db, agent.NewStore(e.db, nil))
	if err != nil || !on || n != 1 {
		t.Fatalf("ResetOffline = %v %d %v", on, n, err)
	}
	e.boot("")
	if e.keys.Mode() != secret.ModeFile {
		t.Fatal("重置后启动应回到 secret.key")
	}
	if p, _ := e.store.Provider(ctx, pid); p.HasKey {
		t.Fatal("找不回的 key 应清除")
	}
	if on, _, _ := ResetOffline(ctx, e.db, e.store); on {
		t.Fatal("未开启时什么都不做")
	}
}
