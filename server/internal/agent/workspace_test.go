package agent

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/llm"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/tools"
	"github.com/rt-game-440/lode/server/internal/vault"
)

// 工作空间隔离（#61）：同一个 Service 服务多个 Space，对话、工具、正在生成的任务互不影响。

type testSpace struct {
	Space
	notes *notes.Service
	vault string
	db    *sql.DB
}

// newSpace 建一个独立的工作空间：自己的库（对话和笔记索引同库，和真实的 index.db 一样）、vault 和工具。
func newSpace(t *testing.T, id string) *testSpace {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	v, err := vault.New(filepath.Join(dir, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	ns := notes.New(notes.Options{DB: d, Vault: v, TrashDir: filepath.Join(dir, "trash")})
	return &testSpace{Space: Space{ID: id, Chats: NewChatStore(d), Tools: tools.New(ns), Notes: ns}, notes: ns, vault: filepath.Join(dir, "vault"), db: d}
}

func TestSpaceToolsOnlyTouchOwnWorkspace(t *testing.T) {
	ctx := context.Background()
	a, b := newSpace(t, "aaaaaa"), newSpace(t, "bbbbbb")
	f := newFixture(t, func(results []string) string {
		switch len(results) {
		case 0:
			return toolCallFrame("c1", "search_notes", `{"query":"secretword"}`)
		case 1:
			return toolCallFrame("c2", "read_note", `{"path":"机密.md"}`)
		case 2:
			return toolCallFrame("c3", "list_notes", `{"recursive":true}`)
		case 3:
			return toolCallFrame("c4", "create_note", `{"path":"助手新建.md","content":"# 助手新建\n\nsecretword in A"}`)
		default:
			return textFrame("完成")
		}
	})
	f.sp = a.Space
	if _, err := b.notes.Create(ctx, "机密.md", "# 机密\n\nB 空间的 secretword"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.notes.Create(ctx, "公开.md", "# 公开\n\n没有那个词"); err != nil {
		t.Fatal(err)
	}
	// 对照：B 自己的搜索确实能搜到，否则下面的断言没有意义
	if rs, err := b.notes.Search(ctx, notes.SearchQuery{Query: "secretword", Limit: 5}); err != nil || len(rs) != 1 {
		t.Fatalf("B 的搜索 = %v %v", rs, err)
	}
	if _, err := f.svc.Store.UpdateSettings(ctx, Settings{DefaultModel: f.model.ID, AutoApprove: true}); err != nil {
		t.Fatal(err)
	}
	chat, _ := a.Chats.CreateChat(ctx, "")
	evs := f.send(t, chat.ID, "帮我整理")
	if got := types(evs); !strings.HasSuffix(got, "done:stop") {
		t.Fatalf("事件：%s", got)
	}

	msgs, _ := a.Chats.Messages(ctx, chat.ID)
	var results []llm.ToolResult
	for _, m := range msgs {
		for _, p := range m.Parts {
			if p.Type == llm.PartToolResult {
				results = append(results, *p.Result)
			}
		}
	}
	if len(results) != 4 {
		t.Fatalf("工具结果 %d 条：%+v", len(results), results)
	}
	if strings.Contains(results[0].Content, "机密") || strings.Contains(results[0].Content, "B 空间") {
		t.Errorf("A 的搜索看到了 B 的笔记：%s", results[0].Content)
	}
	if !results[1].IsError {
		t.Errorf("A 不应读到 B 的笔记：%+v", results[1])
	}
	if strings.Contains(results[2].Content, "机密") || !strings.Contains(results[2].Content, "公开.md") {
		t.Errorf("A 的目录列表：%s", results[2].Content)
	}
	// 写入只落在 A
	if _, err := os.Stat(filepath.Join(a.vault, "助手新建.md")); err != nil {
		t.Errorf("A 的 vault 里应有新笔记：%v", err)
	}
	if _, err := os.Stat(filepath.Join(b.vault, "助手新建.md")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("B 的 vault 里不应有新笔记：%v", err)
	}
	if _, err := b.notes.GetByPath(ctx, "助手新建.md"); !errors.Is(err, notes.ErrNotFound) {
		t.Errorf("B 的索引里不应有新笔记：%v", err)
	}
	// @ 提及也只认本空间的笔记
	if _, err := f.svc.Send(ctx, a.Space, chat.ID, SendInput{Text: "看看", Mentions: []string{"机密.md"}}); err == nil || !errors.Is(err, ErrInvalid) {
		t.Errorf("@ 其他空间的笔记应报错：%v", err)
	}
	// 笔记变更的设备是助手，且记在 A 的变更序列里
	if ch, _, _ := b.notes.Changes(ctx, 0, 100); len(ch) != 1 {
		t.Errorf("B 的变更序列只应有自己建的 1 条：%d", len(ch))
	}
}

func TestSpaceChatsAreSeparate(t *testing.T) {
	ctx := context.Background()
	a, b := newSpace(t, "aaaaaa"), newSpace(t, "bbbbbb")
	f := newFixture(t, func([]string) string { return textFrame("好的") })
	ca, _ := a.Chats.CreateChat(ctx, "")
	cb, _ := b.Chats.CreateChat(ctx, "")
	f.sp = a.Space
	f.send(t, ca.ID, "A 的问题")

	if list, _ := b.Chats.Chats(ctx, 50); len(list) != 1 || list[0].ID != cb.ID {
		t.Errorf("B 的对话列表：%+v", list)
	}
	if list, _ := a.Chats.Chats(ctx, 50); len(list) != 1 || list[0].ID != ca.ID || list[0].Title != "A 的问题" {
		t.Errorf("A 的对话列表：%+v", list)
	}
	// 在 B 里按 A 的对话 id 找不到
	if _, err := f.svc.View(ctx, b.Space, ca.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("B 里读 A 的对话：%v", err)
	}
	if _, err := f.svc.Send(ctx, b.Space, ca.ID, SendInput{Text: "串了"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("B 里给 A 的对话发消息：%v", err)
	}
	if msgs, _ := b.Chats.Messages(ctx, ca.ID); len(msgs) != 0 {
		t.Errorf("B 的库里不应有 A 的消息：%+v", msgs)
	}
	// 同一个对话 id 在两个空间里互不干扰（运行记录按空间区分）
	if f.svc.Running(b.Space, ca.ID) || f.svc.Running(a.Space, ca.ID) {
		t.Error("没有在生成")
	}
}

// 正在生成的任务记在对应空间名下：关闭 A 只取消 A 的任务，B 的任务不受影响，A 的库里保存已生成的部分。
func TestCloseWorkspaceOnlyCancelsThatWorkspace(t *testing.T) {
	ctx := context.Background()
	a, b := newSpace(t, "aaaaaa"), newSpace(t, "bbbbbb")
	f := newFixture(t, nil)
	f.llm.script = nil
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, `data: {"choices":[{"index":0,"delta":{"content":"写到一半"}}]}`+"\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer srv.Close()
	defer close(release)
	key := "k"
	p, _ := f.svc.Store.CreateProvider(ctx, ProviderInput{Name: "慢", Kind: llm.KindOpenAI, BaseURL: srv.URL, APIKey: &key})
	m, _ := f.svc.Store.CreateModel(ctx, p.ID, ModelInput{Model: "slow", ContextWindow: 8000, MaxOutput: 1000})
	ca, _ := a.Chats.CreateChat(ctx, m.ID)
	cb, _ := b.Chats.CreateChat(ctx, m.ID)

	start := func(sp Space, id string) <-chan Event {
		ch, unsub := f.svc.Subscribe(sp, id)
		t.Cleanup(unsub)
		<-ch
		if _, err := f.svc.Send(ctx, sp, id, SendInput{Text: "写点东西"}); err != nil {
			t.Fatal(err)
		}
		for e := range ch {
			if e.Type == "text" {
				break
			}
		}
		return ch
	}
	cha := start(a.Space, ca.ID)
	start(b.Space, cb.ID)
	if !f.svc.Running(a.Space, ca.ID) || !f.svc.Running(b.Space, cb.ID) {
		t.Fatal("两个空间的任务都应在生成")
	}
	if f.svc.Running(b.Space, ca.ID) {
		t.Fatal("B 空间名下没有 A 的对话在生成")
	}

	f.svc.CloseWorkspace(a.ID)
	if f.svc.Running(a.Space, ca.ID) {
		t.Error("CloseWorkspace 返回时 A 的任务应已结束")
	}
	waitDone(t, cha)
	msgsA, _ := a.Chats.Messages(ctx, ca.ID)
	if last := msgsA[len(msgsA)-1]; !last.Meta.Stopped || last.Parts[0].Text != "写到一半" {
		t.Errorf("A 已生成的部分应保存并标记停止：%+v", last)
	}
	if !f.svc.Running(b.Space, cb.ID) {
		t.Error("B 的任务不应受影响")
	}
	// 关闭后不再接受 A 的新生成；B 照常
	if _, err := f.svc.Send(ctx, a.Space, ca.ID, SendInput{Text: "再来"}); err == nil {
		t.Error("关闭后的工作空间不应再开始生成")
	}
	f.svc.CloseWorkspace(a.ID) // 可以重复调用

	deadline := time.Now().Add(2 * time.Second)
	f.svc.Stop(ctx, b.Space, cb.ID)
	for f.svc.Running(b.Space, cb.ID) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	msgsB, _ := b.Chats.Messages(ctx, cb.ID)
	if last := msgsB[len(msgsB)-1]; !last.Meta.Stopped || last.Parts[0].Text != "写到一半" {
		t.Errorf("B 的任务正常停止并保存：%+v", last)
	}
}
