package passkey

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/rt-game-440/lode/server/internal/passkey/passkeytest"
)

// prfInput 取出选项里的 extensions.prf（没有时为 nil）。
func prfInput(t *testing.T, opts []byte) map[string]any {
	t.Helper()
	var o struct {
		PublicKey struct {
			Extensions map[string]any `json:"extensions"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(opts, &o); err != nil {
		t.Fatal(err)
	}
	p, _ := o.PublicKey.Extensions["prf"].(map[string]any)
	return p
}

func register(t *testing.T, s *Service, rp RP, a *passkeytest.Authenticator, name string) Result {
	t.Helper()
	ctx := context.Background()
	cer, creation, err := s.BeginRegistration(ctx, rp, name)
	if err != nil {
		t.Fatal(err)
	}
	cred, err := a.Create(jsonOf(t, creation), rp.Origin)
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.FinishRegistration(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred)))
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestPRFRegistrationAndLogin(t *testing.T) {
	ctx := context.Background()
	s, rp := newService(t)
	salt := bytes.Repeat([]byte{9}, 32)

	// 未开启保护：登记仍然请求 PRF（只探测），登录不请求
	_, creation, _ := s.BeginRegistration(ctx, rp, "x")
	if p := prfInput(t, jsonOf(t, creation)); p == nil || p["eval"] != nil {
		t.Fatalf("登记应请求 PRF 但不带盐：%v", p)
	}
	_, assertion, _ := s.BeginLogin(rp)
	if p := prfInput(t, jsonOf(t, assertion)); p != nil {
		t.Fatalf("未开启保护时登录不应请求 PRF：%v", p)
	}

	a := passkeytest.New()
	res := register(t, s, rp, a, "支持 PRF")
	if res.PRF != nil || res.Info.PRF == nil || !*res.Info.PRF {
		t.Fatalf("登记时只报告 enabled，不给输出：PRF=%v info.PRF=%v", res.PRF, res.Info.PRF)
	}
	n := passkeytest.New()
	n.NoPRF = true
	if res := register(t, s, rp, n, "不支持"); res.Info.PRF == nil || *res.Info.PRF {
		t.Fatalf("不支持 PRF 的认证器应记为 false：%v", res.Info.PRF)
	}

	// 开启保护后：登记和登录都带上盐
	s.PRFSalt = func() []byte { return salt }
	_, creation, _ = s.BeginRegistration(ctx, rp, "y")
	p := prfInput(t, jsonOf(t, creation))
	if eval, _ := p["eval"].(map[string]any); eval["first"] != base64.RawURLEncoding.EncodeToString(salt) {
		t.Fatalf("登记应带上盐：%v", p)
	}
	c := passkeytest.New()
	c.PRFAtCreate = true
	if res := register(t, s, rp, c, "登记即给输出"); !bytes.Equal(res.PRF, c.PRF(salt)) {
		t.Fatal("登记时给出的 PRF 输出应原样带回")
	}

	cer, assertion, _ := s.BeginLogin(rp)
	cred, _ := a.Get(jsonOf(t, assertion), rp.Origin)
	got, err := s.FinishLogin(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred)))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.PRF, a.PRF(salt)) || len(got.PRF) != 32 {
		t.Fatal("登录结果应带回 PRF 输出")
	}
	// PRF 输出不能出现在返回给前端的 JSON 里
	if b, _ := json.Marshal(got); bytes.Contains(b, []byte(base64.StdEncoding.EncodeToString(got.PRF))) || bytes.Contains(b, []byte(`"PRF"`)) {
		t.Fatalf("结果的 JSON 不应包含 PRF 输出：%s", b)
	}

	// 不支持 PRF 的认证器登录照常成功，只是没有输出
	cer, assertion, _ = s.BeginLogin(rp)
	cred, _ = n.Get(jsonOf(t, assertion), rp.Origin)
	if got, err := s.FinishLogin(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred))); err != nil || got.PRF != nil {
		t.Fatalf("不支持 PRF 的登录 = %v %v", got.PRF, err)
	}
}

func TestAssertLimitedToCredentials(t *testing.T) {
	ctx := context.Background()
	s, rp := newService(t)
	a, b := passkeytest.New(), passkeytest.New()
	register(t, s, rp, a, "a")
	register(t, s, rp, b, "b")
	salt := bytes.Repeat([]byte{3}, 32)

	if _, _, err := s.BeginAssert(ctx, rp, []string{"nope"}, salt, "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("没有可用凭据应返回 ErrNotFound：%v", err)
	}
	if _, _, err := s.BeginAssert(ctx, RP{ID: "other.example.com", Origin: "https://other.example.com"}, []string{a.ID()}, salt, "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("别的域名下没有这个凭据：%v", err)
	}

	cer, assertion, err := s.BeginAssert(ctx, rp, []string{a.ID()}, salt, "unlock")
	if err != nil {
		t.Fatal(err)
	}
	opts := jsonOf(t, assertion)
	if p := prfInput(t, opts); p == nil {
		t.Fatal("应请求 PRF")
	}
	// b 不在允许列表里：伪造一份 b 的响应也不能通过
	b2 := *b
	if _, err := b2.Get(opts, rp.Origin); !errors.Is(err, passkeytest.ErrNotAllowed) {
		t.Fatalf("认证器应拒绝不在列表里的凭据：%v", err)
	}
	var forged map[string]any
	_ = json.Unmarshal(opts, &forged)
	forged["publicKey"].(map[string]any)["allowCredentials"] = nil
	fo, _ := json.Marshal(forged)
	bcred, _ := b.Get(fo, rp.Origin)
	if _, err := s.FinishAssert(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(bcred))); !errors.Is(err, ErrVerify) {
		t.Fatalf("不在允许列表里的凭据应校验失败：%v", err)
	}

	cer, assertion, _ = s.BeginAssert(ctx, rp, []string{a.ID()}, salt, "unlock")
	cred, _ := a.Get(jsonOf(t, assertion), rp.Origin)
	res, err := s.FinishAssert(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred)))
	if err != nil {
		t.Fatal(err)
	}
	if res.Tag != "unlock" || res.ID != a.ID() || !bytes.Equal(res.PRF, a.PRF(salt)) || res.LastUsedAt == 0 {
		t.Fatalf("FinishAssert = %+v", res.Info)
	}
	// 断言仪式不能拿去登录
	cer, assertion, _ = s.BeginAssert(ctx, rp, []string{a.ID()}, salt, "unlock")
	cred, _ = a.Get(jsonOf(t, assertion), rp.Origin)
	if _, err := s.FinishLogin(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred))); !errors.Is(err, ErrNoCeremony) {
		t.Fatalf("验证仪式不能当登录用：%v", err)
	}
}

func TestWrapStorage(t *testing.T) {
	ctx := context.Background()
	s, rp := newService(t)
	a, b := passkeytest.New(), passkeytest.New()
	register(t, s, rp, a, "a")
	register(t, s, rp, b, "b")
	if err := s.SetWrap(ctx, s.db, a.ID(), "w1:xyz"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetWrap(ctx, s.db, "missing", "w1:xyz"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的通行密钥：%v", err)
	}
	if w, _ := s.Wrap(ctx, s.db, a.ID()); w != "w1:xyz" {
		t.Fatalf("Wrap = %q", w)
	}
	if ids, _ := s.Wrapped(ctx, rp.ID); len(ids) != 1 || ids[0] != a.ID() {
		t.Fatalf("Wrapped = %v", ids)
	}
	list, _ := s.List(ctx)
	// 两个通行密钥可能在同一毫秒登记，列表顺序不固定，按 ID 判断
	wrapped := map[string]bool{}
	for _, it := range list {
		wrapped[it.ID] = it.KeyWrapped
	}
	if len(list) != 2 || !wrapped[a.ID()] || wrapped[b.ID()] {
		t.Fatalf("列表应标出持有包裹的通行密钥：%+v", list)
	}
	// 列表的 JSON 不含包裹内容
	if b, _ := json.Marshal(list); bytes.Contains(b, []byte("w1:xyz")) {
		t.Fatalf("列表不应返回包裹内容：%s", b)
	}
	if err := s.ClearWraps(ctx, s.db); err != nil {
		t.Fatal(err)
	}
	if ids, _ := s.Wrapped(ctx, ""); len(ids) != 0 {
		t.Fatalf("清除后应为空：%v", ids)
	}
	if info, _ := s.Get(ctx, a.ID()); info.PRF == nil || !*info.PRF {
		t.Fatal("清除包裹不影响“支持 PRF”的记录")
	}
}
