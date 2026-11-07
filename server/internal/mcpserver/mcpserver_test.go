package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/rt-game-440/lode/server/internal/audit"
	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/tools"
	"github.com/rt-game-440/lode/server/internal/vault"
)

type env struct {
	url   string
	notes *notes.Service
	auth  *auth.Auth
	audit *audit.Log
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dir := t.TempDir()
	ctx := context.Background()
	d, err := db.Open(ctx, filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	v, err := vault.New(filepath.Join(dir, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	e := &env{
		notes: notes.New(notes.Options{DB: d, Vault: v, TrashDir: filepath.Join(dir, "trash")}),
		auth:  auth.New(d),
		audit: audit.New(d),
	}
	srv := httptest.NewServer(Handler(Options{Tools: tools.New(e.notes), Auth: e.auth, Audit: e.audit, Version: "test"}))
	t.Cleanup(srv.Close)
	e.url = srv.URL
	return e
}

func (e *env) token(t *testing.T, name, scope string) string {
	t.Helper()
	_, secret, err := e.auth.CreateToken(context.Background(), name, scope)
	if err != nil {
		t.Fatal(err)
	}
	return secret
}

type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

func (e *env) connect(t *testing.T, token string) *mcp.ClientSession {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "lode-test", Version: "0"}, nil)
	cs, err := c.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint:   e.url,
		HTTPClient: &http.Client{Transport: bearer{token}},
		MaxRetries: -1,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

// callTool 调用工具，返回结果文本和是否为工具错误。
func callTool(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) (string, bool) {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s 协议错误：%v", name, err)
	}
	if len(res.Content) != 1 {
		t.Fatalf("%s 应返回一段文本，得到 %d 段", name, len(res.Content))
	}
	return res.Content[0].(*mcp.TextContent).Text, res.IsError
}

// mustOK 调用工具并要求成功，把结果解析为 JSON 对象。
func mustOK(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) map[string]any {
	t.Helper()
	text, isErr := callTool(t, cs, name, args)
	if isErr {
		t.Fatalf("%s 失败：%s", name, text)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("%s 的结果不是 JSON：%s", name, text)
	}
	return out
}

// mustFail 调用工具并要求返回工具错误，错误说明应包含 want。
func mustFail(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any, want string) {
	t.Helper()
	text, isErr := callTool(t, cs, name, args)
	if !isErr || !strings.Contains(text, want) {
		t.Fatalf("%s 应失败并提到 %q，得到 isError=%v：%s", name, want, isErr, text)
	}
}

func toolNames(t *testing.T, cs *mcp.ClientSession) []string {
	t.Helper()
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range res.Tools {
		names = append(names, tl.Name)
		if tl.Description == "" || tl.InputSchema == nil {
			t.Errorf("%s 缺少描述或 schema", tl.Name)
		}
	}
	return names
}

func TestReadWriteTokenUsesEveryTool(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.notes.Create(ctx, "项目/计划.md", "# 计划\n\n第一步：调研 #工作\n第二步：动手\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.notes.Create(ctx, "日记.md", "今天推进了[[计划]]。\n"); err != nil {
		t.Fatal(err)
	}
	cs := e.connect(t, e.token(t, "Claude Code", auth.ScopeWrite))

	names := toolNames(t, cs)
	want := []string{"search_notes", "read_note", "list_notes", "create_note", "update_note", "move_note", "delete_note", "get_backlinks", "list_tags", "get_notes_by_tag"}
	slices.Sort(names)
	slices.Sort(want)
	if !slices.Equal(names, want) {
		t.Fatalf("读写 token 应看到全部工具：%v", names)
	}

	got := mustOK(t, cs, "search_notes", map[string]any{"query": "调研"})
	hits := got["results"].([]any)
	if len(hits) != 1 || hits[0].(map[string]any)["path"] != "项目/计划.md" || !strings.Contains(hits[0].(map[string]any)["snippet"].(string), "**调研**") {
		t.Fatalf("search_notes：%v", got)
	}

	got = mustOK(t, cs, "read_note", map[string]any{"path": "项目/计划.md"})
	if got["rev"] != 1.0 || !strings.HasPrefix(got["content"].(string), "# 计划") || got["total_lines"] != 4.0 {
		t.Fatalf("read_note：%v", got)
	}

	got = mustOK(t, cs, "list_notes", map[string]any{})
	if !slices.Equal(got["folders"].([]any), []any{"项目"}) || len(got["notes"].([]any)) != 1 {
		t.Fatalf("list_notes：%v", got)
	}

	got = mustOK(t, cs, "create_note", map[string]any{"path": "收件箱/想法.md", "content": "# 想法\n"})
	if got["path"] != "收件箱/想法.md" || got["rev"] != 1.0 {
		t.Fatalf("create_note：%v", got)
	}

	got = mustOK(t, cs, "update_note", map[string]any{"path": "收件箱/想法.md", "base_rev": 1, "mode": "append", "content": "- 写 MCP 文档"})
	if got["rev"] != 2.0 {
		t.Fatalf("update_note append：%v", got)
	}
	got = mustOK(t, cs, "update_note", map[string]any{"path": "收件箱/想法.md", "base_rev": 2, "mode": "patch",
		"edits": []map[string]any{{"old": "MCP 文档", "new": "MCP 接入文档"}}})
	if got["rev"] != 3.0 {
		t.Fatalf("update_note patch：%v", got)
	}
	got = mustOK(t, cs, "update_note", map[string]any{"path": "收件箱/想法.md", "base_rev": 3, "mode": "replace", "content": "# 想法\n\n全新内容\n"})
	if got["rev"] != 4.0 {
		t.Fatalf("update_note replace：%v", got)
	}
	n, _ := e.notes.ReadByPath(ctx, "收件箱/想法.md")
	if n.Content != "# 想法\n\n全新内容\n" {
		t.Fatalf("写入结果：%q", n.Content)
	}

	got = mustOK(t, cs, "get_backlinks", map[string]any{"path": "项目/计划.md"})
	if bl := got["backlinks"].([]any); len(bl) != 1 || bl[0].(map[string]any)["path"] != "日记.md" {
		t.Fatalf("get_backlinks：%v", got)
	}

	got = mustOK(t, cs, "move_note", map[string]any{"from": "项目/计划.md", "to": "项目/2026 计划.md"})
	if got["path"] != "项目/2026 计划.md" || !slices.Equal(got["updated_links"].([]any), []any{"日记.md"}) {
		t.Fatalf("move_note 应同时更新引用：%v", got)
	}

	got = mustOK(t, cs, "list_tags", nil)
	if tags := got["tags"].([]any); len(tags) != 1 || tags[0].(map[string]any)["tag"] != "工作" {
		t.Fatalf("list_tags：%v", got)
	}
	got = mustOK(t, cs, "get_notes_by_tag", map[string]any{"tag": "#工作"})
	if ns := got["notes"].([]any); len(ns) != 1 || ns[0].(map[string]any)["path"] != "项目/2026 计划.md" {
		t.Fatalf("get_notes_by_tag：%v", got)
	}

	got = mustOK(t, cs, "delete_note", map[string]any{"path": "日记.md"})
	if got["trashed"] != true {
		t.Fatalf("delete_note：%v", got)
	}
	if trash, _ := e.notes.ListTrash(ctx); len(trash) != 1 || trash[0].Path != "日记.md" {
		t.Fatalf("应进回收站：%v", trash)
	}
}

func TestToolErrors(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.notes.Create(ctx, "a.md", "一\n\n二\n\n三\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.notes.Create(ctx, "重复.md", "待办\n待办\n"); err != nil {
		t.Fatal(err)
	}
	cs := e.connect(t, e.token(t, "Codex", auth.ScopeWrite))

	mustFail(t, cs, "read_note", map[string]any{"path": "不存在.md"}, "找不到 不存在.md")
	mustFail(t, cs, "update_note", map[string]any{"path": "不存在.md", "base_rev": 1, "mode": "append", "content": "x"}, "找不到")
	mustFail(t, cs, "read_note", map[string]any{"path": "../../etc/passwd.md"}, "路径不合法")
	mustFail(t, cs, "create_note", map[string]any{"path": "子/../../外面.md", "content": ""}, "路径不合法")
	mustFail(t, cs, "list_notes", map[string]any{"path_prefix": ".."}, "路径不合法")
	mustFail(t, cs, "create_note", map[string]any{"path": "a.md", "content": ""}, "已存在")
	mustFail(t, cs, "read_note", map[string]any{}, "参数不合法")
	mustFail(t, cs, "update_note", map[string]any{"path": "a.md", "base_rev": 1, "mode": "patch",
		"edits": []map[string]any{{"old": "待办", "new": "完成"}}}, "没有匹配到")
	mustFail(t, cs, "update_note", map[string]any{"path": "重复.md", "base_rev": 1, "mode": "patch",
		"edits": []map[string]any{{"old": "待办", "new": "完成"}}}, "匹配到 2 处")

	// base_rev 过期：改动不重叠时自动合并
	if _, err := e.notes.Update(ctx, mustID(t, e, "a.md"), 1, "一 改\n\n二\n\n三\n"); err != nil {
		t.Fatal(err)
	}
	got := mustOK(t, cs, "update_note", map[string]any{"path": "a.md", "base_rev": 1, "mode": "replace", "content": "一\n\n二\n\n三 改\n"})
	if got["merged"] != true || got["rev"] != 3.0 {
		t.Fatalf("不重叠的过期修改应自动合并：%v", got)
	}
	// base_rev 过期且冲突：笔记不变，生成冲突副本
	mustFail(t, cs, "update_note", map[string]any{"path": "a.md", "base_rev": 1, "mode": "replace", "content": "一 另一种改法\n\n二\n\n三\n"}, "冲突副本")
	if n, _ := e.notes.ReadByPath(ctx, "a.md"); n.Content != "一 改\n\n二\n\n三 改\n" || n.Rev != 3 {
		t.Fatalf("冲突时笔记应保持服务器版本：%q rev %d", n.Content, n.Rev)
	}
}

func mustID(t *testing.T, e *env, p string) string {
	t.Helper()
	n, err := e.notes.GetByPath(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	return n.ID
}

func TestReadOnlyTokenCannotSeeOrCallWriteTools(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.notes.Create(ctx, "a.md", "内容\n"); err != nil {
		t.Fatal(err)
	}
	cs := e.connect(t, e.token(t, "只读脚本", auth.ScopeRead))
	names := toolNames(t, cs)
	slices.Sort(names)
	if !slices.Equal(names, []string{"get_backlinks", "get_notes_by_tag", "list_notes", "list_tags", "read_note", "search_notes"}) {
		t.Fatalf("只读 token 只应看到只读工具：%v", names)
	}
	mustOK(t, cs, "read_note", map[string]any{"path": "a.md"})
	for _, name := range []string{"create_note", "update_note", "delete_note", "move_note"} {
		res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: map[string]any{"path": "a.md", "content": "x"}})
		if err == nil && !res.IsError {
			t.Fatalf("只读 token 调用 %s 应被拒", name)
		}
	}
	if n, _ := e.notes.ReadByPath(ctx, "a.md"); n.Content != "内容\n" {
		t.Fatalf("笔记不应被改：%q", n.Content)
	}
}

func TestBadTokensGet401(t *testing.T) {
	e := newEnv(t)
	revoked := e.token(t, "旧", auth.ScopeWrite)
	list, _ := e.auth.ListTokens(context.Background())
	if err := e.auth.RevokeToken(context.Background(), list[0].ID); err != nil {
		t.Fatal(err)
	}
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`
	for name, header := range map[string]string{
		"无 token":     "",
		"错误 token":    "Bearer lode_not-a-real-token",
		"已吊销 token":   "Bearer " + revoked,
		"非 Bearer 方案": "Basic " + revoked,
	} {
		req, _ := http.NewRequest(http.MethodPost, e.url, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if header != "" {
			req.Header.Set("Authorization", header)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s 应返回 401，得到 %d", name, res.StatusCode)
		}
	}
}

func TestCallsAreAuditedAndProduceChangesFromTokenDevice(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.notes.Create(ctx, "a.md", "内容\n"); err != nil {
		t.Fatal(err)
	}
	from, err := e.notes.LatestSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cs := e.connect(t, e.token(t, "Claude Code", auth.ScopeWrite))
	mustOK(t, cs, "update_note", map[string]any{"path": "a.md", "base_rev": 1, "mode": "append", "content": "MCP 追加"})
	mustFail(t, cs, "read_note", map[string]any{"path": "没有.md"}, "找不到")

	changes, _, err := e.notes.Changes(ctx, from, 100)
	if err != nil || len(changes) != 1 {
		t.Fatalf("MCP 写入应产生一条变更：%+v, %v", changes, err)
	}
	if c := changes[0]; c.Path != "a.md" || c.DeviceName != "Claude Code" || !strings.HasPrefix(c.DeviceID, "mcp:") {
		t.Fatalf("变更的设备应为 token：%+v", c)
	}

	entries, err := e.audit.List(ctx, 10)
	if err != nil || len(entries) != 2 {
		t.Fatalf("应有 2 条审计记录：%+v, %v", entries, err)
	}
	if a := entries[0]; a.Tool != "read_note" || a.OK || a.Target != "没有.md" || a.TokenName != "Claude Code" || !strings.Contains(a.Error, "找不到") {
		t.Fatalf("失败调用的审计记录：%+v", a)
	}
	if a := entries[1]; a.Tool != "update_note" || !a.OK || a.Target != "a.md" {
		t.Fatalf("成功调用的审计记录：%+v", a)
	}
}
