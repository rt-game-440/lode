// Package llm 把 OpenAI 兼容、Anthropic、Gemini 三家的流式对话接口统一成同一组消息类型和事件流。
// 只用标准库直接发 HTTP 请求并解析 SSE，不引入各家 SDK。各家格式和推理强度映射见 docs/agent.md。
package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Kind 是供应商类型。
type Kind string

const (
	KindOpenAI    Kind = "openai"    // OpenAI 兼容（Chat Completions）
	KindAnthropic Kind = "anthropic" // Anthropic Messages
	KindGemini    Kind = "gemini"    // Google Gemini generateContent
)

// Valid 报告是否是支持的供应商类型。
func (k Kind) Valid() bool { return k == KindOpenAI || k == KindAnthropic || k == KindGemini }

// DefaultBaseURL 是各家官方接口地址。
func (k Kind) DefaultBaseURL() string {
	switch k {
	case KindOpenAI:
		return "https://api.openai.com/v1"
	case KindAnthropic:
		return "https://api.anthropic.com"
	case KindGemini:
		return "https://generativelanguage.googleapis.com"
	}
	return ""
}

// Effort 是推理强度。空字符串表示模型不支持推理，不发送任何推理参数。
type Effort string

const (
	EffortOff    Effort = "off"
	EffortLow    Effort = "low"
	EffortMedium Effort = "medium"
	EffortHigh   Effort = "high"
)

// Valid 报告是否是四档之一。
func (e Effort) Valid() bool {
	return e == EffortOff || e == EffortLow || e == EffortMedium || e == EffortHigh
}

// Config 是一个供应商的连接信息。
type Config struct {
	Kind    Kind
	BaseURL string // 为空时用 Kind.DefaultBaseURL()
	APIKey  string
	HTTP    *http.Client // 为空时用默认客户端（无总超时，靠 ctx 取消）
}

func (c Config) base() string {
	b := strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if b == "" {
		b = c.Kind.DefaultBaseURL()
	}
	return b
}

func (c Config) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return defaultClient
}

var defaultClient = &http.Client{Transport: &http.Transport{
	Proxy:                 http.ProxyFromEnvironment,
	ResponseHeaderTimeout: 2 * time.Minute,
	IdleConnTimeout:       90 * time.Second,
	MaxIdleConnsPerHost:   2,
}}

// Role 是消息角色。工具结果放在 user 消息里（与 Anthropic 一致），各适配器按需拆分。
type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// PartType 是消息片段类型。
type PartType string

const (
	PartText       PartType = "text"
	PartThinking   PartType = "thinking"
	PartToolCall   PartType = "tool_call"
	PartToolResult PartType = "tool_result"
	PartMedia      PartType = "media"
)

// Part 是消息的一个片段。
type Part struct {
	Type PartType `json:"type"`
	Text string   `json:"text,omitempty"` // text、thinking
	// Signature 是需要原样带回的签名：Anthropic thinking 块的 signature，Gemini part 的 thoughtSignature。
	Signature string `json:"signature,omitempty"`
	// Redacted 是 Anthropic redacted_thinking 块的 data。
	Redacted string `json:"redacted,omitempty"`
	// Provider 记录 thinking 和签名来自哪家；换供应商后这些内容不再回传。
	Provider Kind        `json:"provider,omitempty"`
	Call     *ToolCall   `json:"call,omitempty"`
	Result   *ToolResult `json:"result,omitempty"`
	Media    *Media      `json:"media,omitempty"`
}

// ToolCall 是模型发起的一次工具调用。
type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Args      json.RawMessage `json:"args"`
	Signature string          `json:"signature,omitempty"` // Gemini functionCall part 的 thoughtSignature
}

// ToolResult 是一次工具调用的结果。
type ToolResult struct {
	CallID  string `json:"call_id"`
	Name    string `json:"name"`
	Content string `json:"content"`
	IsError bool   `json:"is_error,omitempty"`
}

// Media 是附件：图片、PDF 或音频。
type Media struct {
	MIME string `json:"mime"`
	Name string `json:"name,omitempty"`
	Data []byte `json:"data"`
}

// Message 是一条对话消息。
type Message struct {
	Role  Role   `json:"role"`
	Parts []Part `json:"parts"`
}

// Text 返回消息里全部正文片段拼接的结果。
func (m Message) Text() string {
	var b strings.Builder
	for _, p := range m.Parts {
		if p.Type == PartText {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

// Calls 返回消息里的工具调用。
func (m Message) Calls() []ToolCall {
	var out []ToolCall
	for _, p := range m.Parts {
		if p.Type == PartToolCall && p.Call != nil {
			out = append(out, *p.Call)
		}
	}
	return out
}

// ToolDef 是提供给模型的工具定义。
type ToolDef struct {
	Name        string
	Description string
	Schema      json.RawMessage // 参数的 JSON Schema（type: object）
}

// Request 是一次对话请求。
type Request struct {
	Model       string
	System      string
	Messages    []Message
	Tools       []ToolDef
	MaxTokens   int      // 最大输出 token
	Temperature *float64 // 为空时不发送
	Effort      Effort   // 为空时不发送推理参数
}

// EventType 是事件类型。
type EventType string

const (
	EventText     EventType = "text"
	EventThinking EventType = "thinking"
	EventToolCall EventType = "tool_call"
	EventUsage    EventType = "usage"
	EventDone     EventType = "done"
	EventError    EventType = "error"
)

// StopReason 是结束原因。
type StopReason string

const (
	StopEnd       StopReason = "stop"
	StopToolCalls StopReason = "tool_calls"
	StopMaxTokens StopReason = "max_tokens"
	StopRefusal   StopReason = "refusal"
)

// Usage 是 token 用量。Reasoning 是 Output 中的思考部分。
type Usage struct {
	Input     int `json:"input"`
	Output    int `json:"output"`
	Reasoning int `json:"reasoning,omitempty"`
}

// Event 是流式事件。
type Event struct {
	Type  EventType
	Text  string     // text、thinking
	Call  *ToolCall  // tool_call
	Usage *Usage     // usage
	Stop  StopReason // done
	Err   *Error     // error
}

// Result 是一次请求的完整结果：拼好的 assistant 消息、用量和结束原因。
type Result struct {
	Message Message
	Usage   Usage
	Stop    StopReason
}

// ErrorKind 是错误类别。
type ErrorKind string

const (
	ErrAuth          ErrorKind = "auth"
	ErrRateLimit     ErrorKind = "rate_limit"
	ErrContextLength ErrorKind = "context_length"
	ErrModelNotFound ErrorKind = "model_not_found"
	ErrBadRequest    ErrorKind = "bad_request"
	ErrServer        ErrorKind = "server"
	ErrNetwork       ErrorKind = "network"
	ErrCanceled      ErrorKind = "canceled"
)

// Error 是供应商调用失败。Error() 是给用户看的中文说明。
type Error struct {
	Kind   ErrorKind
	Status int    // HTTP 状态码；流中途出错或网络错误时为 0
	Detail string // 供应商返回的原始说明（已去掉 API key）
}

var kindText = map[ErrorKind]string{
	ErrAuth:          "鉴权失败：API key 无效或没有权限",
	ErrRateLimit:     "请求太频繁或额度已用完，请稍后再试",
	ErrContextLength: "对话超出了模型的上下文窗口，请新建对话或减少附件",
	ErrModelNotFound: "模型不存在，请检查模型 ID",
	ErrBadRequest:    "请求参数不被接受",
	ErrServer:        "供应商服务出错或过载，请稍后再试",
	ErrNetwork:       "连不上供应商，请检查 base URL 和网络",
	ErrCanceled:      "已停止",
}

func (e *Error) Error() string {
	msg := kindText[e.Kind]
	switch {
	case e.Status != 0 && e.Detail != "":
		msg += fmt.Sprintf("（HTTP %d：%s）", e.Status, e.Detail)
	case e.Status != 0:
		msg += fmt.Sprintf("（HTTP %d）", e.Status)
	case e.Detail != "":
		msg += "（" + e.Detail + "）"
	}
	return msg
}

// AsError 把任意错误转成 *Error。
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return &Error{Kind: ErrNetwork, Detail: err.Error()}
}

// Stream 发起一次流式请求：每收到一段内容就调用 emit，结束后返回拼好的结果。
// 出错时先 emit 一个 error 事件，再返回 *Error 和已收到的部分结果；ctx 取消时错误类别为 canceled。
func Stream(ctx context.Context, cfg Config, req Request, emit func(Event)) (Result, error) {
	if emit == nil {
		emit = func(Event) {}
	}
	var (
		res Result
		err error
	)
	switch cfg.Kind {
	case KindOpenAI:
		res, err = streamOpenAI(ctx, cfg, req, emit)
	case KindAnthropic:
		res, err = streamAnthropic(ctx, cfg, req, emit)
	case KindGemini:
		res, err = streamGemini(ctx, cfg, req, emit)
	default:
		err = &Error{Kind: ErrBadRequest, Detail: "未知的供应商类型 " + string(cfg.Kind)}
	}
	if err != nil {
		e := classify(ctx, cfg, err)
		emit(Event{Type: EventError, Err: e})
		return res, e
	}
	emit(Event{Type: EventUsage, Usage: &res.Usage})
	emit(Event{Type: EventDone, Stop: res.Stop})
	return res, nil
}

// ModelInfo 是模型列表里的一项。
type ModelInfo struct {
	ID            string `json:"id"`
	Name          string `json:"name,omitempty"`
	ContextWindow int    `json:"context_window,omitempty"`
	MaxOutput     int    `json:"max_output,omitempty"`
}

// ListModels 调用模型列表接口，用于“测试连接”。
func ListModels(ctx context.Context, cfg Config) ([]ModelInfo, error) {
	var (
		out []ModelInfo
		err error
	)
	switch cfg.Kind {
	case KindOpenAI:
		out, err = listOpenAI(ctx, cfg)
	case KindAnthropic:
		out, err = listAnthropic(ctx, cfg)
	case KindGemini:
		out, err = listGemini(ctx, cfg)
	default:
		err = &Error{Kind: ErrBadRequest, Detail: "未知的供应商类型 " + string(cfg.Kind)}
	}
	if err != nil {
		return nil, classify(ctx, cfg, err)
	}
	return out, nil
}

// classify 统一错误类别：ctx 取消优先；去掉错误说明里的 API key。
func classify(ctx context.Context, cfg Config, err error) *Error {
	if ctx.Err() != nil {
		return &Error{Kind: ErrCanceled}
	}
	e := AsError(err)
	if cfg.APIKey != "" && strings.Contains(e.Detail, cfg.APIKey) {
		e = &Error{Kind: e.Kind, Status: e.Status, Detail: strings.ReplaceAll(e.Detail, cfg.APIKey, "***")}
	}
	return e
}

// genID 为没有 id 的工具调用生成一个。
func genID(prefix string, n int) string { return fmt.Sprintf("%s_%d_%d", prefix, time.Now().UnixMilli(), n) }
