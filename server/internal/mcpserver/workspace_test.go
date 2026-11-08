package mcpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/rt-game-440/lode/server/internal/audit"
	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/vault"
	"github.com/rt-game-440/lode/server/internal/workspace"
)

// #59：token 绑定工作空间，/mcp 只能访问绑定的那个。

func newWsEnv(t *testing.T) (*env, *workspace.Manager) {
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
	svc := notes.New(notes.Options{DB: d, Vault: v, TrashDir: filepath.Join(dir, "trash")})
	m := workspace.New(workspace.Options{Default: svc, DB: d, DataDir: dir, Debounce: 20 * time.Millisecond})
	t.Cleanup(m.Close)
	e := &env{notes: svc, auth: auth.New(d), audit: audit.New(d)}
	srv := httptest.NewServer(Handler(Options{Workspaces: m, Auth: e.auth, Audit: e.audit, Version: "test"}))
	t.Cleanup(srv.Close)
	e.url = srv.URL
	return e, m
}

func TestTokenIsBoundToItsWorkspace(t *testing.T) {
	ctx := context.Background()
	e, m := newWsEnv(t)
	if _, err := e.notes.Create(ctx, "A空间.md", "# A空间\n\n独有关键词alpha\n"); err != nil {
		t.Fatal(err)
	}
	bInfo, err := m.Create(ctx, workspace.CreateOptions{Name: "B"})
	if err != nil {
		t.Fatal(err)
	}
	bWS, err := m.Get(ctx, bInfo.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bWS.Notes.Create(ctx, "B空间.md", "# B空间\n\n独有关键词beta\n"); err != nil {
		t.Fatal(err)
	}

	mk := func(name, ws string) *mcp.ClientSession {
		_, secret, err := e.auth.CreateToken(ctx, name, auth.ScopeWrite, ws)
		if err != nil {
			t.Fatal(err)
		}
		return e.connect(t, secret)
	}
	csA, csB := mk("绑 A", "default"), mk("绑 B", bInfo.ID)

	// 搜索：各自只看得到自己空间的笔记
	res := mustOK(t, csA, "search_notes", map[string]any{"query": "alpha"})
	if hits := res["results"].([]any); len(hits) != 1 || hits[0].(map[string]any)["path"] != "A空间.md" {
		t.Fatalf("A 搜 alpha：%v", res)
	}
	if hits := mustOK(t, csA, "search_notes", map[string]any{"query": "beta"})["results"].([]any); len(hits) != 0 {
		t.Fatalf("绑 A 的 token 不应搜到 B 的笔记：%v", hits)
	}
	if hits := mustOK(t, csB, "search_notes", map[string]any{"query": "beta"})["results"].([]any); len(hits) != 1 || hits[0].(map[string]any)["path"] != "B空间.md" {
		t.Fatalf("B 搜 beta：%v", hits)
	}
	if hits := mustOK(t, csB, "search_notes", map[string]any{"query": "alpha"})["results"].([]any); len(hits) != 0 {
		t.Fatalf("绑 B 的 token 不应搜到 A 的笔记：%v", hits)
	}
	// 读取：跨空间读不到
	mustFail(t, csA, "read_note", map[string]any{"path": "B空间.md"}, "")
	mustFail(t, csB, "read_note", map[string]any{"path": "A空间.md"}, "")
	if got := mustOK(t, csB, "read_note", map[string]any{"path": "B空间.md"}); !strings.Contains(got["content"].(string), "beta") {
		t.Fatalf("B 读 B：%v", got)
	}
	// 写入落在绑定的空间
	mustOK(t, csB, "create_note", map[string]any{"path": "新.md", "content": "# 新\n"})
	if _, err := bWS.Notes.ReadByPath(ctx, "新.md"); err != nil {
		t.Fatalf("B 空间应有新笔记：%v", err)
	}
	if _, err := e.notes.ReadByPath(ctx, "新.md"); err == nil {
		t.Fatal("默认空间不应有这篇笔记")
	}

	// 审计记录空间，并可按空间筛选
	all, _ := e.audit.List(ctx, 100, "")
	inA, _ := e.audit.List(ctx, 100, "default")
	inB, _ := e.audit.List(ctx, 100, bInfo.ID)
	if len(inA) != 3 || len(inB) != 5 || len(all) != 8 {
		t.Fatalf("审计条数 全部 %d A %d B %d", len(all), len(inA), len(inB))
	}
	for _, en := range inB {
		if en.Workspace != bInfo.ID || en.TokenName != "绑 B" {
			t.Fatalf("B 的审计：%+v", en)
		}
	}
	for _, en := range inA {
		if en.Workspace != "default" || en.TokenName != "绑 A" {
			t.Fatalf("A 的审计：%+v", en)
		}
	}
}

// 验收：升级后旧 token 属于默认空间且仍然可用；删除空间后它的 token 返回 401。
func TestLegacyTokenAndRemovedWorkspace(t *testing.T) {
	ctx := context.Background()
	e, m := newWsEnv(t)
	if _, err := e.notes.Create(ctx, "旧.md", "# 旧笔记\n"); err != nil {
		t.Fatal(err)
	}
	// 迁移 0006 之前创建的 token：没有 workspace_id 列的值，靠列默认值归入 default
	_, legacy, err := e.auth.CreateToken(ctx, "旧 token", auth.ScopeRead, "")
	if err != nil {
		t.Fatal(err)
	}
	toks, _ := e.auth.ListTokens(ctx)
	if len(toks) != 1 || toks[0].Workspace != "default" {
		t.Fatalf("token = %+v", toks)
	}
	cs := e.connect(t, legacy)
	if hits := mustOK(t, cs, "search_notes", map[string]any{"query": "旧笔记"})["results"].([]any); len(hits) != 1 {
		t.Fatalf("旧 token 应能搜到默认空间的笔记：%v", hits)
	}

	b, _ := m.Create(ctx, workspace.CreateOptions{Name: "B"})
	_, secret, err := e.auth.CreateToken(ctx, "绑 B", auth.ScopeRead, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	status := func(token string) int {
		req, _ := http.NewRequest("POST", e.url, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_notes","arguments":{}}}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if st := status(secret); st != 200 {
		t.Fatalf("删除前 = %d", st)
	}
	if _, err := m.Remove(ctx, b.ID); err != nil {
		t.Fatal(err)
	}
	if st := status(secret); st != 401 {
		t.Fatalf("删除空间后它的 token 应 401，得到 %d", st)
	}
	if st := status(legacy); st != 200 {
		t.Fatalf("其他空间的 token 不受影响，得到 %d", st)
	}
	if toks, _ := e.auth.ListTokens(ctx); len(toks) != 1 || toks[0].Name != "旧 token" {
		t.Fatalf("剩余 token = %+v", toks)
	}
}
