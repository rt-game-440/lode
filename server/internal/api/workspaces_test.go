package api

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// #57：通过 API 新建内置工作空间，并在 /api/w/<id>/... 下隔离使用。

// newWorkspace 用 POST /api/workspaces 新建工作空间，返回它的接口前缀 /api/w/<id>。
func (c *client) newWorkspace(name string) (id, prefix string) {
	c.t.Helper()
	out := c.mustDo("POST", "/api/workspaces", map[string]any{"name": name}, 201)
	id, _ = out["id"].(string)
	if id == "" || out["name"] != name {
		c.t.Fatalf("新建工作空间 = %v", out)
	}
	return id, "/api/w/" + id
}

func TestWorkspacesListAndCreate(t *testing.T) {
	var srv *Server
	c := newServer(t, func(s *Server) { srv = s })
	if st, _ := c.do("GET", "/api/workspaces", nil); st != 401 {
		t.Fatalf("未登录应 401，得到 %d", st)
	}
	c.setup()
	list := c.mustDo("GET", "/api/workspaces", nil, 200)["workspaces"].([]any)
	if len(list) != 1 {
		t.Fatalf("初始只有默认工作空间：%v", list)
	}
	def := list[0].(map[string]any)
	if def["id"] != "default" || def["name"] != "笔记" || def["external"] != false || def["note_count"] != 0.0 {
		t.Fatalf("默认工作空间 = %v", def)
	}
	for _, body := range []map[string]any{{"name": ""}, {"name": "   "}, {"name": strings.Repeat("长", 65)}} {
		if st, out := c.do("POST", "/api/workspaces", body); st != 400 || out["code"] != "bad_request" {
			t.Errorf("POST %v = %d %v，期望 400", body, st, out)
		}
	}
	c.mustDo("POST", "/api/notes", map[string]any{"path": "默认.md", "content": "x"}, 201)
	id, _ := c.newWorkspace("工作")
	if srv.Workspaces.IsOpen(id) {
		t.Fatal("新建后不应立即打开")
	}
	list = c.mustDo("GET", "/api/workspaces", nil, 200)["workspaces"].([]any)
	if len(list) != 2 {
		t.Fatalf("列表 = %v", list)
	}
	got := list[1].(map[string]any)
	if got["id"] != id || got["name"] != "工作" || got["note_count"] != 0.0 || got["sort"] != 1.0 || got["created_at"].(float64) <= 0 {
		t.Fatalf("新工作空间 = %v", got)
	}
	if _, ok := got["vault_dir"]; ok {
		t.Fatalf("内置工作空间不应返回 vault_dir：%v", got)
	}
	if list[0].(map[string]any)["note_count"] != 1.0 {
		t.Fatalf("默认工作空间笔记数 = %v", list[0])
	}
	if srv.Workspaces.IsOpen(id) {
		t.Fatal("列出不应打开工作空间")
	}
	// 第一次访问时打开
	c.mustDo("GET", "/api/w/"+id+"/tree", nil, 200)
	if !srv.Workspaces.IsOpen(id) {
		t.Fatal("访问后应已打开")
	}
}

// 验收：两个空间里各建一篇同路径的笔记，正文、搜索结果、反链、回收站、变更序号互不影响。
func TestWorkspacesAreIsolated(t *testing.T) {
	c := newServer(t, func(s *Server) { s.Workspaces.Start(t.Context()) })
	c.setup()
	_, pa := c.newWorkspace("甲")
	_, pb := c.newWorkspace("乙")

	// 同路径、不同内容；只有 A 的 same.md 链接 target、带标签 #甲标签
	sameA := c.mustDo("POST", pa+"/notes", map[string]any{"path": "same.md", "content": "# A\n\n苹果 [[target]] #甲标签\n"}, 201)
	sameB := c.mustDo("POST", pb+"/notes", map[string]any{"path": "same.md", "content": "# B\n\n香蕉 #乙标签\n"}, 201)
	targetA := c.mustDo("POST", pa+"/notes", map[string]any{"path": "target.md", "content": "# T\n"}, 201)
	targetB := c.mustDo("POST", pb+"/notes", map[string]any{"path": "target.md", "content": "# T\n"}, 201)

	// 正文
	if out := c.mustDo("GET", pa+"/notes/by-path?path=same.md", nil, 200); !strings.Contains(out["content"].(string), "苹果") {
		t.Fatalf("A 的正文 = %v", out)
	}
	if out := c.mustDo("GET", pb+"/notes/by-path?path=same.md", nil, 200); !strings.Contains(out["content"].(string), "香蕉") {
		t.Fatalf("B 的正文 = %v", out)
	}
	// 一个空间的 id 在另一个空间里找不到
	if st, _ := c.do("GET", pb+"/notes/"+sameA["id"].(string), nil); st != 404 {
		t.Fatalf("B 里读 A 的笔记 = %d", st)
	}
	// 默认工作空间什么都没有
	if tree := c.mustDo("GET", "/api/tree", nil, 200); len(tree["notes"].([]any)) != 0 {
		t.Fatalf("默认工作空间不应有笔记：%v", tree)
	}

	// 搜索
	search := func(prefix, q string) string {
		st, b := c.rawH("GET", prefix+"/search?q="+q, nil, "")
		if st != 200 {
			t.Fatalf("搜索 %s%s = %d %s", prefix, q, st, b)
		}
		return string(b)
	}
	if r := search(pa, "苹果"); !strings.Contains(r, "same.md") {
		t.Fatalf("A 搜苹果 = %s", r)
	}
	for _, r := range []string{search(pb, "苹果"), search("/api", "苹果"), search(pa, "香蕉")} {
		if strings.Contains(r, "same.md") {
			t.Fatalf("搜索串到了别的空间：%s", r)
		}
	}

	// 反链和标签
	_, bl := c.rawH("GET", pa+"/notes/"+targetA["id"].(string)+"/backlinks", nil, "")
	if !strings.Contains(string(bl), "same.md") {
		t.Fatalf("A 的反链 = %s", bl)
	}
	_, bl = c.rawH("GET", pb+"/notes/"+targetB["id"].(string)+"/backlinks", nil, "")
	if strings.Contains(string(bl), "same.md") {
		t.Fatalf("B 的反链串了：%s", bl)
	}
	_, ta := c.rawH("GET", pa+"/tags", nil, "")
	_, tb := c.rawH("GET", pb+"/tags", nil, "")
	if !strings.Contains(string(ta), "甲标签") || strings.Contains(string(ta), "乙标签") || !strings.Contains(string(tb), "乙标签") || strings.Contains(string(tb), "甲标签") {
		t.Fatalf("标签串了：A %s / B %s", ta, tb)
	}

	// 附件：链接带工作空间前缀，别的空间读不到
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "图.png")
	fw.Write([]byte("\x89PNG A"))
	mw.Close()
	st, up := c.rawH("POST", pa+"/attachments", &buf, mw.FormDataContentType())
	var upOut struct{ URL, Path string }
	json.Unmarshal(up, &upOut)
	if st != 201 || !strings.HasPrefix(upOut.URL, pa+"/files/") {
		t.Fatalf("A 上传 = %d %s", st, up)
	}
	if st, b := c.rawH("GET", upOut.URL, nil, ""); st != 200 || string(b) != "\x89PNG A" {
		t.Fatalf("A 读附件 = %d %q", st, b)
	}
	if st, _ := c.rawH("GET", pb+strings.TrimPrefix(upOut.URL, pa), nil, ""); st != 404 {
		t.Fatalf("B 读 A 的附件 = %d", st)
	}

	// 回收站：删除 A 的 same.md，B 的不受影响
	c.mustDo("DELETE", pa+"/notes/"+sameA["id"].(string), nil, 200)
	if items := c.mustDo("GET", pa+"/trash", nil, 200)["items"].([]any); len(items) != 1 {
		t.Fatalf("A 回收站 = %v", items)
	}
	if items := c.mustDo("GET", pb+"/trash", nil, 200)["items"].([]any); len(items) != 0 {
		t.Fatalf("B 回收站 = %v", items)
	}
	if st, _ := c.do("POST", pb+"/trash/"+sameA["id"].(string)+"/restore", nil); st != 404 {
		t.Fatalf("B 里恢复 A 的回收站条目 = %d", st)
	}
	c.mustDo("GET", pb+"/notes/"+sameB["id"].(string), nil, 200)

	// 变更序号各自独立：B 只有自己的 2 次新建
	chB := c.mustDo("GET", pb+"/changes?since=0", nil, 200)
	if chB["seq"] != 2.0 || len(chB["changes"].([]any)) != 2 {
		t.Fatalf("B 的变更 = %v", chB)
	}
	chA := c.mustDo("GET", pa+"/changes?since=0", nil, 200)
	if chA["seq"].(float64) <= 2 {
		t.Fatalf("A 的变更 = %v", chA)
	}
	for _, ch := range chA["changes"].([]any) {
		if ch.(map[string]any)["id"] == sameB["id"] || ch.(map[string]any)["id"] == targetB["id"] {
			t.Fatalf("A 的变更里有 B 的笔记：%v", chA)
		}
	}
	if def := c.mustDo("GET", "/api/changes?since=0", nil, 200); def["seq"] != 0.0 {
		t.Fatalf("默认工作空间的变更 = %v", def)
	}

	// 文件夹、目录树
	c.mustDo("POST", pb+"/folders", map[string]any{"path": "只在乙"}, 201)
	if tree := c.mustDo("GET", pa+"/tree", nil, 200); strings.Contains(mustJSON(tree), "只在乙") {
		t.Fatalf("A 的目录树里有 B 的文件夹：%v", tree)
	}
}

// 验收：A 空间的 WebSocket 收不到 B 空间的变更。
func TestWorkspaceWebSocketIsolated(t *testing.T) {
	c := newServer(t, func(s *Server) { s.WSPingInterval = time.Hour })
	c.setup()
	_, pa := c.newWorkspace("甲")
	_, pb := c.newWorkspace("乙")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dial := func(prefix string) *websocket.Conn {
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(c.base, "http")+prefix+"/ws", &websocket.DialOptions{HTTPClient: c.hc})
		if err != nil {
			t.Fatalf("连接 %s/ws：%v", prefix, err)
		}
		t.Cleanup(func() { conn.CloseNow() })
		var hello map[string]any
		if err := wsjson.Read(ctx, conn, &hello); err != nil || hello["type"] != "hello" {
			t.Fatalf("%s hello = %v, %v", prefix, hello, err)
		}
		return conn
	}
	wa, wb, wd := dial(pa), dial(pb), dial("/api")
	next := func(conn *websocket.Conn) map[string]any {
		var m map[string]any
		if err := wsjson.Read(ctx, conn, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}

	// B 里写两篇，再在 A 里写一篇：A 收到的第一条必须是自己的
	c.mustDo("POST", pb+"/notes", map[string]any{"path": "b1.md", "content": "1"}, 201)
	c.mustDo("POST", pb+"/notes", map[string]any{"path": "b2.md", "content": "2"}, 201)
	c.mustDo("POST", pa+"/notes", map[string]any{"path": "a1.md", "content": "a"}, 201)
	if m := next(wa); m["path"] != "a1.md" || m["seq"] != 1.0 {
		t.Fatalf("A 的 WebSocket 收到了 %v，期望 a1.md（seq 1）", m)
	}
	if m := next(wb); m["path"] != "b1.md" || m["seq"] != 1.0 {
		t.Fatalf("B 第一条 = %v", m)
	}
	if m := next(wb); m["path"] != "b2.md" || m["seq"] != 2.0 {
		t.Fatalf("B 第二条 = %v", m)
	}
	// 默认工作空间的连接什么都不应收到：写一篇默认空间的笔记，它收到的第一条就是这篇
	c.mustDo("POST", "/api/notes", map[string]any{"path": "d.md", "content": "d"}, 201)
	if m := next(wd); m["path"] != "d.md" {
		t.Fatalf("默认工作空间的 WebSocket 收到了 %v", m)
	}
	// A、B 也收不到默认工作空间的变更
	c.mustDo("POST", pa+"/notes", map[string]any{"path": "a2.md", "content": "a"}, 201)
	if m := next(wa); m["path"] != "a2.md" {
		t.Fatalf("A 收到了 %v", m)
	}
}

// 助手（#61）：对话按工作空间存放，对话列表只显示当前工作空间的；供应商、模型、设置全局共用；
// 在 A 空间里生成不影响默认空间，按对话 id 跨空间访问是 404。
func TestAgentChatsPerWorkspace(t *testing.T) {
	opt, _ := withAgent(t, "m", &lockedBuffer{})
	c := newServer(t, opt)
	c.setup()
	llmSrv := fakeOpenAI(t, "sk-ws")
	p := c.mustDo("POST", "/api/agent/providers", map[string]any{"name": "本地", "kind": "openai", "base_url": llmSrv.URL + "/v1", "api_key": "sk-ws"}, 201)
	c.mustDo("POST", "/api/agent/providers/"+p["id"].(string)+"/models", map[string]any{"model": "fake-model", "context_window": 32000, "max_output": 4096}, 201)
	_, pa := c.newWorkspace("甲")
	_, pb := c.newWorkspace("乙")

	// 全局默认模型在每个空间新建对话时都生效
	dc := c.mustDo("POST", "/api/agent/chats", map[string]any{}, 201)
	ac := c.mustDo("POST", pa+"/agent/chats", map[string]any{}, 201)
	if ac["model_id"] == "" || ac["model_id"] != dc["model_id"] {
		t.Fatalf("甲空间的对话应使用全局默认模型：%v / %v", ac, dc)
	}
	ids := func(prefix string) []string {
		var out []string
		for _, x := range c.mustDo("GET", prefix+"/agent/chats", nil, 200)["chats"].([]any) {
			out = append(out, x.(map[string]any)["id"].(string))
		}
		return out
	}
	if got := ids("/api"); len(got) != 1 || got[0] != dc["id"] {
		t.Fatalf("默认空间的对话 = %v", got)
	}
	if got := ids(pa); len(got) != 1 || got[0] != ac["id"] {
		t.Fatalf("甲空间的对话 = %v", got)
	}
	if got := ids(pb); len(got) != 0 {
		t.Fatalf("乙空间的对话 = %v", got)
	}

	// 在甲空间里对话
	aid := ac["id"].(string)
	c.mustDo("POST", pa+"/agent/chats/"+aid+"/messages", map[string]any{"text": "你好"}, 202)
	deadline := time.Now().Add(5 * time.Second)
	var view map[string]any
	for time.Now().Before(deadline) {
		view = c.mustDo("GET", pa+"/agent/chats/"+aid, nil, 200)
		if msgs, _ := view["messages"].([]any); len(msgs) == 2 && view["running"] == false {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if msgs, _ := view["messages"].([]any); len(msgs) != 2 || view["running"] != false {
		t.Fatalf("甲空间的对话没有完成：%v", view)
	}

	// 跨空间访问同一个对话 id：404
	for _, tc := range [][3]string{
		{"GET", "/api", "/agent/chats/" + aid},
		{"GET", pb, "/agent/chats/" + aid},
		{"POST", pb, "/agent/chats/" + aid + "/messages"},
		{"GET", pb, "/agent/chats/" + aid + "/stream"},
		{"PATCH", pb, "/agent/chats/" + aid},
		{"DELETE", "/api", "/agent/chats/" + aid},
	} {
		body := any(nil)
		if tc[0] != "GET" {
			body = map[string]any{"text": "x", "title": "x"}
		}
		if st, out := c.do(tc[0], tc[1]+tc[2], body); st != 404 {
			t.Errorf("%s %s%s = %d %v，期望 404", tc[0], tc[1], tc[2], st, out)
		}
	}
	// 默认空间的对话没有被动过，删除甲空间的对话不影响别处
	if got := ids("/api"); len(got) != 1 || got[0] != dc["id"] {
		t.Fatalf("默认空间的对话 = %v", got)
	}
	c.mustDo("PATCH", pa+"/agent/chats/"+aid, map[string]any{"title": "新标题"}, 200)
	if st, _ := c.do("DELETE", pa+"/agent/chats/"+aid, nil); st != 204 {
		t.Errorf("删除甲空间的对话 = %d", st)
	}
	if got := ids(pa); len(got) != 0 {
		t.Fatalf("甲空间的对话 = %v", got)
	}
	if got := ids("/api"); len(got) != 1 {
		t.Fatalf("默认空间的对话 = %v", got)
	}
}
