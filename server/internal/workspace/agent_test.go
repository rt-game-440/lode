package workspace

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rt-game-440/lode/server/internal/agent"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/llm"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/vault"
)

// #61：助手对话按工作空间存放。

// 升级前（迁移 0006 之前）的 app.db 里的对话、消息和待批准操作，升级后在默认工作空间完整可读；
// 新建的工作空间没有任何对话。
func TestUpgradedChatsBelongToDefaultWorkspace(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	path := filepath.Join(dataDir, "app.db")
	old, err := db.Connect(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.MigrateTo(ctx, old, releasedVersion); err != nil {
		t.Fatal(err)
	}
	chats := agent.NewChatStore(old)
	c, err := chats.CreateChat(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	title := "旧对话"
	if _, err := chats.UpdateChat(ctx, c.ID, &title, nil, nil); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"你好", "你也好"} {
		if _, err := chats.AddMessage(ctx, c.ID, agent.Message{Role: llm.RoleUser, Parts: []llm.Part{{Type: llm.PartText, Text: text}}}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := old.ExecContext(ctx, `INSERT INTO agent_pending(chat_id, call_id, name, args, preview, created_at) VALUES (?, 'call_1', 'create_note', '{"path":"a.md"}', '{"action":"create","path":"a.md"}', 1)`, c.ID); err != nil {
		t.Fatal(err)
	}
	old.Close()

	// 用新版本打开（迁移到最新）并装配 Manager
	d, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	v, _ := vault.New(filepath.Join(dataDir, "vault"))
	m := New(Options{Default: notes.New(notes.Options{DB: d, Vault: v, TrashDir: filepath.Join(dataDir, "trash")}), DB: d, DataDir: dataDir})
	t.Cleanup(m.Close)
	svc := &agent.Service{Store: agent.NewStore(d, nil)}
	t.Cleanup(svc.Close)

	sp := m.Default().AgentSpace(svc.Store.DefaultChats())
	if sp.ID != DefaultID {
		t.Fatalf("空间 id = %q", sp.ID)
	}
	view, err := svc.View(ctx, sp, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if view.Chat.Title != "旧对话" || len(view.Messages) != 2 || view.Messages[1].Parts[0].Text != "你也好" ||
		len(view.Pending) != 1 || view.Pending[0].CallID != "call_1" || view.Pending[0].Preview.Path != "a.md" {
		t.Errorf("升级后的旧对话：%+v", view)
	}
	if list, _ := sp.Chats.Chats(ctx, 50); len(list) != 1 {
		t.Errorf("默认工作空间的对话列表：%+v", list)
	}

	info, err := m.Create(ctx, CreateOptions{Name: "新"})
	if err != nil {
		t.Fatal(err)
	}
	ws, err := m.Get(ctx, info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ws.Chats == nil || ws.AgentSpace(svc.Store.DefaultChats()).Chats != ws.Chats {
		t.Fatal("非默认工作空间应有自己的对话库")
	}
	if list, _ := ws.Chats.Chats(ctx, 50); len(list) != 0 {
		t.Errorf("新工作空间不应有旧对话：%+v", list)
	}
	if _, err := ws.Chats.Chat(ctx, c.ID); err == nil {
		t.Error("新工作空间里不应读到默认工作空间的对话")
	}
}

// 对话在各自工作空间的库里：关闭并移走 A（删除工作空间时 #59 做的事）不影响 B 和默认工作空间的对话，
// 重启后各自的对话仍在。
func TestRemovingWorkspaceDeletesOnlyItsChats(t *testing.T) {
	ctx := context.Background()
	m, dataDir, global := newManager(t)
	svc := &agent.Service{Store: agent.NewStore(global, nil)}
	t.Cleanup(svc.Close)
	m.Start(ctx)

	mk := func(name string) (*Workspace, agent.Chat) {
		info, err := m.Create(ctx, CreateOptions{Name: name})
		if err != nil {
			t.Fatal(err)
		}
		ws, err := m.Get(ctx, info.ID)
		if err != nil {
			t.Fatal(err)
		}
		c, err := ws.Chats.CreateChat(ctx, "")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ws.Chats.AddMessage(ctx, c.ID, agent.Message{Role: llm.RoleUser, Parts: []llm.Part{{Type: llm.PartText, Text: name + "的消息"}}}); err != nil {
			t.Fatal(err)
		}
		return ws, c
	}
	a, ca := mk("甲")
	b, cb := mk("乙")
	dc, err := svc.Store.DefaultChats().CreateChat(ctx, "")
	if err != nil {
		t.Fatal(err)
	}

	// 删除 A：先让助手放弃 A 名下的任务，再关库、移走目录（#59 的删除流程）
	svc.CloseWorkspace(a.ID)
	a.closeDB()
	if err := os.RemoveAll(PathsFor(dataDir, a.ID, "").Root); err != nil {
		t.Fatal(err)
	}
	if _, err := global.ExecContext(ctx, `DELETE FROM workspaces WHERE id = ?`, a.ID); err != nil {
		t.Fatal(err)
	}

	if msgs, err := b.Chats.Messages(ctx, cb.ID); err != nil || len(msgs) != 1 || msgs[0].Parts[0].Text != "乙的消息" {
		t.Errorf("B 的对话：%v %v", msgs, err)
	}
	if _, err := svc.Store.DefaultChats().Chat(ctx, dc.ID); err != nil {
		t.Errorf("默认工作空间的对话：%v", err)
	}
	if _, err := a.Chats.Chat(ctx, ca.ID); err == nil {
		t.Error("A 的库已关闭，读它的对话应失败")
	}
	// 登记表里没有 A 了；它的对话随目录一起没有了
	if _, err := m.Get(ctx, a.ID); err != nil && !isNotFound(err) {
		t.Errorf("Get 已删除的 A：%v", err)
	}

	// 重启：新的 Manager 重新打开 B，对话仍在
	m.Close()
	m2 := New(Options{Default: m.Default().Notes, DB: global, DataDir: dataDir, Debounce: 20 * time.Millisecond})
	t.Cleanup(m2.Close)
	b2, err := m2.Get(ctx, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if list, _ := b2.Chats.Chats(ctx, 50); len(list) != 1 || list[0].ID != cb.ID {
		t.Errorf("重启后 B 的对话：%+v", list)
	}
}

func isNotFound(err error) bool { return err == ErrNotFound }
