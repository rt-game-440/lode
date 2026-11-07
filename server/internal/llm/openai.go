package llm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
)

// OpenAI 兼容：Chat Completions 流式接口。格式见 docs/agent.md。

func openAIHeader(cfg Config) http.Header {
	h := http.Header{}
	if cfg.APIKey != "" {
		h.Set("Authorization", "Bearer "+cfg.APIKey)
	}
	return h
}

// openAIEffort 把推理强度映射为 reasoning_effort；空表示不发送。
func openAIEffort(e Effort) string {
	switch e {
	case EffortOff:
		return "none"
	case EffortLow, EffortMedium, EffortHigh:
		return string(e)
	}
	return ""
}

func openAIBody(req Request) map[string]any {
	msgs := []any{}
	if req.System != "" {
		msgs = append(msgs, map[string]any{"role": "system", "content": req.System})
	}
	for _, m := range req.Messages {
		msgs = append(msgs, openAIMessages(m)...)
	}
	body := map[string]any{
		"model":          req.Model,
		"messages":       msgs,
		"stream":         true,
		"stream_options": map[string]any{"include_usage": true},
	}
	if req.MaxTokens > 0 {
		body["max_completion_tokens"] = req.MaxTokens
	}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if e := openAIEffort(req.Effort); e != "" {
		body["reasoning_effort"] = e
	}
	if len(req.Tools) > 0 {
		tools := make([]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			tools = append(tools, map[string]any{"type": "function", "function": map[string]any{
				"name": t.Name, "description": t.Description, "parameters": t.Schema,
			}})
		}
		body["tools"] = tools
	}
	return body
}

// openAIMessages 转换一条消息：工具结果拆成独立的 tool 消息，排在用户内容之前。
func openAIMessages(m Message) []any {
	var out []any
	if m.Role == RoleAssistant {
		msg := map[string]any{"role": "assistant"}
		text := m.Text()
		var calls []any
		for _, c := range m.Calls() {
			calls = append(calls, map[string]any{"id": c.ID, "type": "function", "function": map[string]any{"name": c.Name, "arguments": string(argsOrEmpty(c.Args))}})
		}
		if text != "" || len(calls) == 0 {
			msg["content"] = text
		} else {
			msg["content"] = nil
		}
		if len(calls) > 0 {
			msg["tool_calls"] = calls
		}
		return []any{msg}
	}
	var content []any
	for _, p := range m.Parts {
		switch p.Type {
		case PartToolResult:
			out = append(out, map[string]any{"role": "tool", "tool_call_id": p.Result.CallID, "content": p.Result.Content})
		case PartText:
			content = append(content, map[string]any{"type": "text", "text": p.Text})
		case PartMedia:
			content = append(content, openAIMedia(p.Media))
		}
	}
	if len(content) > 0 {
		out = append(out, map[string]any{"role": "user", "content": content})
	}
	return out
}

func openAIMedia(md *Media) map[string]any {
	b64 := base64.StdEncoding.EncodeToString(md.Data)
	switch {
	case strings.HasPrefix(md.MIME, "image/"):
		return map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:" + md.MIME + ";base64," + b64}}
	case strings.HasPrefix(md.MIME, "audio/"):
		format := "wav"
		if strings.Contains(md.MIME, "mpeg") || strings.Contains(md.MIME, "mp3") {
			format = "mp3"
		}
		return map[string]any{"type": "input_audio", "input_audio": map[string]any{"data": b64, "format": format}}
	default:
		return map[string]any{"type": "file", "file": map[string]any{"filename": md.Name, "file_data": "data:" + md.MIME + ";base64," + b64}}
	}
}

func argsOrEmpty(a json.RawMessage) json.RawMessage {
	if len(strings.TrimSpace(string(a))) == 0 {
		return json.RawMessage("{}")
	}
	return a
}

type openAIChunk struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			Refusal          string `json:"refusal"`
			ReasoningContent string `json:"reasoning_content"` // 非 OpenAI 官方字段：DeepSeek、vLLM 等
			Reasoning        string `json:"reasoning"`         // 非 OpenAI 官方字段：OpenRouter 等
			ToolCalls        []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens        int `json:"prompt_tokens"`
		CompletionTokens    int `json:"completion_tokens"`
		CompletionTokensDet *struct {
			ReasoningTokens int `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
	Error json.RawMessage `json:"error"`
}

type callBuf struct {
	id, name string
	args     strings.Builder
}

func streamOpenAI(ctx context.Context, cfg Config, req Request, emit func(Event)) (Result, error) {
	resp, err := post(ctx, cfg, cfg.base()+"/chat/completions", openAIHeader(cfg), openAIBody(req))
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()

	var (
		res      Result
		thinking strings.Builder
		text     strings.Builder
		calls    = map[int]*callBuf{}
		finish   string
	)
	err = readSSE(resp.Body, func(_, data string) error {
		if data == "[DONE]" {
			return errStop
		}
		var c openAIChunk
		if err := json.Unmarshal([]byte(data), &c); err != nil {
			return nil // 兼容服务偶尔夹带非 JSON 的注释帧，忽略
		}
		if len(c.Error) > 0 && string(c.Error) != "null" {
			e := httpError(0, []byte(data))
			if e.Kind == ErrBadRequest {
				e.Kind = ErrServer
			}
			return e
		}
		if c.Usage != nil {
			res.Usage.Input, res.Usage.Output = c.Usage.PromptTokens, c.Usage.CompletionTokens
			if c.Usage.CompletionTokensDet != nil {
				res.Usage.Reasoning = c.Usage.CompletionTokensDet.ReasoningTokens
			}
		}
		for _, ch := range c.Choices {
			d := ch.Delta
			if r := d.ReasoningContent + d.Reasoning; r != "" {
				thinking.WriteString(r)
				emit(Event{Type: EventThinking, Text: r})
			}
			if t := d.Content + d.Refusal; t != "" {
				text.WriteString(t)
				emit(Event{Type: EventText, Text: t})
			}
			for _, tc := range d.ToolCalls {
				b := calls[tc.Index]
				if b == nil {
					b = &callBuf{}
					calls[tc.Index] = b
				}
				if tc.ID != "" {
					b.id = tc.ID
				}
				if tc.Function.Name != "" {
					b.name = tc.Function.Name
				}
				b.args.WriteString(tc.Function.Arguments)
			}
			if ch.FinishReason != "" {
				finish = ch.FinishReason
			}
		}
		return nil
	})
	if err != nil && err != errStop {
		return res, err
	}

	if thinking.Len() > 0 {
		res.Message.Parts = append(res.Message.Parts, Part{Type: PartThinking, Text: thinking.String(), Provider: KindOpenAI})
	}
	if text.Len() > 0 {
		res.Message.Parts = append(res.Message.Parts, Part{Type: PartText, Text: text.String()})
	}
	idx := make([]int, 0, len(calls))
	for i := range calls {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for n, i := range idx {
		b := calls[i]
		if b.id == "" {
			b.id = genID("call", n)
		}
		call := &ToolCall{ID: b.id, Name: b.name, Args: argsOrEmpty(json.RawMessage(b.args.String()))}
		res.Message.Parts = append(res.Message.Parts, Part{Type: PartToolCall, Call: call})
		emit(Event{Type: EventToolCall, Call: call})
	}
	res.Message.Role = RoleAssistant
	switch {
	case len(calls) > 0:
		res.Stop = StopToolCalls
	case finish == "length":
		res.Stop = StopMaxTokens
	case finish == "content_filter":
		res.Stop = StopRefusal
	default:
		res.Stop = StopEnd
	}
	return res, nil
}

func listOpenAI(ctx context.Context, cfg Config) ([]ModelInfo, error) {
	var v struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := get(ctx, cfg, cfg.base()+"/models", openAIHeader(cfg), &v); err != nil {
		return nil, err
	}
	out := make([]ModelInfo, 0, len(v.Data))
	for _, m := range v.Data {
		out = append(out, ModelInfo{ID: m.ID})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}
