package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/rt-game-440/lode/server/internal/agent"
)

// 多工作空间预重构（#56）：按工作空间区分的接口同时挂在 /api/... 和 /api/w/{ws}/...，
// 现在只认 default，两者结果完全一样；未知工作空间返回 404 workspace_not_found。

const wsDefault = "/api/w/default"

// rawH 发请求并返回状态码和原始响应体。
func (c *client) rawH(method, path string, body io.Reader, contentType string) (int, []byte) {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.base+path, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

// same 对 /api<rest> 和 /api/w/default<rest> 发同样的只读请求，要求状态码和响应体完全一样。
func (c *client) same(method, rest string) []byte {
	c.t.Helper()
	st1, b1 := c.rawH(method, "/api"+rest, nil, "")
	st2, b2 := c.rawH(method, wsDefault+rest, nil, "")
	if st1 != st2 || !bytes.Equal(b1, b2) {
		c.t.Fatalf("%s %s 两种前缀结果不同：\n/api           → %d %s\n/api/w/default → %d %s", method, rest, st1, b1, st2, b2)
	}
	return b1
}

// sameWrite 用同一个请求体分别发给两种前缀（用于预期出错、不改变状态的写请求），要求结果一样。
func (c *client) sameWrite(method, rest string, body any) (int, []byte) {
	c.t.Helper()
	j, _ := json.Marshal(body)
	st1, b1 := c.rawH(method, "/api"+rest, bytes.NewReader(j), "application/json")
	st2, b2 := c.rawH(method, wsDefault+rest, bytes.NewReader(j), "application/json")
	if st1 != st2 || !bytes.Equal(b1, b2) {
		c.t.Fatalf("%s %s 两种前缀结果不同：\n/api           → %d %s\n/api/w/default → %d %s", method, rest, st1, b1, st2, b2)
	}
	return st1, b1
}

func (c *client) mustDo(method, path string, body any, want int) map[string]any {
	c.t.Helper()
	st, out := c.do(method, path, body)
	if st != want {
		c.t.Fatalf("%s %s = %d %v，期望 %d", method, path, st, out, want)
	}
	return out
}

// samplePath 把路由模式里的通配符换成示例值，得到一个具体路径（不含 /api 前缀）。
func samplePath(pattern string) (method, rest string) {
	method, p, _ := strings.Cut(pattern, " ")
	p = strings.NewReplacer("{id}", "x1", "{callId}", "c1", "{path...}", "a/b.png").Replace(p)
	return method, strings.TrimPrefix(p, "/api")
}

func TestUnknownWorkspaceReturns404OnEveryRoute(t *testing.T) {
	var srv *Server
	opt, _ := withAgent(t, "m", &lockedBuffer{})
	c := newServer(t, opt, func(s *Server) { srv = s })
	// 未登录时先要求登录，不泄露工作空间是否存在
	if st, _ := c.do("GET", "/api/w/nope/tree", nil); st != 401 {
		t.Fatalf("未登录应 401，得到 %d", st)
	}
	c.setup()
	routes := srv.workspaceRoutes()
	if len(routes) != 35 {
		t.Fatalf("按工作空间区分的路由应有 35 条（26 条笔记相关 + 9 条助手对话），得到 %d", len(routes))
	}
	for _, rt := range routes {
		method, rest := samplePath(rt.pattern)
		for _, ws := range []string{"nope", "DEFAULT", "k3f9a2"} {
			st, body := c.do(method, "/api/w/"+ws+rest, map[string]any{})
			if st != 404 || body["error"] != "workspace_not_found" || body["code"] != "workspace_not_found" {
				t.Errorf("%s /api/w/%s%s = %d %v，期望 404 workspace_not_found", method, ws, rest, st, body)
			}
		}
		// default 前缀下每条路由都已挂载（不是路由表的 404/405）
		req, _ := http.NewRequest(method, c.base+wsDefault+rest, strings.NewReader("{}"))
		resp, err := c.hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == 405 || (resp.StatusCode == 404 && !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json")) {
			t.Errorf("%s %s%s 没有挂载：%d %s", method, wsDefault, rest, resp.StatusCode, b)
		}
	}
	// 前缀本身不完整时也按工作空间不存在处理
	if st, body := c.do("GET", "/api/w//tree", nil); st != 404 || body["error"] != "workspace_not_found" {
		t.Errorf("空的工作空间 id = %d %v", st, body)
	}
}

func TestWorkspacePrefixDoesNotExposeGlobalRoutes(t *testing.T) {
	opt, _ := withAgent(t, "m", &lockedBuffer{})
	c := newServer(t, opt)
	c.setup()
	for _, p := range []string{"/tokens", "/audit", "/passkeys", "/agent/config", "/health", "/auth/status", "/workspaces"} {
		st, b := c.rawH("GET", wsDefault+p, nil, "")
		if st != 404 {
			t.Errorf("全局接口不应挂在工作空间前缀下：GET %s%s = %d %s", wsDefault, p, st, b)
		}
	}
	// 方法不对时两种前缀都返回 405
	st1, _ := c.rawH("POST", "/api/tree", nil, "")
	st2, _ := c.rawH("POST", wsDefault+"/tree", nil, "")
	if st1 != 405 || st2 != 405 {
		t.Errorf("POST tree：/api = %d，/api/w/default = %d，都应是 405", st1, st2)
	}
}

func TestDefaultWorkspacePrefixMatchesLegacyRoutes(t *testing.T) {
	opt, _ := withAgent(t, "m", &lockedBuffer{})
	c := newServer(t, opt, func(s *Server) { s.WSPingInterval = time.Hour })
	c.setup()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// WebSocket：两种前缀各连一个，hello 一样
	dial := func(prefix string) *websocket.Conn {
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(c.base, "http")+prefix+"/ws", &websocket.DialOptions{HTTPClient: c.hc})
		if err != nil {
			t.Fatalf("连接 %s/ws：%v", prefix, err)
		}
		t.Cleanup(func() { conn.CloseNow() })
		return conn
	}
	legacyWS, prefixedWS := dial("/api"), dial(wsDefault)
	readBoth := func() (string, string) {
		t.Helper()
		var a, b json.RawMessage
		if err := wsjson.Read(ctx, legacyWS, &a); err != nil {
			t.Fatal(err)
		}
		if err := wsjson.Read(ctx, prefixedWS, &b); err != nil {
			t.Fatal(err)
		}
		return string(a), string(b)
	}
	if a, b := readBoth(); a != b || !strings.Contains(a, `"hello"`) {
		t.Fatalf("hello 不同：%s / %s", a, b)
	}
	// 每次写操作后两个连接收到同样的变更推送
	expectPush := func(what string) {
		t.Helper()
		a, b := readBoth()
		if a != b {
			t.Fatalf("%s 后两个 WebSocket 收到的推送不同：\n%s\n%s", what, a, b)
		}
	}

	// syncPoint 用一篇标记笔记对齐两个连接：各自读到标记的推送为止，途中收到的推送要完全一样。
	// 用于一次操作产生多条推送的情况（文件夹移动、删除等）。
	marks := 0
	syncPoint := func() {
		t.Helper()
		marks++
		mark := fmt.Sprintf("同步标记 %d.md", marks)
		c.mustDo("POST", "/api/notes", map[string]any{"path": mark, "content": ""}, 201)
		collect := func(conn *websocket.Conn) []string {
			var out []string
			for {
				var m json.RawMessage
				if err := wsjson.Read(ctx, conn, &m); err != nil {
					t.Fatal(err)
				}
				out = append(out, string(m))
				if strings.Contains(string(m), `"path":"`+mark+`"`) {
					return out
				}
			}
		}
		x, y := collect(legacyWS), collect(prefixedWS)
		if strings.Join(x, "\n") != strings.Join(y, "\n") {
			t.Fatalf("两个 WebSocket 收到的推送不同：\n%v\n%v", x, y)
		}
	}

	// ---- 笔记 ----
	a := c.mustDo("POST", wsDefault+"/notes", map[string]any{"path": "a.md", "content": "# A\n\n链接 [[b]] #标签甲\n"}, 201)
	expectPush("新建 a")
	b := c.mustDo("POST", "/api/notes", map[string]any{"path": "b.md", "content": "# B\n\nhello 世界\n"}, 201)
	expectPush("新建 b")
	auto := c.mustDo("POST", wsDefault+"/notes", map[string]any{"path": "a.md", "content": "", "auto_rename": true}, 201)
	if auto["path"] != "a 1.md" {
		t.Fatalf("auto_rename = %v", auto)
	}
	expectPush("auto_rename")
	if st, _ := c.sameWrite("POST", "/notes", map[string]any{"path": "a.md", "content": ""}); st != 409 {
		t.Fatalf("重复路径应 409，得到 %d", st)
	}
	if st, _ := c.sameWrite("POST", "/notes", map[string]any{"path": "../x.md", "content": ""}); st != 400 {
		t.Fatalf("越界路径应 400，得到 %d", st)
	}
	aID, bID := a["id"].(string), b["id"].(string)

	c.mustDo("PUT", wsDefault+"/notes/"+aID, map[string]any{"base_rev": 1, "content": "# A\n\n链接 [[b]] #标签甲 #标签乙\n"}, 200)
	expectPush("PUT")
	c.mustDo("PATCH", wsDefault+"/notes/"+aID, map[string]any{"base_rev": 2, "edits": []map[string]string{{"old": "# A", "new": "# A 改"}}}, 200)
	expectPush("PATCH")
	for _, rest := range []string{
		"/tree", "/notes", "/notes?prefix=&recursive=false", "/notes/by-path?path=a.md", "/notes/by-path?path=nope.md",
		"/notes/" + aID, "/notes/" + bID + "/backlinks", "/notes/" + aID + "/tags", "/notes/nope",
		"/search?q=hello", "/search?q=世界&limit=5", "/search?q=A&path_prefix=", "/tags", "/tags/notes?tag=标签甲",
		"/changes?since=0", "/changes?since=2&limit=1", "/changes?since=999", "/trash", "/images",
	} {
		c.same("GET", rest)
	}

	// 移动笔记
	c.mustDo("POST", wsDefault+"/notes/"+bID+"/move", map[string]any{"path": "dir/b.md"}, 200)
	expectPush("move")
	c.same("GET", "/tree")
	c.same("GET", "/notes/"+aID) // 链接随之更新

	// ---- 文件夹 ----
	c.mustDo("POST", wsDefault+"/folders", map[string]any{"path": "空文件夹"}, 201)
	c.same("GET", "/tree")
	c.mustDo("POST", wsDefault+"/folders/move", map[string]any{"from": "dir", "to": "dir2"}, 200)
	syncPoint()
	c.same("GET", "/tree")
	if out := c.mustDo("DELETE", wsDefault+"/folders?path=dir2", nil, 200); out["trashed"].(float64) != 1 {
		t.Fatalf("删除文件夹 = %v", out)
	}
	syncPoint()
	c.same("GET", "/tree")
	c.same("GET", "/trash")

	// ---- 附件和文件 ----
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "图 片.png")
	fw.Write([]byte("\x89PNG fake"))
	mw.Close()
	st, up := c.rawH("POST", wsDefault+"/attachments", &buf, mw.FormDataContentType())
	if st != 201 || !strings.Contains(string(up), `"url":"/api/files/attachments/`) {
		t.Fatalf("上传 = %d %s（默认工作空间的文件链接保持 /api/files/...）", st, up)
	}
	if body := c.same("GET", "/files/attachments/%E5%9B%BE%20%E7%89%87.png"); string(body) != "\x89PNG fake" {
		t.Fatalf("文件内容 = %q", body)
	}
	c.same("GET", "/files/attachments/nope.png")
	c.same("GET", "/files/..%2Fapp.db")
	c.same("GET", "/images")

	// ---- 回收站 ----
	c.mustDo("DELETE", wsDefault+"/notes/"+aID, nil, 200)
	expectPush("delete")
	c.same("GET", "/trash")
	c.mustDo("POST", wsDefault+"/trash/"+aID+"/restore", nil, 200)
	expectPush("restore")
	c.mustDo("DELETE", wsDefault+"/notes/"+aID, nil, 200)
	expectPush("delete again")
	if st, _ := c.rawH("DELETE", wsDefault+"/trash/"+aID, nil, ""); st != 204 {
		t.Fatalf("彻底删除 = %d", st)
	}
	c.same("GET", "/trash")
	if st, _ := c.sameWrite("POST", "/trash/nope/restore", nil); st != 404 {
		t.Fatalf("恢复不存在的条目应 404，得到 %d", st)
	}
	if st, _ := c.rawH("DELETE", wsDefault+"/trash", nil, ""); st != 204 {
		t.Fatalf("清空回收站 = %d", st)
	}
	c.same("GET", "/trash")
	syncPoint()
	c.same("GET", "/changes?since=0")
	c.same("GET", "/tree")

	// ---- 助手对话 ----
	chat := c.mustDo("POST", wsDefault+"/agent/chats", map[string]any{}, 201)
	chatID := chat["id"].(string)
	c.same("GET", "/agent/chats")
	c.same("GET", "/agent/chats/"+chatID)
	c.same("GET", "/agent/chats/nope")
	if out := c.mustDo("PATCH", wsDefault+"/agent/chats/"+chatID, map[string]any{"title": "改名"}, 200); out["title"] != "改名" {
		t.Fatalf("改名 = %v", out)
	}
	c.same("GET", "/agent/chats/"+chatID)
	if st, _ := c.sameWrite("POST", "/agent/chats/"+chatID+"/messages", map[string]any{"text": "hi"}); st != 400 {
		t.Fatalf("没有模型时发送应 400，得到 %d", st)
	}
	if st, _ := c.sameWrite("POST", "/agent/chats/"+chatID+"/stop", nil); st >= 500 {
		t.Fatalf("停止 = %d", st)
	}
	if st, _ := c.sameWrite("POST", "/agent/chats/"+chatID+"/approvals/nope", map[string]any{"approve": true}); st != 404 {
		t.Fatalf("批准不存在的调用应 404，得到 %d", st)
	}
	for _, prefix := range []string{"/api", wsDefault} {
		if ev := firstSSE(t, c, prefix+"/agent/chats/"+chatID+"/stream"); ev.Type != "state" || ev.Running {
			t.Fatalf("%s 事件流第一条应是空闲的状态快照：%+v", prefix, ev)
		}
	}
	c.same("GET", "/agent/chats/nope/stream")
	if st, _ := c.rawH("DELETE", wsDefault+"/agent/chats/"+chatID, nil, ""); st != 204 {
		t.Fatalf("删除对话 = %d", st)
	}
	c.same("GET", "/agent/chats")
}

func firstSSE(t *testing.T, c *client, path string) agent.Event {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", c.base+path, nil)
	resp, err := c.hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("%s = %d", path, resp.StatusCode)
	}
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		if data, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
			var ev agent.Event
			if err := json.Unmarshal([]byte(data), &ev); err != nil {
				t.Fatal(err)
			}
			return ev
		}
	}
	t.Fatalf("%s 没有收到事件", path)
	return agent.Event{}
}
