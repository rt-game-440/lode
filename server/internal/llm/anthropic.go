package llm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

// Anthropic Messages 流式接口。格式见 docs/agent.md。

const anthropicVersion = "2026-10-21"

func anthropicHeader(cfg Config) http.Header {
	h := http.Header{}
	if cfg.APIKey != "" {
		h.Set("x-api-key", cfg.APIKey)
	}
	h.Set("anthropic-version", anthropicVersion)
	return h
}

// legacyClaude 匹配只支持 thinking.type=enabled 的旧模型：Claude 3.x 和 4.0–4.5。
var legacyClaude = regexp.MustCompile(`^claude-(3|(opus|sonnet|haiku)-4(-[0-5])?(-\d{8}|-latest)?$)`)

// anthropicThinking 返回 thinking 和 output_config 参数；为 nil 时不发送。
func anthropicThinking(model string, e Effort, maxTokens int) (thinking, outputConfig any) {
	if e == "" || e == EffortOff {
		return nil, nil
	}
	id := model[strings.LastIndex(model, "/")+1:]
	if legacyClaude.MatchString(id) {
		budget := map[Effort]int{EffortLow: 2048, EffortMedium: 8192, EffortHigh: 24576}[e]
		budget = min(budget, maxTokens-1024)
		if budget < 1024 {
			return nil, nil
		}
		return map[string]any{"type": "enabled", "budget_tokens": budget}, nil
	}
	return map[string]any{"type": "adaptive"}, map[string]any{"effort": string(e)}
}

func anthropicBody(req Request) map[string]any {
	body := map[string]any{
		"model":      req.Model,
		"max_tokens": req.MaxTokens,
		"stream":     true,
		"messages":   anthropicMessages(req.Messages),
	}
	if req.System != "" {
		body["system"] = req.System
	}
	if th, oc := anthropicThinking(req.Model, req.Effort, req.MaxTokens); th != nil {
		body["thinking"] = th
		if oc != nil {
			body["output_config"] = oc
		}
	}
	if len(req.Tools) > 0 {
		tools := make([]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			tools = append(tools, map[string]any{"name": t.Name, "description": t.Description, "input_schema": t.Schema})
		}
		body["tools"] = tools
	}
	return body
}

// anthropicMessages 转换消息：连续同角色的消息合并，user 消息里 tool_result 排在最前。
func anthropicMessages(msgs []Message) []any {
	type turn struct {
		role    Role
		results []any
		content []any
	}
	var turns []*turn
	for _, m := range msgs {
		var t *turn
		if n := len(turns); n > 0 && turns[n-1].role == m.Role {
			t = turns[n-1]
		} else {
			t = &turn{role: m.Role}
			turns = append(turns, t)
		}
		for _, p := range m.Parts {
			switch p.Type {
			case PartThinking:
				if p.Provider != KindAnthropic {
					continue
				}
				if p.Redacted != "" {
					t.content = append(t.content, map[string]any{"type": "redacted_thinking", "data": p.Redacted})
				} else if p.Signature != "" {
					t.content = append(t.content, map[string]any{"type": "thinking", "thinking": p.Text, "signature": p.Signature})
				}
			case PartText:
				if p.Text != "" {
					t.content = append(t.content, map[string]any{"type": "text", "text": p.Text})
				}
			case PartToolCall:
				t.content = append(t.content, map[string]any{"type": "tool_use", "id": p.Call.ID, "name": p.Call.Name, "input": argsOrEmpty(p.Call.Args)})
			case PartToolResult:
				r := map[string]any{"type": "tool_result", "tool_use_id": p.Result.CallID, "content": p.Result.Content}
				if p.Result.IsError {
					r["is_error"] = true
				}
				t.results = append(t.results, r)
			case PartMedia:
				src := map[string]any{"type": "base64", "media_type": p.Media.MIME, "data": base64.StdEncoding.EncodeToString(p.Media.Data)}
				typ := "image"
				if p.Media.MIME == "application/pdf" {
					typ = "document"
				}
				t.content = append(t.content, map[string]any{"type": typ, "source": src})
			}
		}
	}
	out := make([]any, 0, len(turns))
	for _, t := range turns {
		content := append(t.results, t.content...)
		if len(content) == 0 {
			content = []any{map[string]any{"type": "text", "text": "…"}}
		}
		out = append(out, map[string]any{"role": string(t.role), "content": content})
	}
	return out
}

type anthropicEvent struct {
	Type    string `json:"type"`
	Index   int    `json:"index"`
	Message *struct {
		Usage anthropicUsage `json:"usage"`
	} `json:"message"`
	ContentBlock *struct {
		Type      string `json:"type"`
		Text      string `json:"text"`
		Thinking  string `json:"thinking"`
		Signature string `json:"signature"`
		Data      string `json:"data"`
		ID        string `json:"id"`
		Name      string `json:"name"`
	} `json:"content_block"`
	Delta *struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		Thinking    string `json:"thinking"`
		Signature   string `json:"signature"`
		PartialJSON string `json:"partial_json"`
		StopReason  string `json:"stop_reason"`
	} `json:"delta"`
	Usage *anthropicUsage `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

type anthropicUsage struct {
	InputTokens         int `json:"input_tokens"`
	CacheCreationTokens int `json:"cache_creation_input_tokens"`
	CacheReadTokens     int `json:"cache_read_input_tokens"`
	OutputTokens        int `json:"output_tokens"`
}

// anthropicStreamError 把流中的 error 事件按错误类型归类。
func anthropicStreamError(typ, msg string) *Error {
	kind := map[string]ErrorKind{
		"authentication_error": ErrAuth, "permission_error": ErrAuth, "rate_limit_error": ErrRateLimit,
		"not_found_error": ErrModelNotFound, "api_error": ErrServer, "overloaded_error": ErrServer,
	}[typ]
	if kind == "" {
		kind = ErrBadRequest
		if isContextError(strings.ToLower(msg)) {
			kind = ErrContextLength
		}
	}
	return &Error{Kind: kind, Detail: truncate(msg, 300)}
}

func streamAnthropic(ctx context.Context, cfg Config, req Request, emit func(Event)) (Result, error) {
	resp, err := post(ctx, cfg, cfg.base()+"/v1/messages", anthropicHeader(cfg), anthropicBody(req))
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()

	type block struct {
		part Part
		buf  strings.Builder
	}
	var (
		res    Result
		blocks = map[int]*block{}
		order  []int
		stop   string
	)
	err = readSSE(resp.Body, func(_, data string) error {
		var ev anthropicEvent
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			return nil
		}
		switch ev.Type {
		case "message_start":
			if ev.Message != nil {
				u := ev.Message.Usage
				res.Usage.Input = u.InputTokens + u.CacheCreationTokens + u.CacheReadTokens
				res.Usage.Output = u.OutputTokens
			}
		case "content_block_start":
			cb := ev.ContentBlock
			if cb == nil {
				return nil
			}
			b := &block{}
			switch cb.Type {
			case "thinking":
				b.part = Part{Type: PartThinking, Signature: cb.Signature, Provider: KindAnthropic}
				b.buf.WriteString(cb.Thinking)
			case "redacted_thinking":
				b.part = Part{Type: PartThinking, Redacted: cb.Data, Provider: KindAnthropic}
			case "text":
				b.part = Part{Type: PartText}
				b.buf.WriteString(cb.Text)
			case "tool_use":
				b.part = Part{Type: PartToolCall, Call: &ToolCall{ID: cb.ID, Name: cb.Name}}
			default:
				return nil
			}
			blocks[ev.Index] = b
			order = append(order, ev.Index)
		case "content_block_delta":
			b := blocks[ev.Index]
			if b == nil || ev.Delta == nil {
				return nil
			}
			switch d := ev.Delta; d.Type {
			case "text_delta":
				b.buf.WriteString(d.Text)
				emit(Event{Type: EventText, Text: d.Text})
			case "thinking_delta":
				b.buf.WriteString(d.Thinking)
				emit(Event{Type: EventThinking, Text: d.Thinking})
			case "signature_delta":
				b.part.Signature += d.Signature
			case "input_json_delta":
				b.buf.WriteString(d.PartialJSON)
			}
		case "content_block_stop":
			b := blocks[ev.Index]
			if b != nil && b.part.Type == PartToolCall {
				b.part.Call.Args = argsOrEmpty(json.RawMessage(b.buf.String()))
				emit(Event{Type: EventToolCall, Call: b.part.Call})
			}
		case "message_delta":
			if ev.Delta != nil && ev.Delta.StopReason != "" {
				stop = ev.Delta.StopReason
			}
			if ev.Usage != nil {
				res.Usage.Output = ev.Usage.OutputTokens
			}
		case "message_stop":
			return errStop
		case "error":
			if ev.Error != nil {
				return anthropicStreamError(ev.Error.Type, ev.Error.Message)
			}
		}
		return nil
	})
	if err != nil && err != errStop {
		return res, err
	}
	res.Message.Role = RoleAssistant
	for _, i := range order {
		b := blocks[i]
		p := b.part
		switch p.Type {
		case PartText, PartThinking:
			if p.Redacted == "" {
				p.Text = b.buf.String()
			}
			if p.Type == PartText && p.Text == "" {
				continue
			}
		case PartToolCall:
			if p.Call.Args == nil {
				p.Call.Args = argsOrEmpty(json.RawMessage(b.buf.String()))
			}
		}
		res.Message.Parts = append(res.Message.Parts, p)
	}
	switch stop {
	case "tool_use":
		res.Stop = StopToolCalls
	case "max_tokens":
		res.Stop = StopMaxTokens
	case "refusal":
		res.Stop = StopRefusal
	case "model_context_window_exceeded":
		return res, &Error{Kind: ErrContextLength, Detail: "model_context_window_exceeded"}
	default:
		res.Stop = StopEnd
		if len(res.Message.Calls()) > 0 {
			res.Stop = StopToolCalls
		}
	}
	return res, nil
}

func listAnthropic(ctx context.Context, cfg Config) ([]ModelInfo, error) {
	var out []ModelInfo
	after := ""
	for page := 0; page < 10; page++ {
		url := cfg.base() + "/v1/models?limit=100"
		if after != "" {
			url += "&after_id=" + after
		}
		var v struct {
			Data []struct {
				ID             string `json:"id"`
				DisplayName    string `json:"display_name"`
				MaxInputTokens int    `json:"max_input_tokens"`
				MaxTokens      int    `json:"max_tokens"`
			} `json:"data"`
			HasMore bool   `json:"has_more"`
			LastID  string `json:"last_id"`
		}
		if err := get(ctx, cfg, url, anthropicHeader(cfg), &v); err != nil {
			return nil, err
		}
		for _, m := range v.Data {
			out = append(out, ModelInfo{ID: m.ID, Name: m.DisplayName, ContextWindow: m.MaxInputTokens, MaxOutput: m.MaxTokens})
		}
		if !v.HasMore || v.LastID == "" {
			break
		}
		after = v.LastID
	}
	return out, nil
}
