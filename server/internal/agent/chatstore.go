package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/rt-game-440/lode/server/internal/llm"
)

// ChatStore 是一个工作空间的助手对话数据（对话、消息、待批准操作）。
// 三张表有外键关联，必须在同一个库里：默认工作空间在 app.db（升级前的旧对话自然属于它），
// 其他工作空间在各自的 index.db（和 app.db 同构，已经有这三张表）。
// 供应商、模型、设置和 API key 是全局的，在 Store（app.db）里。
type ChatStore struct {
	db *sql.DB
}

// NewChatStore 创建 ChatStore，db 是已迁移的 app.db 或工作空间的 index.db。
func NewChatStore(db *sql.DB) *ChatStore { return &ChatStore{db: db} }

// ---- 对话 ----

const chatCols = `id, title, model_id, effort, input_tokens, output_tokens, context_tokens, created_at, updated_at, summary, summary_upto`

func scanChat(sc interface{ Scan(...any) error }) (Chat, error) {
	var c Chat
	err := sc.Scan(&c.ID, &c.Title, &c.ModelID, &c.Effort, &c.InputTokens, &c.OutputTokens, &c.ContextTokens, &c.CreatedAt, &c.UpdatedAt, &c.Summary, &c.SummaryUpto)
	return c, err
}

// CreateChat 新建对话。
func (s *ChatStore) CreateChat(ctx context.Context, modelID string) (Chat, error) {
	id, t := newID(), now()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO agent_chats(id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?)`, id, modelID, t, t); err != nil {
		return Chat{}, err
	}
	return s.Chat(ctx, id)
}

// Chats 按最近更新排序返回对话。
func (s *ChatStore) Chats(ctx context.Context, limit int) ([]Chat, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+chatCols+` FROM agent_chats ORDER BY updated_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Chat{}
	for rows.Next() {
		c, err := scanChat(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Chat 返回一个对话。
func (s *ChatStore) Chat(ctx context.Context, id string) (Chat, error) {
	c, err := scanChat(s.db.QueryRowContext(ctx, `SELECT `+chatCols+` FROM agent_chats WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Chat{}, ErrNotFound
	}
	return c, err
}

// UpdateChat 修改对话的标题、模型或推理强度覆盖（nil 表示不改）。不检查模型是否存在（模型是全局的，在 Store 里），
// 需要检查时用 Service.UpdateChat。
func (s *ChatStore) UpdateChat(ctx context.Context, id string, title *string, modelID *string, effort *llm.Effort) (Chat, error) {
	c, err := s.Chat(ctx, id)
	if err != nil {
		return Chat{}, err
	}
	if title != nil {
		t := strings.TrimSpace(*title)
		if utf8.RuneCountInString(t) > 100 {
			return Chat{}, invalid("标题不超过 100 个字符")
		}
		c.Title = t
	}
	if modelID != nil {
		c.ModelID = *modelID
	}
	if effort != nil {
		if *effort != "" && !effort.Valid() {
			return Chat{}, invalid("推理强度只能是 off、low、medium、high")
		}
		c.Effort = *effort
	}
	_, err = s.db.ExecContext(ctx, `UPDATE agent_chats SET title = ?, model_id = ?, effort = ? WHERE id = ?`, c.Title, c.ModelID, c.Effort, id)
	if err != nil {
		return Chat{}, err
	}
	return s.Chat(ctx, id)
}

// DeleteChat 删除对话及其消息。
func (s *ChatStore) DeleteChat(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM agent_chats WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// addUsage 累计用量并记录最近一次请求的输入 token。
func (s *ChatStore) addUsage(ctx context.Context, chatID string, u llm.Usage) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agent_chats SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, context_tokens = ?, updated_at = ? WHERE id = ?`,
		u.Input, u.Output, u.Input, now(), chatID)
	return err
}

// SetSummary 保存对话的摘要缓存，upto 是摘要覆盖的历史消息条数。
func (s *ChatStore) SetSummary(ctx context.Context, chatID, summary string, upto int) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agent_chats SET summary = ?, summary_upto = ? WHERE id = ?`, summary, upto, chatID)
	return err
}

func (s *ChatStore) touchChat(ctx context.Context, chatID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agent_chats SET updated_at = ? WHERE id = ?`, now(), chatID)
	return err
}

// ---- 消息 ----

// AddMessage 保存一条消息并返回带 id 的结果。
func (s *ChatStore) AddMessage(ctx context.Context, chatID string, m Message) (Message, error) {
	if m.Parts == nil {
		m.Parts = []llm.Part{}
	}
	parts, err := json.Marshal(m.Parts)
	if err != nil {
		return Message{}, err
	}
	meta, _ := json.Marshal(m.Meta)
	m.CreatedAt = now()
	var in, out int
	if m.Usage != nil {
		in, out = m.Usage.Input, m.Usage.Output
	}
	res, err := s.db.ExecContext(ctx, `INSERT INTO agent_messages(chat_id, role, parts, meta, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		chatID, m.Role, string(parts), string(meta), m.Model, in, out, m.CreatedAt)
	if err != nil {
		return Message{}, err
	}
	m.ID, _ = res.LastInsertId()
	_ = s.touchChat(ctx, chatID)
	return m, nil
}

// Messages 按顺序返回对话的全部消息。
func (s *ChatStore) Messages(ctx context.Context, chatID string) ([]Message, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, role, parts, meta, model, input_tokens, output_tokens, created_at FROM agent_messages WHERE chat_id = ? ORDER BY id`, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		var parts, meta string
		var in, outTok int
		if err := rows.Scan(&m.ID, &m.Role, &parts, &meta, &m.Model, &in, &outTok, &m.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(parts), &m.Parts); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(meta), &m.Meta)
		if in+outTok > 0 {
			m.Usage = &llm.Usage{Input: in, Output: outTok}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ---- 待批准 ----

func (s *ChatStore) addPending(ctx context.Context, chatID string, p Pending) error {
	pv, _ := json.Marshal(p.Preview)
	_, err := s.db.ExecContext(ctx, `INSERT INTO agent_pending(chat_id, call_id, name, args, preview, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		chatID, p.CallID, p.Name, string(p.Args), string(pv), now())
	return err
}

// PendingList 返回对话里等待批准的写操作。
func (s *ChatStore) PendingList(ctx context.Context, chatID string) ([]Pending, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT call_id, name, args, preview FROM agent_pending WHERE chat_id = ? ORDER BY rowid`, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Pending{}
	for rows.Next() {
		var p Pending
		var args, pv string
		if err := rows.Scan(&p.CallID, &p.Name, &args, &pv); err != nil {
			return nil, err
		}
		p.Args = json.RawMessage(args)
		_ = json.Unmarshal([]byte(pv), &p.Preview)
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *ChatStore) removePending(ctx context.Context, chatID, callID string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM agent_pending WHERE chat_id = ? AND call_id = ?`, chatID, callID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
