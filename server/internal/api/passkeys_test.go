package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"strings"
	"testing"

	"github.com/rt-game-440/lode/server/internal/passkey/passkeytest"
)

// 通行密钥的完整仪式用软件认证器驱动。测试服务监听 127.0.0.1（IP 不能作 RP ID），
// 所以请求的 Host 改成 localhost:<端口>，与浏览器访问 http://localhost:<端口> 一致。

const pkHostName = "localhost"

// pkClient 自己管理会话 cookie：标准库的 cookie 罐会按 Host 头区分站点，而这里要在同一个连接上
// 用不同的 Host 头模拟不同的访问地址（会话 cookie 本身不区分域名）。
type pkClient struct {
	*client
	host   string // localhost:端口
	cookie string
}

func newPasskeyClient(t *testing.T, opts ...func(*Server)) *pkClient {
	t.Helper()
	c := newServer(t, opts...)
	port := c.base[strings.LastIndex(c.base, ":")+1:]
	return &pkClient{client: c, host: pkHostName + ":" + port}
}

func (c *pkClient) origin() string { return "http://" + c.host }

func (c *pkClient) setup() {
	c.t.Helper()
	st, _, _ := c.call("POST", "/api/auth/setup", "", map[string]string{"password": "correct-horse"}, nil, nil)
	if st != 204 {
		c.t.Fatalf("setup = %d", st)
	}
}

func (c *pkClient) logout() {
	c.call("POST", "/api/auth/logout", "", nil, nil, nil)
}

// call 发请求。host 为空时用 localhost；raw 非空时作为请求体原样发送。
func (c *pkClient) call(method, path, host string, body any, raw []byte, hdr map[string]string) (int, map[string]any, []byte) {
	c.t.Helper()
	var rd io.Reader
	switch {
	case raw != nil:
		rd = bytes.NewReader(raw)
	case body != nil:
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	req.Header.Set("Content-Type", "application/json")
	req.Host = host
	if host == "" {
		req.Host = c.host
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if c.cookie != "" {
		req.Header.Set("Cookie", SessionCookie+"="+c.cookie)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	for _, ck := range resp.Cookies() {
		if ck.Name == SessionCookie {
			c.cookie = ck.Value
			if ck.MaxAge < 0 {
				c.cookie = ""
			}
		}
	}
	b, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return resp.StatusCode, out, b
}

// optionsOf 取 begin 响应里的 ceremony 和 options 原文。
func optionsOf(t *testing.T, raw []byte) (string, []byte) {
	t.Helper()
	var r struct {
		Ceremony string          `json:"ceremony"`
		Options  json.RawMessage `json:"options"`
	}
	if err := json.Unmarshal(raw, &r); err != nil || r.Ceremony == "" {
		t.Fatalf("begin 响应无效: %s", raw)
	}
	return r.Ceremony, r.Options
}

// register 用 a 登记一个名为 name 的通行密钥，要求成功，返回通行密钥 id。
func (c *pkClient) register(a *passkeytest.Authenticator, name string) string {
	c.t.Helper()
	st, body, raw := c.call("POST", "/api/passkeys/begin", "", map[string]string{"name": name}, nil, nil)
	if st != 200 {
		c.t.Fatalf("登记 begin = %d %v", st, body)
	}
	cer, opts := optionsOf(c.t, raw)
	cred, err := a.Create(opts, c.origin())
	if err != nil {
		c.t.Fatal(err)
	}
	st, body, _ = c.call("POST", "/api/passkeys/finish?ceremony="+cer, "", nil, cred, nil)
	if st != 201 {
		c.t.Fatalf("登记 finish = %d %v", st, body)
	}
	return body["passkey"].(map[string]any)["id"].(string)
}

// login 走一遍通行密钥登录，返回 finish 的状态码和响应。
func (c *pkClient) login(a *passkeytest.Authenticator, origin string) (int, map[string]any) {
	c.t.Helper()
	st, body, raw := c.call("POST", "/api/auth/passkey/begin", "", nil, nil, nil)
	if st != 200 {
		c.t.Fatalf("登录 begin = %d %v", st, body)
	}
	cer, opts := optionsOf(c.t, raw)
	cred, err := a.Get(opts, origin)
	if err != nil {
		c.t.Fatal(err)
	}
	st, body, _ = c.call("POST", "/api/auth/passkey/finish?ceremony="+cer, "", nil, cred, nil)
	return st, body
}

func (c *pkClient) treeStatus() int {
	st, _, _ := c.call("GET", "/api/tree", "", nil, nil, nil)
	return st
}

func TestPasskeyRegisterLoginDelete(t *testing.T) {
	c := newPasskeyClient(t)
	c.setup()
	a := passkeytest.New()

	// 状态：还没有通行密钥
	if _, body, _ := c.call("GET", "/api/auth/status", "", nil, nil, nil); body["passkey"] != false {
		t.Fatalf("未登记时 passkey 应为 false: %v", body)
	}

	id := c.register(a, "我的电脑")
	if id != a.ID() {
		t.Fatalf("返回的 id = %s，应为凭据 ID %s", id, a.ID())
	}
	_, body, raw := c.call("GET", "/api/passkeys", "", nil, nil, nil)
	list := body["passkeys"].([]any)
	if len(list) != 1 {
		t.Fatalf("列表 = %s", raw)
	}
	item := list[0].(map[string]any)
	if item["name"] != "我的电脑" || item["created_at"].(float64) <= 0 || item["last_used_at"].(float64) != 0 {
		t.Fatalf("列表项 = %v", item)
	}
	if strings.Contains(string(raw), "publicKey") || strings.Contains(string(raw), "credential") {
		t.Fatalf("列表不应包含密钥材料: %s", raw)
	}
	if _, body, _ := c.call("GET", "/api/auth/status", "", nil, nil, nil); body["passkey"] != true {
		t.Fatalf("登记后 passkey 应为 true: %v", body)
	}

	// 退出后用通行密钥登录
	c.logout()
	if c.treeStatus() != 401 {
		t.Fatal("退出后应 401")
	}
	if st, body := c.login(a, c.origin()); st != 204 {
		t.Fatalf("通行密钥登录 = %d %v", st, body)
	}
	if c.treeStatus() != 200 {
		t.Fatal("通行密钥登录后应能访问接口")
	}
	_, body, _ = c.call("GET", "/api/passkeys", "", nil, nil, nil)
	if body["passkeys"].([]any)[0].(map[string]any)["last_used_at"].(float64) <= 0 {
		t.Fatalf("登录后应记录最后使用时间: %v", body)
	}

	// 第二次登录：签名计数递增，仍然成功
	c.logout()
	if st, body := c.login(a, c.origin()); st != 204 {
		t.Fatalf("第二次登录 = %d %v", st, body)
	}

	// 删除后不能再用它登录；密码仍然可用
	if st, _, _ := c.call("DELETE", "/api/passkeys/"+id, "", nil, nil, nil); st != 204 {
		t.Fatalf("删除 = %d", st)
	}
	if st, _, _ := c.call("DELETE", "/api/passkeys/"+id, "", nil, nil, nil); st != 404 {
		t.Fatalf("重复删除应 404，得到 %d", st)
	}
	c.logout()
	if st, body := c.login(a, c.origin()); st != 401 || body["code"] != "passkey_failed" {
		t.Fatalf("删除后用它登录应 401 passkey_failed，得到 %d %v", st, body)
	}
	if c.treeStatus() != 401 {
		t.Fatal("失败的登录不应建立会话")
	}
	if st, _, _ := c.call("POST", "/api/auth/login", "", map[string]string{"password": "correct-horse"}, nil, nil); st != 204 {
		t.Fatalf("密码登录 = %d", st)
	}
	if _, body, _ := c.call("GET", "/api/auth/status", "", nil, nil, nil); body["passkey"] != false {
		t.Fatalf("全部删除后 passkey 应为 false: %v", body)
	}
}

func TestPasskeyMultipleAndNaming(t *testing.T) {
	c := newPasskeyClient(t)
	c.setup()
	a, b := passkeytest.New(), passkeytest.New()
	c.register(a, "手机")
	c.register(b, "电脑")
	_, body, _ := c.call("GET", "/api/passkeys", "", nil, nil, nil)
	if len(body["passkeys"].([]any)) != 2 {
		t.Fatalf("应有两个通行密钥: %v", body)
	}
	// 两个都能登录
	for _, k := range []*passkeytest.Authenticator{a, b} {
		c.logout()
		if st, body := c.login(k, c.origin()); st != 204 {
			t.Fatalf("登录 = %d %v", st, body)
		}
	}
	// 名称不能为空，也不能太长
	for _, name := range []string{"", "   ", strings.Repeat("长", 65)} {
		if st, body, _ := c.call("POST", "/api/passkeys/begin", "", map[string]string{"name": name}, nil, nil); st != 400 {
			t.Errorf("名称 %q 应 400，得到 %d %v", name, st, body)
		}
	}
	// 名称前后空白被去掉
	k := passkeytest.New()
	c.register(k, "  平板  ")
	_, body, _ = c.call("GET", "/api/passkeys", "", nil, nil, nil)
	last := body["passkeys"].([]any)[2].(map[string]any)
	if last["name"] != "平板" {
		t.Fatalf("名称 = %v", last["name"])
	}
}

func TestPasskeyManagementRequiresSession(t *testing.T) {
	c := newPasskeyClient(t)
	c.setup()
	c.logout()
	for _, r := range [][2]string{{"GET", "/api/passkeys"}, {"POST", "/api/passkeys/begin"}, {"POST", "/api/passkeys/finish"}, {"DELETE", "/api/passkeys/x"}} {
		if st, _, _ := c.call(r[0], r[1], "", nil, nil, nil); st != 401 {
			t.Errorf("%s %s 未登录应 401，得到 %d", r[0], r[1], st)
		}
	}
}

func TestPasskeyUnsupportedForIPHost(t *testing.T) {
	c := newPasskeyClient(t)
	c.setup()
	// 经 IP 地址访问：不能登记，登录页也不应显示通行密钥
	for _, host := range []string{"192.168.1.10:8787", "127.0.0.1:8787", "[::1]:8787"} {
		st, body, _ := c.call("POST", "/api/passkeys/begin", host, map[string]string{"name": "x"}, nil, nil)
		if st != 400 || body["code"] != "passkey_unsupported" {
			t.Errorf("%s 登记 begin = %d %v", host, st, body)
		}
		st, body, _ = c.call("POST", "/api/auth/passkey/begin", host, nil, nil, nil)
		if st != 400 || body["code"] != "passkey_unsupported" {
			t.Errorf("%s 登录 begin = %d %v", host, st, body)
		}
		if _, body, _ := c.call("GET", "/api/auth/status", host, nil, nil, nil); body["passkey"] != false {
			t.Errorf("%s status = %v", host, body)
		}
	}
	// 密码登录不受影响
	c.logout()
	if st, _, _ := c.call("POST", "/api/auth/login", "127.0.0.1:8787", map[string]string{"password": "correct-horse"}, nil, nil); st != 204 {
		t.Fatalf("IP 访问时密码登录 = %d", st)
	}
}

func TestPasskeyBoundToHost(t *testing.T) {
	c := newPasskeyClient(t)
	c.setup()
	a := passkeytest.New()
	c.register(a, "电脑")
	// 另一个域名下没有登记过：登录页不显示，认证器也拿不到匹配的凭据
	if _, body, _ := c.call("GET", "/api/auth/status", "notes.example.com", nil, nil, nil); body["passkey"] != false {
		t.Fatalf("其它域名不应显示通行密钥: %v", body)
	}
	// 浏览器在 localhost 上签的名，origin 却是别的站点：校验失败
	c.logout()
	if st, body := c.login(a, "http://evil.example.com"); st != 401 || body["code"] != "passkey_failed" {
		t.Fatalf("origin 不符应 401，得到 %d %v", st, body)
	}
	// 仪式只能完成一次：重放同一个 ceremony 被拒绝
	_, _, raw := c.call("POST", "/api/auth/passkey/begin", "", nil, nil, nil)
	cer, opts := optionsOf(t, raw)
	cred, _ := a.Get(opts, c.origin())
	if st, _, _ := c.call("POST", "/api/auth/passkey/finish?ceremony="+cer, "", nil, cred, nil); st != 204 {
		t.Fatalf("首次完成 = %d", st)
	}
	c.logout()
	if st, body, _ := c.call("POST", "/api/auth/passkey/finish?ceremony="+cer, "", nil, cred, nil); st != 400 || body["code"] != "ceremony_expired" {
		t.Fatalf("重放应 400 ceremony_expired，得到 %d %v", st, body)
	}
	if c.treeStatus() != 401 {
		t.Fatal("重放不应建立会话")
	}
}

func TestPasskeyLoginSharesRateLimit(t *testing.T) {
	c := newPasskeyClient(t)
	c.setup()
	a := passkeytest.New()
	c.register(a, "电脑")
	c.logout()
	other := passkeytest.New() // 没登记过的认证器
	other.UserHandle = a.UserHandle
	for i := 0; i < 5; i++ {
		if st, _ := c.login(other, c.origin()); st != 401 {
			t.Fatalf("第 %d 次失败应 401，得到 %d", i+1, st)
		}
	}
	// 锁定后：通行密钥和密码登录都被拒绝，即使凭据正确
	if st, _, raw := c.call("POST", "/api/auth/passkey/begin", "", nil, nil, nil); st != 429 {
		t.Fatalf("锁定期间 begin 应 429，得到 %d %s", st, raw)
	}
	if st, _, _ := c.call("POST", "/api/auth/login", "", map[string]string{"password": "correct-horse"}, nil, nil); st != 429 {
		t.Fatalf("锁定期间密码登录应 429，得到 %d", st)
	}
}

func TestPasskeyRPFromTrustedProxyHeaders(t *testing.T) {
	// 反向代理终止 TLS：浏览器访问 https://notes.example.com，代理转发 X-Forwarded-Host/Proto。
	trusted := func(s *Server) { s.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")} }
	c := newPasskeyClient(t, trusted)
	c.setup()
	fwd := map[string]string{"X-Forwarded-Host": "notes.example.com", "X-Forwarded-Proto": "https"}
	a := passkeytest.New()
	st, body, raw := c.call("POST", "/api/passkeys/begin", "", map[string]string{"name": "电脑"}, nil, fwd)
	if st != 200 {
		t.Fatalf("begin = %d %v", st, body)
	}
	cer, opts := optionsOf(t, raw)
	if !strings.Contains(string(opts), `"id":"notes.example.com"`) {
		t.Fatalf("RP ID 应取转发的主机: %s", opts)
	}
	cred, _ := a.Create(opts, "https://notes.example.com")
	if st, body, _ = c.call("POST", "/api/passkeys/finish?ceremony="+cer, "", nil, cred, fwd); st != 201 {
		t.Fatalf("finish = %d %v", st, body)
	}
	if _, body, _ := c.call("GET", "/api/auth/status", "", nil, nil, fwd); body["passkey"] != true {
		t.Fatalf("经代理访问应显示通行密钥: %v", body)
	}
	// 同一个直连地址不带转发头：是 localhost，没有登记过
	if _, body, _ := c.call("GET", "/api/auth/status", "", nil, nil, nil); body["passkey"] != false {
		t.Fatalf("localhost 下不应显示: %v", body)
	}
}

func TestPasskeyForwardedHostIgnoredFromUntrustedPeer(t *testing.T) {
	c := newPasskeyClient(t) // 没有可信代理
	c.setup()
	fwd := map[string]string{"X-Forwarded-Host": "evil.example.com", "X-Forwarded-Proto": "https"}
	_, _, raw := c.call("POST", "/api/passkeys/begin", "", map[string]string{"name": "x"}, nil, fwd)
	_, opts := optionsOf(t, raw)
	if strings.Contains(string(opts), "evil.example.com") || !strings.Contains(string(opts), `"id":"localhost"`) {
		t.Fatalf("不可信的直连方带来的转发头应被忽略: %s", opts)
	}
}
