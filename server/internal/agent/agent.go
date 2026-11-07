// Package agent 是笔记助手：调用模型、执行笔记工具、写操作等待用户批准，并把过程推送给前端。
// 对话、消息、用量和待批准的操作都存 SQLite；正在生成的内容只在内存里（断线重连时作为快照补发）。
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/rt-game-440/lode/server/internal/llm"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/tools"
)

// 默认值。
const (
	DefaultMaxToolCalls = 20
	maxAttachmentBytes  = 20 << 20
	maxMentionRunes     = 60_000
	rejectedResult      = "用户拒绝了这次操作，笔记没有修改。不要重试同样的操作；如有必要，询问用户想怎么做。"
)

// Actor 是助手写笔记时的设备身份，其他端据此显示“由助手修改”。
var Actor = notes.Actor{DeviceID: "agent", DeviceName: "助手"}

// Service 是助手服务。
type Service struct {
	Store        *Store
	Tools        *tools.Registry
	Notes        *notes.Service
	Log          *slog.Logger
	HTTP         *http.Client     // 调用供应商用；为空时用 llm 的默认客户端
	MaxToolCalls int              // 每轮最多工具调用次数，默认 20
	Now          func() time.Time // 测试可替换

	mu     sync.Mutex
	runs   map[string]*run
	subs   map[string]map[chan Event]struct{}
	closed bool
	wg     sync.WaitGroup
}

type run struct {
	cancel context.CancelFunc
	draft  Draft
}

// Draft 是正在生成、尚未保存的助手消息。
type Draft struct {
	Text     string         `json:"text"`
	Thinking string         `json:"thinking"`
	Calls    []llm.ToolCall `json:"calls"`
}

// Event 是推送给前端的事件。
type Event struct {
	Type    string        `json:"type"` // state text thinking tool_call message approval chat done error
	Text    string        `json:"text,omitempty"`
	Call    *llm.ToolCall `json:"call,omitempty"`
	Message *Message      `json:"message,omitempty"`
	Pending *Pending      `json:"pending,omitempty"`
	Chat    *Chat         `json:"chat,omitempty"`
	Running bool          `json:"running,omitempty"`
	Draft   *Draft        `json:"draft,omitempty"`
	Stop    string        `json:"stop,omitempty"` // done：stop tool_calls max_tokens refusal stopped awaiting_approval
	Kind    llm.ErrorKind `json:"kind,omitempty"` // error 的类别
}

func (s *Service) log() *slog.Logger {
	if s.Log == nil {
		return slog.Default()
	}
	return s.Log
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) maxCalls() int {
	if s.MaxToolCalls > 0 {
		return s.MaxToolCalls
	}
	return DefaultMaxToolCalls
}

// ---- 推送 ----

// Subscribe 订阅对话的事件。返回的第一个事件是当前状态快照（是否在生成、已生成的部分）。
func (s *Service) Subscribe(chatID string) (<-chan Event, func()) {
	ch := make(chan Event, 512)
	s.mu.Lock()
	if s.subs == nil {
		s.subs = map[string]map[chan Event]struct{}{}
	}
	if s.subs[chatID] == nil {
		s.subs[chatID] = map[chan Event]struct{}{}
	}
	s.subs[chatID][ch] = struct{}{}
	snap := Event{Type: "state"}
	if r := s.runs[chatID]; r != nil {
		d := r.draft
		d.Calls = append([]llm.ToolCall(nil), d.Calls...)
		snap.Running, snap.Draft = true, &d
	}
	ch <- snap
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if set := s.subs[chatID]; set != nil {
			if _, ok := set[ch]; ok {
				delete(set, ch)
				close(ch)
			}
			if len(set) == 0 {
				delete(s.subs, chatID)
			}
		}
	}
}

// publish 推送事件；订阅者缓冲区满时断开它（前端重连后重新拉取）。
func (s *Service) publish(chatID string, e Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.runs[chatID]; r != nil {
		switch e.Type {
		case "text":
			r.draft.Text += e.Text
		case "thinking":
			r.draft.Thinking += e.Text
		case "tool_call":
			r.draft.Calls = append(r.draft.Calls, *e.Call)
		case "message":
			r.draft = Draft{}
		}
	}
	for ch := range s.subs[chatID] {
		select {
		case ch <- e:
		default:
			delete(s.subs[chatID], ch)
			close(ch)
		}
	}
}

// Running 报告对话是否正在生成。
func (s *Service) Running(chatID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs[chatID] != nil
}

// start 在后台开始一次生成；对话已在生成时返回 ErrBusy。
func (s *Service) start(chatID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("服务正在关闭")
	}
	if s.runs == nil {
		s.runs = map[string]*run{}
	}
	if s.runs[chatID] != nil {
		return ErrBusy
	}
	ctx, cancel := context.WithCancel(notes.WithActor(context.Background(), Actor))
	s.runs[chatID] = &run{cancel: cancel}
	s.wg.Go(func() {
		defer func() {
			if v := recover(); v != nil {
				s.log().Error("助手运行崩溃", "chat", chatID, "panic", v)
				s.publish(chatID, Event{Type: "error", Text: "服务器内部错误", Kind: llm.ErrServer})
			}
			s.mu.Lock()
			delete(s.runs, chatID)
			s.mu.Unlock()
			cancel()
			s.publish(chatID, Event{Type: "state"})
		}()
		s.loop(ctx, chatID)
	})
	return nil
}

// Close 停止全部生成并等待结束。
func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	for _, r := range s.runs {
		r.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

// ---- 用户操作 ----

// Attachment 是用户上传的附件。
type Attachment struct {
	Name string `json:"name"`
	MIME string `json:"mime"`
	Data []byte `json:"data"` // JSON 里是 base64
}

// SendInput 是用户发送的一条消息。
type SendInput struct {
	Text        string       `json:"text"`
	Mentions    []string     `json:"mentions"`    // @ 的笔记路径
	Attachments []Attachment `json:"attachments"` // 图片、PDF、音频
}

// Send 保存用户消息并开始生成。有待批准的操作时先按“拒绝”处理。
func (s *Service) Send(ctx context.Context, chatID string, in SendInput) (Message, error) {
	chat, err := s.Store.Chat(ctx, chatID)
	if err != nil {
		return Message{}, err
	}
	if s.Running(chatID) {
		return Message{}, ErrBusy
	}
	in.Text = strings.TrimSpace(in.Text)
	if in.Text == "" && len(in.Attachments) == 0 {
		return Message{}, invalid("消息不能为空")
	}
	model, _, err := s.resolveModel(ctx, chat)
	if err != nil {
		return Message{}, err
	}
	parts := []llm.Part{}
	if in.Text != "" {
		parts = append(parts, llm.Part{Type: llm.PartText, Text: in.Text})
	}
	mentions := []string{}
	seen := map[string]bool{}
	for _, p := range in.Mentions {
		p = strings.TrimLeft(strings.TrimSpace(p), "/")
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		n, err := s.Notes.ReadByPath(ctx, p)
		if err != nil {
			return Message{}, invalid("找不到 @ 的笔记 %s", p)
		}
		content := n.Content
		if utf8.RuneCountInString(content) > maxMentionRunes {
			content = string([]rune(content)[:maxMentionRunes]) + "\n…（笔记过长，只附上开头部分；需要更多内容请用 read_note 分段读取）"
		}
		parts = append(parts, llm.Part{Type: llm.PartText, Text: fmt.Sprintf("<note path=%q rev=\"%d\">\n%s\n</note>", n.Path, n.Rev, content)})
		mentions = append(mentions, n.Path)
	}
	total := 0
	for _, a := range in.Attachments {
		total += len(a.Data)
		if !model.Accepts(a.MIME) {
			return Message{}, invalid("当前模型不支持 %s 类型的附件", a.MIME)
		}
		if len(a.Data) == 0 {
			return Message{}, invalid("附件 %s 是空文件", a.Name)
		}
		parts = append(parts, llm.Part{Type: llm.PartMedia, Media: &llm.Media{MIME: a.MIME, Name: a.Name, Data: a.Data}})
	}
	if total > maxAttachmentBytes {
		return Message{}, invalid("附件合计不能超过 20MB")
	}

	if err := s.rejectAll(ctx, chatID, "用户没有批准这次操作，而是发了新消息。笔记没有修改。"); err != nil {
		return Message{}, err
	}
	msg, err := s.Store.AddMessage(ctx, chatID, Message{Role: llm.RoleUser, Parts: parts, Meta: Meta{Mentions: mentions}})
	if err != nil {
		return Message{}, err
	}
	s.publish(chatID, Event{Type: "message", Message: stripData(msg)})
	if chat.Title == "" {
		title := in.Text
		if title == "" && len(in.Attachments) > 0 {
			title = in.Attachments[0].Name
		}
		title = strings.Join(strings.Fields(title), " ")
		if r := []rune(title); len(r) > 40 {
			title = string(r[:40]) + "…"
		}
		if c, err := s.Store.UpdateChat(ctx, chatID, &title, nil, nil); err == nil {
			s.publish(chatID, Event{Type: "chat", Chat: &c})
		}
	}
	return stripDataValue(msg), s.start(chatID)
}

// Stop 停止生成；没有在生成但有待批准的操作时，把它们按“拒绝”处理。
func (s *Service) Stop(ctx context.Context, chatID string) error {
	s.mu.Lock()
	r := s.runs[chatID]
	s.mu.Unlock()
	if r != nil {
		r.cancel()
		return nil
	}
	return s.rejectAll(ctx, chatID, "用户停止了这次操作，笔记没有修改。")
}

// Resolve 批准或拒绝一个待批准的写操作。全部处理完后继续生成。
func (s *Service) Resolve(ctx context.Context, chatID, callID string, approve bool) error {
	if s.Running(chatID) {
		return ErrBusy
	}
	list, err := s.Store.PendingList(ctx, chatID)
	if err != nil {
		return err
	}
	var p *Pending
	for i := range list {
		if list[i].CallID == callID {
			p = &list[i]
		}
	}
	if p == nil {
		return ErrNotFound
	}
	ok, err := s.Store.removePending(ctx, chatID, callID)
	if err != nil || !ok {
		return ErrNotFound
	}
	call := llm.ToolCall{ID: p.CallID, Name: p.Name, Args: p.Args}
	var res llm.ToolResult
	if approve {
		res = s.execute(notes.WithActor(context.WithoutCancel(ctx), Actor), call)
	} else {
		res = llm.ToolResult{CallID: call.ID, Name: call.Name, Content: rejectedResult}
	}
	if err := s.saveResult(ctx, chatID, res); err != nil {
		return err
	}
	if len(list) == 1 {
		return s.start(chatID)
	}
	return nil
}

func (s *Service) rejectAll(ctx context.Context, chatID, reason string) error {
	list, err := s.Store.PendingList(ctx, chatID)
	if err != nil {
		return err
	}
	for _, p := range list {
		if ok, err := s.Store.removePending(ctx, chatID, p.CallID); err != nil || !ok {
			continue
		}
		if err := s.saveResult(ctx, chatID, llm.ToolResult{CallID: p.CallID, Name: p.Name, Content: reason}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) saveResult(ctx context.Context, chatID string, res llm.ToolResult) error {
	msg, err := s.Store.AddMessage(context.WithoutCancel(ctx), chatID, Message{Role: llm.RoleUser, Parts: []llm.Part{{Type: llm.PartToolResult, Result: &res}}})
	if err != nil {
		return err
	}
	s.publish(chatID, Event{Type: "message", Message: &msg})
	return nil
}

// resolveModel 返回对话使用的模型和连接信息：对话没选模型时用默认模型。
func (s *Service) resolveModel(ctx context.Context, chat Chat) (Model, llm.Config, error) {
	id := chat.ModelID
	if id == "" {
		st, err := s.Store.Settings(ctx)
		if err != nil {
			return Model{}, llm.Config{}, err
		}
		id = st.DefaultModel
	}
	if id == "" {
		return Model{}, llm.Config{}, invalid("还没有配置模型，请先在设置的“助手”里添加供应商和模型")
	}
	m, err := s.Store.Model(ctx, id)
	if err != nil {
		return Model{}, llm.Config{}, invalid("对话使用的模型已被删除，请换一个模型")
	}
	if !m.Enabled {
		return Model{}, llm.Config{}, invalid("模型 %s 已停用，请换一个模型", m.Label())
	}
	cfg, err := s.Store.Config(ctx, m.ProviderID)
	if err != nil {
		return Model{}, llm.Config{}, err
	}
	cfg.HTTP = s.HTTP
	return m, cfg, nil
}

// ---- 生成循环 ----

func (s *Service) loop(ctx context.Context, chatID string) {
	bg := context.WithoutCancel(ctx)
	fail := func(kind llm.ErrorKind, msg string) {
		s.publish(chatID, Event{Type: "error", Text: msg, Kind: kind})
	}
	overLimit := 0
	for {
		chat, err := s.Store.Chat(bg, chatID)
		if err != nil {
			return
		}
		model, cfg, err := s.resolveModel(bg, chat)
		if err != nil {
			fail(llm.ErrBadRequest, strings.TrimPrefix(err.Error(), ErrInvalid.Error()+": "))
			return
		}
		st, _ := s.Store.Settings(bg)
		history, err := s.Store.Messages(bg, chatID)
		if err != nil {
			fail(llm.ErrServer, "读取对话失败")
			return
		}
		req, used := s.request(chat, model, history)
		s.log().Debug("助手请求", "chat", chatID, "model", model.Model, "messages", len(req.Messages), "estimated_tokens", used)

		res, err := llm.Stream(ctx, cfg, req, func(e llm.Event) {
			switch e.Type {
			case llm.EventText, llm.EventThinking:
				s.publish(chatID, Event{Type: string(e.Type), Text: e.Text})
			case llm.EventToolCall:
				s.publish(chatID, Event{Type: "tool_call", Call: e.Call})
			}
		})
		if err != nil {
			e := llm.AsError(err)
			meta := Meta{Stopped: e.Kind == llm.ErrCanceled}
			if !meta.Stopped {
				meta.Error = e.Error()
				s.log().Warn("模型调用失败", "chat", chatID, "model", model.Model, "kind", e.Kind, "status", e.Status)
			}
			// 保存已生成的正文和思考；不完整的工具调用丢弃
			partial := Message{Role: llm.RoleAssistant, Model: model.Model, Meta: meta}
			for _, p := range res.Message.Parts {
				if p.Type == llm.PartText || p.Type == llm.PartThinking {
					partial.Parts = append(partial.Parts, p)
				}
			}
			if len(partial.Parts) == 0 {
				d := s.draftOf(chatID)
				if d.Thinking != "" {
					partial.Parts = append(partial.Parts, llm.Part{Type: llm.PartThinking, Text: d.Thinking})
				}
				if d.Text != "" {
					partial.Parts = append(partial.Parts, llm.Part{Type: llm.PartText, Text: d.Text})
				}
			}
			if msg, err := s.Store.AddMessage(bg, chatID, partial); err == nil {
				s.publish(chatID, Event{Type: "message", Message: &msg})
			}
			if meta.Stopped {
				s.publish(chatID, Event{Type: "done", Stop: "stopped"})
			} else {
				fail(e.Kind, e.Error())
			}
			return
		}

		u := res.Usage
		msg, err := s.Store.AddMessage(bg, chatID, Message{Role: llm.RoleAssistant, Parts: res.Message.Parts, Model: model.Model, Usage: &u})
		if err != nil {
			fail(llm.ErrServer, "保存回复失败")
			return
		}
		_ = s.Store.addUsage(bg, chatID, u)
		s.publish(chatID, Event{Type: "message", Message: &msg})
		if c, err := s.Store.Chat(bg, chatID); err == nil {
			s.publish(chatID, Event{Type: "chat", Chat: &c})
		}

		calls := res.Message.Calls()
		if len(calls) == 0 {
			s.publish(chatID, Event{Type: "done", Stop: string(res.Stop)})
			return
		}
		count := s.callsThisRound(history) + len(calls)
		waiting := false
		hit := false
		for i, c := range calls {
			if ctx.Err() != nil {
				// 停止时，尚未执行的调用按“已停止”回复，保持历史完整
				_ = s.saveResult(bg, chatID, llm.ToolResult{CallID: c.ID, Name: c.Name, Content: "用户停止了这次操作。", IsError: true})
				continue
			}
			if count-len(calls)+i+1 > s.maxCalls() {
				hit = true
				_ = s.saveResult(bg, chatID, llm.ToolResult{CallID: c.ID, Name: c.Name, IsError: true,
					Content: fmt.Sprintf("本轮工具调用已达到上限（%d 次），这次调用没有执行。请根据已有信息直接回答用户。", s.maxCalls())})
				continue
			}
			t := s.tool(c.Name)
			if t != nil && !t.ReadOnly && !st.AutoApprove {
				p := Pending{CallID: c.ID, Name: c.Name, Args: c.Args, Preview: s.preview(bg, c)}
				if err := s.Store.addPending(bg, chatID, p); err != nil {
					fail(llm.ErrServer, "保存待批准操作失败")
					return
				}
				s.publish(chatID, Event{Type: "approval", Pending: &p})
				waiting = true
				continue
			}
			if err := s.saveResult(bg, chatID, s.execute(ctx, c)); err != nil {
				fail(llm.ErrServer, "保存工具结果失败")
				return
			}
		}
		if ctx.Err() != nil {
			s.publish(chatID, Event{Type: "done", Stop: "stopped"})
			return
		}
		if waiting {
			s.publish(chatID, Event{Type: "done", Stop: "awaiting_approval"})
			return
		}
		if hit {
			overLimit++
			if overLimit >= 2 {
				fail(llm.ErrBadRequest, fmt.Sprintf("本轮工具调用次数超过上限（%d 次），已停止。", s.maxCalls()))
				return
			}
		}
	}
}

func (s *Service) draftOf(chatID string) Draft {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.runs[chatID]; r != nil {
		return r.draft
	}
	return Draft{}
}

// callsThisRound 统计最近一条用户提问之后已经发起的工具调用次数。
func (s *Service) callsThisRound(history []Message) int {
	n := 0
	for i := len(history) - 1; i >= 0; i-- {
		m := history[i]
		if isUserTurn(llm.Message{Role: m.Role, Parts: m.Parts}) {
			break
		}
		for _, p := range m.Parts {
			if p.Type == llm.PartToolCall {
				n++
			}
		}
	}
	return n
}

func (s *Service) tool(name string) *tools.Tool {
	for _, t := range s.Tools.Tools(true) {
		if t.Name == name {
			return t
		}
	}
	return nil
}

// execute 执行一次工具调用，失败时返回 IsError 的结果给模型。
func (s *Service) execute(ctx context.Context, c llm.ToolCall) llm.ToolResult {
	res, err := s.Tools.Call(ctx, c.Name, c.Args, true)
	if err != nil {
		if errors.Is(err, tools.ErrInternal) {
			s.log().Error("助手工具调用失败", "tool", c.Name, "target", res.Target, "err", errors.Unwrap(err))
		}
		return llm.ToolResult{CallID: c.ID, Name: c.Name, Content: err.Error(), IsError: true}
	}
	return llm.ToolResult{CallID: c.ID, Name: c.Name, Content: res.Text()}
}

// request 组装发给模型的请求：系统提示、工具定义，以及按上下文预算裁剪过的历史。
func (s *Service) request(chat Chat, m Model, history []Message) (llm.Request, int) {
	system := systemPrompt(s.now())
	var defs []llm.ToolDef
	toolTokens := 0
	if m.Tools {
		for _, t := range s.Tools.Tools(true) {
			schema, _ := json.Marshal(t.InputSchema)
			defs = append(defs, llm.ToolDef{Name: t.Name, Description: t.Description, Schema: schema})
			toolTokens += EstimateTokens(t.Name+t.Description) + EstimateTokens(string(schema))
		}
	}
	msgs := make([]llm.Message, 0, len(history))
	for _, h := range history {
		if len(h.Parts) == 0 {
			continue
		}
		msgs = append(msgs, llm.Message{Role: h.Role, Parts: h.Parts})
	}
	msgs, used := Fit(system, toolTokens, msgs, Budget{Window: m.ContextWindow, MaxOutput: m.MaxOutput}.Limit())
	effort := llm.Effort("")
	if m.Reasoning {
		effort = m.Effort
		if chat.Effort != "" {
			effort = chat.Effort
		}
	}
	return llm.Request{Model: m.Model, System: system, Messages: msgs, Tools: defs, MaxTokens: m.MaxOutput, Temperature: m.Temperature, Effort: effort}, used
}

var weekdays = []string{"日", "一", "二", "三", "四", "五", "六"}

func systemPrompt(t time.Time) string {
	return fmt.Sprintf(`你是 Lode 笔记应用里的助手，帮助用户查找、整理和编写 Markdown 笔记。今天是 %s（星期%s）。

- 用户消息里 <note path="…"> 标签中是用户 @ 的笔记，是发送时的快照；需要最新内容或修改前，用 read_note 读取。
- 你可以用工具搜索和读取笔记。新建、修改、移动、删除笔记需要用户在界面上批准；用户拒绝时你会收到说明，此时不要重试同样的操作，先询问用户。
- 修改笔记前先 read_note 拿到 rev；只改局部时用 update_note 的 patch 模式。
- 提到笔记时用 [[笔记名]] 的写法，方便用户点击跳转。
- 用用户使用的语言回答，简洁直接。`, t.Format("2006-01-02"), weekdays[t.Weekday()])
}

// stripData 去掉附件的二进制内容，推送和接口里只保留名称、类型和大小。
func stripData(m Message) *Message {
	v := stripDataValue(m)
	return &v
}

func stripDataValue(m Message) Message {
	parts := make([]llm.Part, len(m.Parts))
	for i, p := range m.Parts {
		if p.Type == llm.PartMedia && p.Media != nil {
			md := *p.Media
			md.Data = nil
			p.Media = &md
		}
		parts[i] = p
	}
	m.Parts = parts
	return m
}
