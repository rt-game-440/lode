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
	"path/filepath"
	"strings"
	"testing"

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

func newServer(t *testing.T) *client {
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
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return &client{t: t, base: ts.URL, hc: &http.Client{Jar: jar}}
}

func (c *client) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, r)
	req.Header.Set("Content-Type", "application/json")
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
