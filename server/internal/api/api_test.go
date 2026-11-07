package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/vault"
)

type client struct {
	t    *testing.T
	base string
	hc   *http.Client
}

func newServer(t *testing.T, opts ...func(*Server)) *client {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	v, _ := vault.New(filepath.Join(dir, "vault"))
	svc := notes.New(notes.Options{DB: d, Vault: v, TrashDir: filepath.Join(dir, "trash")})
	s := &Server{Notes: svc, Auth: auth.New(d), Version: "test"}
	for _, o := range opts {
		o(s)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return &client{t: t, base: ts.URL, hc: &http.Client{Jar: jar}}
}

func (c *client) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	return c.doH(method, path, body, nil)
}

func (c *client) doH(method, path string, body any, hdr map[string]string) (int, map[string]any) {
	c.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, r)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (c *client) setup() {
	c.t.Helper()
	if st, body := c.do("POST", "/api/auth/setup", map[string]string{"password": "correct-horse"}); st != 204 {
		c.t.Fatalf("setup = %d %v", st, body)
	}
}

func TestPublicEndpointsAndAuthRequired(t *testing.T) {
	c := newServer(t)
	if st, body := c.do("GET", "/api/health", nil); st != 200 || body["status"] != "ok" {
		t.Fatalf("health = %d %v", st, body)
	}
	if st, body := c.do("GET", "/api/auth/status", nil); st != 200 || body["initialized"] != false {
		t.Fatalf("status = %d %v", st, body)
	}
	for _, p := range []string{"/api/tree", "/api/search?q=x", "/api/notes/abc", "/api/files/a.png", "/api/changes"} {
		if st, _ := c.do("GET", p, nil); st != 401 {
			t.Errorf("%s 未登录应返回 401，得到 %d", p, st)
		}
	}
	c.setup()
	if st, _ := c.do("GET", "/api/tree", nil); st != 200 {
		t.Fatalf("登录后 tree = %d", st)
	}
	if st, _ := c.do("POST", "/api/auth/setup", map[string]string{"password": "another-password"}); st != 409 {
		t.Fatalf("重复 setup 应 409，得到 %d", st)
	}
	c.do("POST", "/api/auth/logout", nil)
	if st, _ := c.do("GET", "/api/tree", nil); st != 401 {
		t.Fatalf("登出后应 401，得到 %d", st)
	}
}

func TestLoginRateLimit(t *testing.T) {
	c := newServer(t)
	c.setup()
	c.do("POST", "/api/auth/logout", nil)
	for i := 0; i < 5; i++ {
		if st, _ := c.do("POST", "/api/auth/login", map[string]string{"password": "wrong"}); st != 401 {
			t.Fatalf("第 %d 次错误密码应 401，得到 %d", i+1, st)
		}
	}
	st, body := c.do("POST", "/api/auth/login", map[string]string{"password": "correct-horse"})
	if st != 429 || body["code"] != "rate_limited" {
		t.Fatalf("锁定期间即使密码正确也应 429，得到 %d %v", st, body)
	}
}

// 反向代理后面所有请求的 RemoteAddr 相同：只有来自可信代理时才按 X-Forwarded-For 区分客户端。
func TestRateLimitTrustsForwardedForOnlyFromTrustedProxies(t *testing.T) {
	loopback := func(s *Server) {
		s.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128")}
	}
	attacker := map[string]string{"X-Forwarded-For": "203.0.113.7"}
	owner := map[string]string{"X-Forwarded-For": "198.51.100.9"}
	wrong := map[string]string{"password": "wrong"}
	right := map[string]string{"password": "correct-horse"}

	c := newServer(t, loopback)
	c.setup()
	c.do("POST", "/api/auth/logout", nil)
	for i := 0; i < 5; i++ {
		c.doH("POST", "/api/auth/login", wrong, attacker)
	}
	if st, body := c.doH("POST", "/api/auth/login", right, owner); st != 204 {
		t.Fatalf("其他客户端不应被别人的错误尝试锁定，得到 %d %v", st, body)
	}
	if st, _ := c.doH("POST", "/api/auth/login", right, attacker); st != 429 {
		t.Fatalf("出错的客户端应被锁定，得到 %d", st)
	}

	// 未配置可信代理时忽略 X-Forwarded-For，伪造它也绕不过限流
	c2 := newServer(t)
	c2.setup()
	c2.do("POST", "/api/auth/logout", nil)
	for i := 0; i < 5; i++ {
		c2.doH("POST", "/api/auth/login", wrong, attacker)
	}
	if st, _ := c2.doH("POST", "/api/auth/login", right, owner); st != 429 {
		t.Fatalf("不可信来源的 X-Forwarded-For 不应生效，得到 %d", st)
	}
}

func TestNoteCRUDConflictAndTraversal(t *testing.T) {
	c := newServer(t)
	c.setup()
	st, n := c.do("POST", "/api/notes", map[string]any{"path": "未命名.md", "content": "v1", "auto_rename": true})
	if st != 201 {
		t.Fatalf("create = %d %v", st, n)
	}
	id := n["id"].(string)
	st, n2 := c.do("POST", "/api/notes", map[string]any{"path": "未命名.md", "content": "", "auto_rename": true})
	if st != 201 || n2["path"] != "未命名 1.md" {
		t.Fatalf("auto_rename = %d %v", st, n2)
	}
	if st, _ := c.do("POST", "/api/notes", map[string]any{"path": "未命名.md", "content": ""}); st != 409 {
		t.Fatalf("重复路径应 409，得到 %d", st)
	}
	if st, body := c.do("PUT", "/api/notes/"+id, map[string]any{"base_rev": 1, "content": "v2"}); st != 200 || body["rev"].(float64) != 2 {
		t.Fatalf("update = %d %v", st, body)
	}
	st, body := c.do("PUT", "/api/notes/"+id, map[string]any{"base_rev": 1, "content": "stale"})
	if st != 409 || body["code"] != "conflict" || body["current_rev"].(float64) != 2 {
		t.Fatalf("旧 base_rev 应 409 conflict，得到 %d %v", st, body)
	}
	st, body = c.do("PATCH", "/api/notes/"+id, map[string]any{"base_rev": 2, "edits": []map[string]string{{"old": "zzz", "new": "y"}}})
	if st != 422 || body["code"] != "patch_failed" {
		t.Fatalf("patch 不匹配应 422，得到 %d %v", st, body)
	}
	for _, p := range []string{"../x.md", "a/../../x.md", "/abs.md"} {
		if st, body := c.do("POST", "/api/notes", map[string]any{"path": p, "content": ""}); st != 400 || body["code"] != "invalid_path" {
			t.Errorf("路径 %q 应 400 invalid_path，得到 %d %v", p, st, body)
		}
	}
	if st, _ := c.do("GET", "/api/files/..%2Fapp.db", nil); st != 400 && st != 404 {
		t.Errorf("文件下载越界应被拒绝，得到 %d", st)
	}
	if st, body := c.do("POST", "/api/notes/"+id+"/move", map[string]any{"path": "../../x.md"}); st != 400 {
		t.Errorf("移动越界应 400，得到 %d %v", st, body)
	}
	// "v2" 只有 2 个字符，走 LIKE 兜底，应命中刚更新的笔记
	if st, body := c.do("GET", "/api/search?q=v2", nil); st != 200 {
		t.Fatalf("search = %d %v", st, body)
	} else if rs := body["results"].([]any); len(rs) != 1 || rs[0].(map[string]any)["id"] != id {
		t.Fatalf("search v2 应只命中 %s，得到 %v", id, rs)
	}
	if st, _ := c.do("DELETE", "/api/notes/"+id, nil); st != 200 {
		t.Fatalf("delete = %d", st)
	}
	if st, body := c.do("GET", "/api/trash", nil); st != 200 || len(body["items"].([]any)) != 1 {
		t.Fatalf("trash = %d %v", st, body)
	}
	if st, _ := c.do("POST", "/api/trash/"+id+"/restore", nil); st != 200 {
		t.Fatalf("restore = %d", st)
	}
	if st, body := c.do("GET", "/api/changes?since=0", nil); st != 200 || body["seq"].(float64) < 4 {
		t.Fatalf("changes = %d %v", st, body)
	}
}

func TestCrossSiteWriteIsRejected(t *testing.T) {
	c := newServer(t)
	req, _ := http.NewRequest("POST", c.base+"/api/auth/setup", strings.NewReader(`{"password":"correct-horse"}`))
	req.Header.Set("Origin", "https://evil.example")
	resp, err := c.hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("跨站写请求应 403，得到 %d", resp.StatusCode)
	}
}

func TestAttachmentUploadAndServe(t *testing.T) {
	c := newServer(t)
	c.setup()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "图 片.png")
	fw.Write([]byte("\x89PNG fake"))
	mw.Close()
	req, _ := http.NewRequest("POST", c.base+"/api/attachments", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := c.hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]string
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if resp.StatusCode != 201 || out["path"] != "attachments/图 片.png" {
		t.Fatalf("upload = %d %v", resp.StatusCode, out)
	}
	resp, err = c.hc.Get(c.base + out["url"])
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(b) != "\x89PNG fake" || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("serve = %d %q %v", resp.StatusCode, b, resp.Header)
	}
}

func TestStaleWriteMergesOrReturnsConflictCopy(t *testing.T) {
	c := newServer(t)
	c.setup()
	_, n := c.do("POST", "/api/notes", map[string]any{"path": "a.md", "content": "一\n\n二\n\n三\n"})
	id := n["id"].(string)
	c.do("PUT", "/api/notes/"+id, map[string]any{"base_rev": 1, "content": "一 A\n\n二\n\n三\n"})
	st, body := c.do("PUT", "/api/notes/"+id, map[string]any{"base_rev": 1, "content": "一\n\n二\n\n三 B\n"})
	if st != 200 || body["merged"] != true || body["content"] != "一 A\n\n二\n\n三 B\n" || body["rev"].(float64) != 3 {
		t.Fatalf("不重叠的旧版本写入应合并，得到 %d %v", st, body)
	}
	st, body = c.doH("PUT", "/api/notes/"+id, map[string]any{"base_rev": 2, "content": "一 A\n\n二\n\n三 C\n"},
		map[string]string{"X-Device-Id": "d2", "X-Device-Name": url.PathEscape("我的手机")})
	if st != 409 || body["code"] != "conflict" || body["current_rev"].(float64) != 3 ||
		!strings.HasPrefix(body["conflict_path"].(string), "a.conflict-我的手机-") || body["conflict_id"] == nil || body["conflict_id"] == "" {
		t.Fatalf("重叠的修改应 409 并返回冲突副本，得到 %d %v", st, body)
	}
}

func TestChangesSinceBeyondLatestIsGone(t *testing.T) {
	c := newServer(t)
	c.setup()
	if st, body := c.do("GET", "/api/changes?since=42", nil); st != 410 || body["code"] != "gone" {
		t.Fatalf("since 超过最新序号应 410 gone，得到 %d %v", st, body)
	}
}

func TestWebSocketPushesChangesAndHeartbeats(t *testing.T) {
	c := newServer(t, func(s *Server) { s.WSPingInterval = 100 * time.Millisecond })
	wsURL := "ws" + strings.TrimPrefix(c.base, "http") + "/api/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, resp, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: c.hc}); err == nil || resp == nil || resp.StatusCode != 401 {
		t.Fatalf("未登录连接应被拒绝（401），得到 %v", err)
	}
	c.setup()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: c.hc})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	read := func() map[string]any {
		t.Helper()
		var m map[string]any
		if err := wsjson.Read(ctx, conn, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	if m := read(); m["type"] != "hello" || m["seq"].(float64) != 0 {
		t.Fatalf("连接后应先收到 hello，得到 %v", m)
	}
	_, n := c.doH("POST", "/api/notes", map[string]any{"path": "x.md", "content": "hi"}, map[string]string{"X-Device-Id": "dev-a"})
	for {
		m := read()
		if m["type"] == "ping" {
			continue
		}
		if m["type"] != "upsert" || m["id"] != n["id"] || m["path"] != "x.md" || m["rev"].(float64) != 1 || m["device_id"] != "dev-a" || m["seq"].(float64) != 1 {
			t.Fatalf("变更事件不对：%v", m)
		}
		break
	}
	if m := read(); m["type"] != "ping" || m["seq"].(float64) != 1 {
		t.Fatalf("应定期收到带最新 seq 的心跳，得到 %v", m)
	}
}

func TestCrossSiteWebSocketIsRejected(t *testing.T) {
	c := newServer(t)
	c.setup()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hdr := http.Header{"Origin": []string{"https://evil.example"}}
	_, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(c.base, "http")+"/api/ws", &websocket.DialOptions{HTTPClient: c.hc, HTTPHeader: hdr})
	if err == nil || resp == nil || resp.StatusCode != 403 {
		t.Fatalf("跨站 WebSocket 应被拒绝（403），得到 %v", err)
	}
}
