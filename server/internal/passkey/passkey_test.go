package passkey

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/passkey/passkeytest"
)

func TestRPFromHost(t *testing.T) {
	ok := []struct {
		host  string
		https bool
		id    string
		orig  string
	}{
		{"localhost:8787", false, "localhost", "http://localhost:8787"},
		{"Notes.Example.com", true, "notes.example.com", "https://notes.example.com"},
		{"notes.example.com:8443", true, "notes.example.com", "https://notes.example.com:8443"},
		{"my-nas.local:8787", false, "my-nas.local", "http://my-nas.local:8787"},
	}
	for _, c := range ok {
		rp, err := RPFromHost(c.host, c.https)
		if err != nil || rp.ID != c.id || rp.Origin != c.orig {
			t.Errorf("RPFromHost(%q) = %+v, %v；期望 %s %s", c.host, rp, err, c.id, c.orig)
		}
	}
	for _, h := range []string{"", "192.168.1.10", "192.168.1.10:8787", "127.0.0.1:8787", "[::1]:8787", "::1", "bad host", "a/b"} {
		if _, err := RPFromHost(h, false); !errors.Is(err, ErrUnsupportedHost) {
			t.Errorf("RPFromHost(%q) 应返回 ErrUnsupportedHost，得到 %v", h, err)
		}
	}
}

func newService(t *testing.T) (*Service, RP) {
	t.Helper()
	d, err := db.Open(context.Background(), filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	rp, _ := RPFromHost("localhost:8787", false)
	return New(d, nil), rp
}

func jsonOf(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestCeremonyLifecycle(t *testing.T) {
	ctx := context.Background()
	s, rp := newService(t)
	a := passkeytest.New()

	cer, creation, err := s.BeginRegistration(ctx, rp, "电脑")
	if err != nil {
		t.Fatal(err)
	}
	opts := jsonOf(t, creation)
	// 要求可发现凭据和用户验证
	var parsed struct {
		PublicKey struct {
			AuthenticatorSelection struct {
				ResidentKey      string `json:"residentKey"`
				UserVerification string `json:"userVerification"`
			} `json:"authenticatorSelection"`
		} `json:"publicKey"`
	}
	_ = json.Unmarshal(opts, &parsed)
	if sel := parsed.PublicKey.AuthenticatorSelection; sel.ResidentKey != "required" || sel.UserVerification != "required" {
		t.Fatalf("登记选项 = %+v", sel)
	}
	cred, _ := a.Create(opts, rp.Origin)
	// 登记响应不能用于登录仪式
	if _, err := s.FinishLogin(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred))); !errors.Is(err, ErrNoCeremony) {
		t.Fatalf("类型不符的仪式应失效: %v", err)
	}
	// 上面的尝试已消耗了仪式
	if _, err := s.FinishRegistration(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred))); !errors.Is(err, ErrNoCeremony) {
		t.Fatalf("仪式只能使用一次: %v", err)
	}

	// 过期的仪式
	cer, creation, _ = s.BeginRegistration(ctx, rp, "电脑")
	cred, _ = a.Create(jsonOf(t, creation), rp.Origin)
	s.now = func() time.Time { return time.Now().Add(ceremonyTTL + time.Second) }
	if _, err := s.FinishRegistration(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred))); !errors.Is(err, ErrNoCeremony) {
		t.Fatalf("过期的仪式应失效: %v", err)
	}
	s.now = time.Now

	// 正常登记后，同一个认证器再次登记被排除列表挡在认证器一侧；服务端的排除列表包含它
	cer, creation, _ = s.BeginRegistration(ctx, rp, "电脑")
	cred, _ = a.Create(jsonOf(t, creation), rp.Origin)
	if _, err := s.FinishRegistration(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred))); err != nil {
		t.Fatal(err)
	}
	_, creation, _ = s.BeginRegistration(ctx, rp, "手机")
	if got := len(creation.Response.CredentialExcludeList); got != 1 {
		t.Fatalf("排除列表应含已登记的凭据，长度 = %d", got)
	}

	// 登录：用户句柄必须与服务端的一致
	cer, assertion, _ := s.BeginLogin(rp)
	bad := passkeytest.New()
	bad.UserHandle = []byte("someone-else")
	badCred, _ := bad.Get(jsonOf(t, assertion), rp.Origin)
	if _, err := s.FinishLogin(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(badCred))); !errors.Is(err, ErrVerify) {
		t.Fatalf("陌生的认证器应校验失败: %v", err)
	}
	cer, assertion, _ = s.BeginLogin(rp)
	good, _ := a.Get(jsonOf(t, assertion), rp.Origin)
	info, err := s.FinishLogin(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(good)))
	if err != nil || info.ID != a.ID() || info.LastUsedAt == 0 {
		t.Fatalf("登录 = %+v, %v", info, err)
	}
}

func TestPendingCeremoniesAreBounded(t *testing.T) {
	s, rp := newService(t)
	for i := 0; i < maxPending*3; i++ {
		if _, _, err := s.BeginLogin(rp); err != nil {
			t.Fatal(err)
		}
	}
	s.mu.Lock()
	n := len(s.pending)
	s.mu.Unlock()
	if n > maxPending {
		t.Fatalf("未完成的仪式应有上限 %d，实际 %d", maxPending, n)
	}
}

func TestClearAndAvailability(t *testing.T) {
	ctx := context.Background()
	s, rp := newService(t)
	if ok, _ := s.AvailableFor(ctx, rp.ID); ok {
		t.Fatal("还没登记")
	}
	for range 2 {
		cer, creation, _ := s.BeginRegistration(ctx, rp, "k")
		cred, _ := passkeytest.New().Create(jsonOf(t, creation), rp.Origin)
		if _, err := s.FinishRegistration(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred))); err != nil {
			t.Fatal(err)
		}
	}
	if ok, _ := s.AvailableFor(ctx, rp.ID); !ok {
		t.Fatal("已登记")
	}
	if ok, _ := s.AvailableFor(ctx, "other.example.com"); ok {
		t.Fatal("其它域名下没有")
	}
	if n, err := s.Clear(ctx); err != nil || n != 2 {
		t.Fatalf("Clear = %d, %v", n, err)
	}
	if list, _ := s.List(ctx); len(list) != 0 {
		t.Fatalf("清除后应为空: %v", list)
	}
}
