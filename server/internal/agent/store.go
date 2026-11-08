package agent

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/rt-game-440/lode/server/internal/llm"
	"github.com/rt-game-440/lode/server/internal/merge"
	"github.com/rt-game-440/lode/server/internal/secret"
)

var (
	// ErrNotFound 表示供应商、模型或对话不存在。
	ErrNotFound = errors.New("not found")
	// ErrInvalid 表示输入不合法，错误信息是给用户看的中文说明。
	ErrInvalid = errors.New("invalid")
	// ErrBusy 表示对话正在生成回复。
	ErrBusy = errors.New("busy")
)

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

// Provider 是一个模型供应商。接口只返回 key 的末 4 位，不返回明文或密文。
type Provider struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Kind      llm.Kind `json:"kind"`
	BaseURL   string   `json:"base_url"`
	HasKey    bool     `json:"has_key"`
	KeyLast4  string   `json:"key_last4"`
	CreatedAt int64    `json:"created_at"`
	Models    []Model  `json:"models"`
}

// Model 是供应商下的一个模型配置。
type Model struct {
	ID            string     `json:"id"`
	ProviderID    string     `json:"provider_id"`
	Model         string     `json:"model"`
	Name          string     `json:"name"`
	Enabled       bool       `json:"enabled"`
	ContextWindow int        `json:"context_window"`
	MaxOutput     int        `json:"max_output"`
	Reasoning     bool       `json:"reasoning"`
	Effort        llm.Effort `json:"effort"`
	Modalities    []string   `json:"modalities"`
	Tools         bool       `json:"tools"`
	Temperature   *float64   `json:"temperature"`
}

// Label 返回显示名，没有时用模型 ID。
func (m Model) Label() string {
	if m.Name != "" {
		return m.Name
	}
	return m.Model
}

// Accepts 报告模型是否接受这种附件。
func (m Model) Accepts(mime string) bool {
	want := "pdf"
	switch {
	case strings.HasPrefix(mime, "image/"):
		want = "image"
	case strings.HasPrefix(mime, "audio/"):
		want = "audio"
	case mime != "application/pdf":
		return false
	}
	for _, x := range m.Modalities {
		if x == want {
			return true
		}
	}
	return false
}

// Settings 是助手的全局设置。
type Settings struct {
	DefaultModel string `json:"default_model"`
	AutoApprove  bool   `json:"auto_approve"`
}

// Chat 是一个对话。
type Chat struct {
	ID            string     `json:"id"`
	Title         string     `json:"title"`
	ModelID       string     `json:"model_id"`
	Effort        llm.Effort `json:"effort"`
	InputTokens   int        `json:"input_tokens"`
	OutputTokens  int        `json:"output_tokens"`
	ContextTokens int        `json:"context_tokens"`
	CreatedAt     int64      `json:"created_at"`
	UpdatedAt     int64      `json:"updated_at"`

	Summary     string `json:"-"` // 较早轮次的模型摘要
	SummaryUpto int    `json:"-"` // 摘要覆盖的历史消息条数
}

// Meta 是消息的附加信息，只用于界面显示。
type Meta struct {
	Mentions []string `json:"mentions,omitempty"` // 用户 @ 的笔记路径
	Stopped  bool     `json:"stopped,omitempty"`  // 生成被用户停止
	Error    string   `json:"error,omitempty"`    // 生成出错的说明
}

// Message 是保存下来的一条消息。
type Message struct {
	ID        int64      `json:"id"`
	Role      llm.Role   `json:"role"`
	Parts     []llm.Part `json:"parts"`
	Meta      Meta       `json:"meta"`
	Model     string     `json:"model,omitempty"`
	Usage     *llm.Usage `json:"usage,omitempty"`
	CreatedAt int64      `json:"created_at"`
}

// Preview 是写操作的预览。
type Preview struct {
	Action string           `json:"action"` // create | update | move | delete
	Path   string           `json:"path"`
	To     string           `json:"to,omitempty"` // move 的目标路径
	Diff   []merge.DiffLine `json:"diff,omitempty"`
	Error  string           `json:"error,omitempty"` // 预览失败的原因（例如笔记不存在），批准后多半也会失败
}

// Pending 是一个等待批准的写操作。
type Pending struct {
	CallID  string          `json:"call_id"`
	Name    string          `json:"name"`
	Args    json.RawMessage `json:"args"`
	Preview Preview         `json:"preview"`
}

// Store 是助手数据的持久化。
type Store struct {
	db  *sql.DB
	box *secret.Box
}

// NewStore 创建 Store。box 用于加解密 API key。
func NewStore(db *sql.DB, box *secret.Box) *Store { return &Store{db: db, box: box} }

// CanStoreKeys 报告是否有可用的主密钥，没有时不能保存 API key。
func (s *Store) CanStoreKeys() bool { return s.box.Enabled() }

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func now() int64 { return time.Now().UnixMilli() }

// ---- 供应商 ----

// ProviderInput 是新建或修改供应商的输入。APIKey 为 nil 表示不修改，空字符串表示清除。
type ProviderInput struct {
	Name    string   `json:"name"`
	Kind    llm.Kind `json:"kind"`
	BaseURL string   `json:"base_url"`
	APIKey  *string  `json:"api_key"`
}

func (in *ProviderInput) validate() error {
	in.Name = strings.TrimSpace(in.Name)
	in.BaseURL = strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
	if in.Name == "" || utf8.RuneCountInString(in.Name) > 64 {
		return invalid("名称不能为空且不超过 64 个字符")
	}
	if !in.Kind.Valid() {
		return invalid("类型只能是 openai、anthropic 或 gemini")
	}
	if in.BaseURL != "" {
		u, err := url.Parse(in.BaseURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return invalid("base URL 必须是 http:// 或 https:// 开头的地址")
		}
	}
	return nil
}

// sealKey 加密 key；没有主密钥时拒绝保存。
func (s *Store) sealKey(id string, key *string) (enc, last4 string, err error) {
	if key == nil || strings.TrimSpace(*key) == "" {
		return "", "", nil
	}
	k := strings.TrimSpace(*key)
	enc, err = s.box.Seal(k, id)
	if errors.Is(err, secret.ErrNoKey) {
		return "", "", invalid("服务器没有可用的主密钥，不能保存 API key。请检查数据目录是否可写后重启 Lode")
	}
	return enc, secret.Last4(k), err
}

// CreateProvider 新建供应商。
func (s *Store) CreateProvider(ctx context.Context, in ProviderInput) (Provider, error) {
	if err := in.validate(); err != nil {
		return Provider{}, err
	}
	id := newID()
	enc, last4, err := s.sealKey(id, in.APIKey)
	if err != nil {
		return Provider{}, err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO llm_providers(id, name, kind, base_url, key_enc, key_last4, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, in.Name, in.Kind, in.BaseURL, enc, last4, now())
	if err != nil {
		return Provider{}, err
	}
	return s.Provider(ctx, id)
}

// UpdateProvider 修改供应商。
func (s *Store) UpdateProvider(ctx context.Context, id string, in ProviderInput) (Provider, error) {
	if err := in.validate(); err != nil {
		return Provider{}, err
	}
	if _, err := s.Provider(ctx, id); err != nil {
		return Provider{}, err
	}
	if in.APIKey != nil {
		enc, last4, err := s.sealKey(id, in.APIKey)
		if err != nil {
			return Provider{}, err
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE llm_providers SET key_enc = ?, key_last4 = ? WHERE id = ?`, enc, last4, id); err != nil {
			return Provider{}, err
		}
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE llm_providers SET name = ?, kind = ?, base_url = ? WHERE id = ?`, in.Name, in.Kind, in.BaseURL, id); err != nil {
		return Provider{}, err
	}
	return s.Provider(ctx, id)
}

// DeleteProvider 删除供应商及其模型。
func (s *Store) DeleteProvider(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM llm_providers WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Providers 返回全部供应商及其模型。
func (s *Store) Providers(ctx context.Context) ([]Provider, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, kind, base_url, key_enc != '', key_last4, created_at FROM llm_providers ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Provider{}
	for rows.Next() {
		var p Provider
		if err := rows.Scan(&p.ID, &p.Name, &p.Kind, &p.BaseURL, &p.HasKey, &p.KeyLast4, &p.CreatedAt); err != nil {
			return nil, err
		}
		p.Models = []Model{}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	models, err := s.models(ctx, "")
	if err != nil {
		return nil, err
	}
	for _, m := range models {
		for i := range out {
			if out[i].ID == m.ProviderID {
				out[i].Models = append(out[i].Models, m)
			}
		}
	}
	return out, nil
}

// Provider 返回一个供应商。
func (s *Store) Provider(ctx context.Context, id string) (Provider, error) {
	ps, err := s.Providers(ctx)
	if err != nil {
		return Provider{}, err
	}
	for _, p := range ps {
		if p.ID == id {
			return p, nil
		}
	}
	return Provider{}, ErrNotFound
}

// Config 返回调用供应商所需的连接信息（含解密后的 key），只在服务端内部使用。
func (s *Store) Config(ctx context.Context, providerID string) (llm.Config, error) {
	var kind, base, enc string
	err := s.db.QueryRowContext(ctx, `SELECT kind, base_url, key_enc FROM llm_providers WHERE id = ?`, providerID).Scan(&kind, &base, &enc)
	if errors.Is(err, sql.ErrNoRows) {
		return llm.Config{}, ErrNotFound
	}
	if err != nil {
		return llm.Config{}, err
	}
	cfg := llm.Config{Kind: llm.Kind(kind), BaseURL: base}
	if enc != "" {
		key, err := s.box.Open(enc, providerID)
		if err != nil {
			return llm.Config{}, invalid("%s", err.Error())
		}
		cfg.APIKey = key
	}
	return cfg, nil
}

// ---- 模型 ----

// ModelInput 是新建或修改模型的输入。
type ModelInput struct {
	Model         string     `json:"model"`
	Name          string     `json:"name"`
	Enabled       *bool      `json:"enabled"`
	ContextWindow int        `json:"context_window"`
	MaxOutput     int        `json:"max_output"`
	Reasoning     bool       `json:"reasoning"`
	Effort        llm.Effort `json:"effort"`
	Modalities    []string   `json:"modalities"`
	Tools         *bool      `json:"tools"`
	Temperature   *float64   `json:"temperature"`
}

func (in *ModelInput) validate() error {
	in.Model = strings.TrimSpace(in.Model)
	in.Name = strings.TrimSpace(in.Name)
	if in.Model == "" || len(in.Model) > 200 {
		return invalid("模型 ID 不能为空")
	}
	if utf8.RuneCountInString(in.Name) > 64 {
		return invalid("显示名不超过 64 个字符")
	}
	if in.ContextWindow < 1024 || in.ContextWindow > 100_000_000 {
		return invalid("上下文窗口至少 1024")
	}
	if in.MaxOutput < 1 || in.MaxOutput >= in.ContextWindow {
		return invalid("最大输出必须大于 0 且小于上下文窗口")
	}
	if in.Effort == "" {
		in.Effort = llm.EffortMedium
	}
	if !in.Effort.Valid() {
		return invalid("推理强度只能是 off、low、medium、high")
	}
	seen := map[string]bool{"text": true}
	mods := []string{"text"}
	for _, m := range in.Modalities {
		switch m {
		case "text":
		case "image", "pdf", "audio":
			if !seen[m] {
				seen[m] = true
				mods = append(mods, m)
			}
		default:
			return invalid("模态只能是 text、image、pdf、audio")
		}
	}
	in.Modalities = mods
	if in.Temperature != nil && (*in.Temperature < 0 || *in.Temperature > 2) {
		return invalid("temperature 必须在 0 到 2 之间")
	}
	return nil
}

func boolOr(b *bool, def bool) bool {
	if b == nil {
		return def
	}
	return *b
}

// CreateModel 在供应商下新建模型。
func (s *Store) CreateModel(ctx context.Context, providerID string, in ModelInput) (Model, error) {
	if err := in.validate(); err != nil {
		return Model{}, err
	}
	if _, err := s.Provider(ctx, providerID); err != nil {
		return Model{}, err
	}
	id := newID()
	mods, _ := json.Marshal(in.Modalities)
	_, err := s.db.ExecContext(ctx, `INSERT INTO llm_models(id, provider_id, model, name, enabled, context_window, max_output, reasoning, effort, modalities, tools, temperature, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, providerID, in.Model, in.Name, boolOr(in.Enabled, true), in.ContextWindow, in.MaxOutput, in.Reasoning, in.Effort, string(mods), boolOr(in.Tools, true), in.Temperature, now())
	if err != nil {
		return Model{}, err
	}
	// 第一个模型自动成为默认模型
	if st, err := s.Settings(ctx); err == nil && st.DefaultModel == "" {
		_ = s.setSetting(ctx, "default_model", id)
	}
	return s.Model(ctx, id)
}

// UpdateModel 修改模型。
func (s *Store) UpdateModel(ctx context.Context, id string, in ModelInput) (Model, error) {
	if err := in.validate(); err != nil {
		return Model{}, err
	}
	old, err := s.Model(ctx, id)
	if err != nil {
		return Model{}, err
	}
	mods, _ := json.Marshal(in.Modalities)
	_, err = s.db.ExecContext(ctx, `UPDATE llm_models SET model = ?, name = ?, enabled = ?, context_window = ?, max_output = ?, reasoning = ?, effort = ?, modalities = ?, tools = ?, temperature = ? WHERE id = ?`,
		in.Model, in.Name, boolOr(in.Enabled, old.Enabled), in.ContextWindow, in.MaxOutput, in.Reasoning, in.Effort, string(mods), boolOr(in.Tools, old.Tools), in.Temperature, id)
	if err != nil {
		return Model{}, err
	}
	return s.Model(ctx, id)
}

// DeleteModel 删除模型。
func (s *Store) DeleteModel(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM llm_models WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Model 返回一个模型。
func (s *Store) Model(ctx context.Context, id string) (Model, error) {
	ms, err := s.models(ctx, id)
	if err != nil {
		return Model{}, err
	}
	if len(ms) == 0 {
		return Model{}, ErrNotFound
	}
	return ms[0], nil
}

func (s *Store) models(ctx context.Context, id string) ([]Model, error) {
	q := `SELECT id, provider_id, model, name, enabled, context_window, max_output, reasoning, effort, modalities, tools, temperature FROM llm_models`
	var args []any
	if id != "" {
		q += ` WHERE id = ?`
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, q+` ORDER BY created_at`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Model
	for rows.Next() {
		var m Model
		var mods string
		var temp sql.NullFloat64
		if err := rows.Scan(&m.ID, &m.ProviderID, &m.Model, &m.Name, &m.Enabled, &m.ContextWindow, &m.MaxOutput, &m.Reasoning, &m.Effort, &mods, &m.Tools, &temp); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(mods), &m.Modalities)
		if temp.Valid {
			m.Temperature = &temp.Float64
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ---- 设置 ----

// Settings 返回助手设置。
func (s *Store) Settings(ctx context.Context) (Settings, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, value FROM agent_settings`)
	if err != nil {
		return Settings{}, err
	}
	defer rows.Close()
	var st Settings
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return Settings{}, err
		}
		switch k {
		case "default_model":
			st.DefaultModel = v
		case "auto_approve":
			st.AutoApprove = v == "1"
		}
	}
	return st, rows.Err()
}

// UpdateSettings 保存助手设置。
func (s *Store) UpdateSettings(ctx context.Context, st Settings) (Settings, error) {
	if st.DefaultModel != "" {
		if _, err := s.Model(ctx, st.DefaultModel); err != nil {
			return Settings{}, invalid("默认模型不存在")
		}
	}
	auto := "0"
	if st.AutoApprove {
		auto = "1"
	}
	if err := s.setSetting(ctx, "default_model", st.DefaultModel); err != nil {
		return Settings{}, err
	}
	if err := s.setSetting(ctx, "auto_approve", auto); err != nil {
		return Settings{}, err
	}
	return s.Settings(ctx)
}

func (s *Store) setSetting(ctx context.Context, k, v string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO agent_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, k, v)
	return err
}

// ---- 对话 ----

const chatCols = `id, title, model_id, effort, input_tokens, output_tokens, context_tokens, created_at, updated_at, summary, summary_upto`

func scanChat(sc interface{ Scan(...any) error }) (Chat, error) {
	var c Chat
	err := sc.Scan(&c.ID, &c.Title, &c.ModelID, &c.Effort, &c.InputTokens, &c.OutputTokens, &c.ContextTokens, &c.CreatedAt, &c.UpdatedAt, &c.Summary, &c.SummaryUpto)
	return c, err
}

// CreateChat 新建对话。
func (s *Store) CreateChat(ctx context.Context, modelID string) (Chat, error) {
	id, t := newID(), now()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO agent_chats(id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?)`, id, modelID, t, t); err != nil {
		return Chat{}, err
	}
	return s.Chat(ctx, id)
}

// Chats 按最近更新排序返回对话。
func (s *Store) Chats(ctx context.Context, limit int) ([]Chat, error) {
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
func (s *Store) Chat(ctx context.Context, id string) (Chat, error) {
	c, err := scanChat(s.db.QueryRowContext(ctx, `SELECT `+chatCols+` FROM agent_chats WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Chat{}, ErrNotFound
	}
	return c, err
}

// UpdateChat 修改对话的标题、模型或推理强度覆盖（nil 表示不改）。
func (s *Store) UpdateChat(ctx context.Context, id string, title *string, modelID *string, effort *llm.Effort) (Chat, error) {
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
		if _, err := s.Model(ctx, *modelID); err != nil {
			return Chat{}, invalid("模型不存在")
		}
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
func (s *Store) DeleteChat(ctx context.Context, id string) error {
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
func (s *Store) addUsage(ctx context.Context, chatID string, u llm.Usage) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agent_chats SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, context_tokens = ?, updated_at = ? WHERE id = ?`,
		u.Input, u.Output, u.Input, now(), chatID)
	return err
}

// SetSummary 保存对话的摘要缓存，upto 是摘要覆盖的历史消息条数。
func (s *Store) SetSummary(ctx context.Context, chatID, summary string, upto int) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agent_chats SET summary = ?, summary_upto = ? WHERE id = ?`, summary, upto, chatID)
	return err
}

func (s *Store) touchChat(ctx context.Context, chatID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agent_chats SET updated_at = ? WHERE id = ?`, now(), chatID)
	return err
}

// ---- 消息 ----

// AddMessage 保存一条消息并返回带 id 的结果。
func (s *Store) AddMessage(ctx context.Context, chatID string, m Message) (Message, error) {
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
func (s *Store) Messages(ctx context.Context, chatID string) ([]Message, error) {
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

func (s *Store) addPending(ctx context.Context, chatID string, p Pending) error {
	pv, _ := json.Marshal(p.Preview)
	_, err := s.db.ExecContext(ctx, `INSERT INTO agent_pending(chat_id, call_id, name, args, preview, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		chatID, p.CallID, p.Name, string(p.Args), string(pv), now())
	return err
}

// PendingList 返回对话里等待批准的写操作。
func (s *Store) PendingList(ctx context.Context, chatID string) ([]Pending, error) {
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

func (s *Store) removePending(ctx context.Context, chatID, callID string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM agent_pending WHERE chat_id = ? AND call_id = ?`, chatID, callID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
