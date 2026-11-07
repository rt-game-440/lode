package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/llm"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/secret"
	"github.com/rt-game-440/lode/server/internal/tools"
	"github.com/rt-game-440/lode/server/internal/vault"
)

// fakeLLM 是脚本化的 OpenAI 兼容服务：按请求里已有的工具结果条数决定下一步。
type fakeLLM struct {
	mu       sync.Mutex
	requests []map[string]any
	script   func(toolResults []string) string // 返回一段 SSE 帧（不含 [DONE]）
}

func (f *fakeLLM) handler(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	var body map[string]any
	json.Unmarshal(b, &body)
	f.mu.Lock()
	f.requests = append(f.requests, body)
	f.mu.Unlock()
	var results []string
	for _, m := range body["messages"].([]any) {
		mm := m.(map[string]any)
		if mm["role"] == "tool" {
			results = append(results, mm["content"].(string))
		}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, f.script(results)+"\n\ndata: [DONE]\n\n")
}

func (f *fakeLLM) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[len(f.requests)-1]
}

func toolCallFrame(id, name, args string) string {
	a, _ := json.Marshal(args)
	return fmt.Sprintf(`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":%q,"type":"function","function":{"name":%q,"arguments":%s}}]},"finish_reason":"tool_calls"}]}`, id, name, a)
}

func textFrame(s string) string {
	b, _ := json.Marshal(s)
	return fmt.Sprintf(`data: {"choices":[{"index":0,"delta":{"content":%s},"finish_reason":"stop"}]}`+"\n\n"+`data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":5}}`, b)
}

type fixture struct {
	svc   *Service
	notes *notes.Service
	vault string
	llm   *fakeLLM
	model Model
}

func newFixture(t *testing.T, script func([]string) string) *fixture {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	v, err := vault.New(filepath.Join(dir, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	ns := notes.New(notes.Options{DB: d, Vault: v, TrashDir: filepath.Join(dir, "trash")})
	f := &fixture{notes: ns, vault: filepath.Join(dir, "vault"), llm: &fakeLLM{script: script}}
	srv := httptest.NewServer(http.HandlerFunc(f.llm.handler))
	t.Cleanup(srv.Close)

	store := NewStore(d, secret.New("test-master-key"))
	f.svc = &Service{Store: store, Tools: tools.New(ns), Notes: ns}
	t.Cleanup(f.svc.Close)
	key := "sk-fake"
	p, err := store.CreateProvider(context.Background(), ProviderInput{Name: "模拟", Kind: llm.KindOpenAI, BaseURL: srv.URL + "/v1", APIKey: &key})
	if err != nil {
		t.Fatal(err)
	}
	f.model, err = store.CreateModel(context.Background(), p.ID, ModelInput{Model: "fake-1", ContextWindow: 32000, MaxOutput: 2000})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// send 发送一条消息并等到这次生成结束，返回收到的事件。
func (f *fixture) send(t *testing.T, chatID, text string) []Event {
	t.Helper()
	ch, unsub := f.svc.Subscribe(chatID)
	defer unsub()
	<-ch // 状态快照
	if _, err := f.svc.Send(context.Background(), chatID, SendInput{Text: text}); err != nil {
		t.Fatal(err)
	}
	return waitDone(t, ch)
}

func (f *fixture) resolve(t *testing.T, chatID, callID string, approve bool) []Event {
	t.Helper()
	ch, unsub := f.svc.Subscribe(chatID)
	defer unsub()
	<-ch
	if err := f.svc.Resolve(context.Background(), chatID, callID, approve); err != nil {
		t.Fatal(err)
	}
	return waitDone(t, ch)
}

func waitDone(t *testing.T, ch <-chan Event) []Event {
	t.Helper()
	var evs []Event
	timeout := time.After(5 * time.Second)
	for {
		select {
		case e := <-ch:
			evs = append(evs, e)
			if e.Type == "done" || e.Type == "error" {
				return evs
			}
		case <-timeout:
			t.Fatalf("生成没有结束，已收到：%+v", evs)
		}
	}
}

func types(evs []Event) string {
	var out []string
	for _, e := range evs {
		s := e.Type
		switch {
		case e.Type == "tool_call":
			s += ":" + e.Call.Name
		case e.Type == "message" && e.Message.Role == llm.RoleUser && len(e.Message.Parts) > 0 && e.Message.Parts[0].Type == llm.PartToolResult:
			s += ":result"
		case e.Type == "message":
			s += ":" + string(e.Message.Role)
		case e.Type == "done":
			s += ":" + e.Stop
		}
		out = append(out, s)
	}
	return strings.Join(out, " ")
}

// searchThenUpdate：先 search_notes，再用 patch 修改周报，最后回答。
func searchThenUpdate(results []string) string {
	switch len(results) {
	case 0:
		return toolCallFrame("call_s", "search_notes", `{"query":"周报"}`)
	case 1:
		return toolCallFrame("call_u", "update_note", `{"path":"周报.md","base_rev":1,"mode":"patch","edits":[{"old":"状态：进行中","new":"状态：已完成"}]}`)
	default:
		return textFrame("结果：" + results[len(results)-1])
	}
}

func TestAgentPausesWriteForApproval(t *testing.T) {
	for _, approve := range []bool{true, false} {
		t.Run(map[bool]string{true: "批准", false: "拒绝"}[approve], func(t *testing.T) {
			f := newFixture(t, searchThenUpdate)
			ctx := context.Background()
			if _, err := f.notes.Create(ctx, "周报.md", "# 周报\n\n状态：进行中\n"); err != nil {
				t.Fatal(err)
			}
			chat, _ := f.svc.Store.CreateChat(ctx, "")

			evs := f.send(t, chat.ID, "把周报的状态改成已完成")
			// search_notes 自动执行；update_note 停在待批准
			want := "message:user chat tool_call:search_notes message:assistant chat message:result tool_call:update_note message:assistant chat approval done:awaiting_approval"
			if got := types(evs); got != want {
				t.Fatalf("事件：\n得到 %s\n期望 %s", got, want)
			}
			pending, _ := f.svc.Store.PendingList(ctx, chat.ID)
			if len(pending) != 1 || pending[0].Name != "update_note" {
				t.Fatalf("待批准：%+v", pending)
			}
			diff, _ := json.Marshal(pending[0].Preview.Diff)
			if !strings.Contains(string(diff), `{"op":"-","text":"状态：进行中"},{"op":"+","text":"状态：已完成"}`) {
				t.Errorf("预览 diff：%s", diff)
			}
			if b, _ := os.ReadFile(filepath.Join(f.vault, "周报.md")); !strings.Contains(string(b), "进行中") {
				t.Fatal("批准前文件不应被修改")
			}

			evs = f.resolve(t, chat.ID, "call_u", approve)
			if got := types(evs); got != "message:result text message:assistant chat done:stop" {
				t.Errorf("处理批准后的事件：%s", got)
			}
			b, _ := os.ReadFile(filepath.Join(f.vault, "周报.md"))
			lastTool := evs[0].Message.Parts[0].Result.Content
			if approve {
				if !strings.Contains(string(b), "状态：已完成") {
					t.Errorf("批准后文件应被修改：%s", b)
				}
				if !strings.Contains(lastTool, `"rev":2`) {
					t.Errorf("工具结果：%s", lastTool)
				}
				n, _ := f.notes.GetByPath(ctx, "周报.md")
				if n.Rev != 2 {
					t.Errorf("rev = %d", n.Rev)
				}
			} else {
				if !strings.Contains(string(b), "状态：进行中") {
					t.Errorf("拒绝后文件不应改变：%s", b)
				}
				if !strings.Contains(lastTool, "用户拒绝") {
					t.Errorf("拒绝时要告诉模型用户拒绝：%s", lastTool)
				}
			}
			// 模型收到了工具结果
			msgs := f.llm.last()["messages"].([]any)
			if last := msgs[len(msgs)-1].(map[string]any); last["role"] != "tool" || last["tool_call_id"] != "call_u" {
				t.Errorf("最后一次请求的末尾应是 update_note 的结果：%v", last)
			}
			pending, _ = f.svc.Store.PendingList(ctx, chat.ID)
			if len(pending) != 0 {
				t.Errorf("处理后不应再有待批准：%+v", pending)
			}
		})
	}
}

func TestAgentAutoApproveAndHistory(t *testing.T) {
	f := newFixture(t, searchThenUpdate)
	ctx := context.Background()
	f.notes.Create(ctx, "周报.md", "# 周报\n\n状态：进行中\n")
	if _, err := f.svc.Store.UpdateSettings(ctx, Settings{DefaultModel: f.model.ID, AutoApprove: true}); err != nil {
		t.Fatal(err)
	}
	chat, _ := f.svc.Store.CreateChat(ctx, "")
	evs := f.send(t, chat.ID, "改一下")
	if got := types(evs); strings.Contains(got, "approval") || !strings.HasSuffix(got, "done:stop") {
		t.Fatalf("自动批准时不应停下：%s", got)
	}
	b, _ := os.ReadFile(filepath.Join(f.vault, "周报.md"))
	if !strings.Contains(string(b), "已完成") {
		t.Error("自动批准后文件应被修改")
	}
	msgs, _ := f.svc.Store.Messages(ctx, chat.ID)
	// 用户 → 助手(search) → 结果 → 助手(update) → 结果 → 助手(回答)
	if len(msgs) != 6 || msgs[5].Model != "fake-1" || msgs[5].Usage == nil || msgs[5].Usage.Output != 5 {
		t.Errorf("消息记录：%d 条，最后一条 %+v", len(msgs), msgs[len(msgs)-1])
	}
	c, _ := f.svc.Store.Chat(ctx, chat.ID)
	if c.Title != "改一下" || c.OutputTokens != 5 || c.ContextTokens != 50 {
		t.Errorf("对话：%+v", c)
	}
	// 修改由助手发起：笔记的变更记录里设备是 agent
	changes, _, _ := f.notes.Changes(ctx, 0, 100)
	if last := changes[len(changes)-1]; last.DeviceID != Actor.DeviceID {
		t.Errorf("变更设备：%+v", last)
	}
}

func TestAgentToolCallLimit(t *testing.T) {
	n := 0
	f := newFixture(t, func(results []string) string {
		n++
		return toolCallFrame(fmt.Sprintf("call_%d", n), "list_notes", `{}`)
	})
	f.svc.MaxToolCalls = 3
	ctx := context.Background()
	chat, _ := f.svc.Store.CreateChat(ctx, "")
	evs := f.send(t, chat.ID, "一直列目录")
	last := evs[len(evs)-1]
	if last.Type != "error" || !strings.Contains(last.Text, "上限") {
		t.Fatalf("超过上限后应停止：%s / %+v", types(evs), last)
	}
	msgs, _ := f.svc.Store.Messages(ctx, chat.ID)
	calls, limited := 0, 0
	for _, m := range msgs {
		for _, p := range m.Parts {
			if p.Type == llm.PartToolCall {
				calls++
			}
			if p.Type == llm.PartToolResult && strings.Contains(p.Result.Content, "上限") {
				limited++
			}
		}
	}
	if calls != 5 || limited != 2 {
		t.Errorf("3 次执行后，再请求 2 次都返回上限说明：调用 %d 次，被拒 %d 次", calls, limited)
	}
}

func TestAgentStop(t *testing.T) {
	release := make(chan struct{})
	f := newFixture(t, nil)
	f.llm.script = nil
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
	ctx := context.Background()
	key := "k"
	p, _ := f.svc.Store.CreateProvider(ctx, ProviderInput{Name: "慢", Kind: llm.KindOpenAI, BaseURL: srv.URL, APIKey: &key})
	m, _ := f.svc.Store.CreateModel(ctx, p.ID, ModelInput{Model: "slow", ContextWindow: 8000, MaxOutput: 1000})
	chat, _ := f.svc.Store.CreateChat(ctx, m.ID)

	ch, unsub := f.svc.Subscribe(chat.ID)
	defer unsub()
	<-ch
	if _, err := f.svc.Send(ctx, chat.ID, SendInput{Text: "写点东西"}); err != nil {
		t.Fatal(err)
	}
	for e := range ch {
		if e.Type == "text" {
			break
		}
	}
	// 生成中再发消息会被拒绝
	if _, err := f.svc.Send(ctx, chat.ID, SendInput{Text: "再来"}); err != ErrBusy {
		t.Errorf("生成中再发送：%v", err)
	}
	// 断线重连时的快照里有已生成的部分
	ch2, unsub2 := f.svc.Subscribe(chat.ID)
	snap := <-ch2
	unsub2()
	if !snap.Running || snap.Draft == nil || snap.Draft.Text != "写到一半" {
		t.Errorf("快照：%+v", snap)
	}
	f.svc.Stop(ctx, chat.ID)
	evs := waitDone(t, ch)
	if got := types(evs); got != "message:assistant done:stopped" {
		t.Errorf("停止后的事件：%s", got)
	}
	msgs, _ := f.svc.Store.Messages(ctx, chat.ID)
	last := msgs[len(msgs)-1]
	if !last.Meta.Stopped || last.Parts[0].Text != "写到一半" {
		t.Errorf("已生成的部分应保存并标记停止：%+v", last)
	}
}
