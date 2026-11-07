package llm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Gemini generateContent 流式接口。格式见 docs/agent.md。

func geminiHeader(cfg Config) http.Header {
	h := http.Header{}
	if cfg.APIKey != "" {
		h.Set("x-goog-api-key", cfg.APIKey)
	}
	return h
}

var geminiMajor = regexp.MustCompile(`gemini-(\d+)`)

// geminiThinking 返回 generationConfig.thinkingConfig；为 nil 时不发送。
// Gemini 3 及以后用 thinkingLevel，更早的模型用 thinkingBudget（用 thinkingLevel 会报错）。
func geminiThinking(model string, e Effort) any {
	if e == "" {
		return nil
	}
	m := geminiMajor.FindStringSubmatch(model)
	major := 0
	if m != nil {
		major, _ = strconv.Atoi(m[1])
	}
	cfg := map[string]any{}
	if major >= 3 {
		cfg["thinkingLevel"] = map[Effort]string{EffortOff: "MINIMAL", EffortLow: "LOW", EffortMedium: "MEDIUM", EffortHigh: "HIGH"}[e]
	} else {
		cfg["thinkingBudget"] = map[Effort]int{EffortOff: 0, EffortLow: 2048, EffortMedium: 8192, EffortHigh: 24576}[e]
	}
	if e != EffortOff {
		cfg["includeThoughts"] = true
	}
	return cfg
}

func geminiModel(model string) string { return strings.TrimPrefix(model, "models/") }

func geminiBody(req Request) map[string]any {
	body := map[string]any{"contents": geminiContents(req.Messages)}
	if req.System != "" {
		body["systemInstruction"] = map[string]any{"parts": []any{map[string]any{"text": req.System}}}
	}
	gc := map[string]any{}
	if req.MaxTokens > 0 {
		gc["maxOutputTokens"] = req.MaxTokens
	}
	if req.Temperature != nil {
		gc["temperature"] = *req.Temperature
	}
	if th := geminiThinking(req.Model, req.Effort); th != nil {
		gc["thinkingConfig"] = th
	}
	if len(gc) > 0 {
		body["generationConfig"] = gc
	}
	if len(req.Tools) > 0 {
		decls := make([]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			decls = append(decls, map[string]any{"name": t.Name, "description": t.Description, "parametersJsonSchema": t.Schema})
		}
		body["tools"] = []any{map[string]any{"functionDeclarations": decls}}
	}
	return body
}

// geminiContents 转换消息：assistant 对应 model；连续同角色合并；思考摘要不带回，签名带回。
func geminiContents(msgs []Message) []any {
	type content struct {
		role  string
		parts []any
	}
	var out []*content
	for _, m := range msgs {
		role := "user"
		if m.Role == RoleAssistant {
			role = "model"
		}
		var c *content
		if n := len(out); n > 0 && out[n-1].role == role {
			c = out[n-1]
		} else {
			c = &content{role: role}
			out = append(out, c)
		}
		for _, p := range m.Parts {
			switch p.Type {
			case PartText:
				if p.Text == "" {
					continue
				}
				part := map[string]any{"text": p.Text}
				if p.Signature != "" && p.Provider == KindGemini {
					part["thoughtSignature"] = p.Signature
				}
				c.parts = append(c.parts, part)
			case PartToolCall:
				fc := map[string]any{"id": p.Call.ID, "name": p.Call.Name, "args": argsOrEmpty(p.Call.Args)}
				part := map[string]any{"functionCall": fc}
				if p.Call.Signature != "" {
					part["thoughtSignature"] = p.Call.Signature
				}
				c.parts = append(c.parts, part)
			case PartToolResult:
				key := "result"
				if p.Result.IsError {
					key = "error"
				}
				c.parts = append(c.parts, map[string]any{"functionResponse": map[string]any{
					"id": p.Result.CallID, "name": p.Result.Name, "response": map[string]any{key: p.Result.Content},
				}})
			case PartMedia:
				c.parts = append(c.parts, map[string]any{"inlineData": map[string]any{
					"mimeType": p.Media.MIME, "data": base64.StdEncoding.EncodeToString(p.Media.Data),
				}})
			}
		}
	}
	res := make([]any, 0, len(out))
	for _, c := range out {
		if len(c.parts) == 0 {
			c.parts = []any{map[string]any{"text": "…"}}
		}
		res = append(res, map[string]any{"role": c.role, "parts": c.parts})
	}
	return res
}

type geminiChunk struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text             string `json:"text"`
				Thought          bool   `json:"thought"`
				ThoughtSignature string `json:"thoughtSignature"`
				FunctionCall     *struct {
					ID   string          `json:"id"`
					Name string          `json:"name"`
					Args json.RawMessage `json:"args"`
				} `json:"functionCall"`
			} `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	PromptFeedback *struct {
		BlockReason string `json:"blockReason"`
	} `json:"promptFeedback"`
	UsageMetadata *struct {
		PromptTokenCount     int `json:"promptTokenCount"`
		CandidatesTokenCount int `json:"candidatesTokenCount"`
		ThoughtsTokenCount   int `json:"thoughtsTokenCount"`
	} `json:"usageMetadata"`
	Error json.RawMessage `json:"error"`
}

func streamGemini(ctx context.Context, cfg Config, req Request, emit func(Event)) (Result, error) {
	u := cfg.base() + "/v1beta/models/" + url.PathEscape(geminiModel(req.Model)) + ":streamGenerateContent?alt=sse"
	resp, err := post(ctx, cfg, u, geminiHeader(cfg), geminiBody(req))
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()

	var (
		res      Result
		thinking strings.Builder
		text     strings.Builder
		textSig  string
		calls    []*ToolCall
		finish   string
		blocked  bool
	)
	err = readSSE(resp.Body, func(_, data string) error {
		var c geminiChunk
		if err := json.Unmarshal([]byte(data), &c); err != nil {
			return nil
		}
		if len(c.Error) > 0 && string(c.Error) != "null" {
			var st struct {
				Code int `json:"code"`
			}
			json.Unmarshal(c.Error, &st)
			e := httpError(st.Code, []byte(data))
			e.Status = 0
			if e.Kind == ErrBadRequest && st.Code == 0 {
				e.Kind = ErrServer
			}
			return e
		}
		if c.PromptFeedback != nil && c.PromptFeedback.BlockReason != "" {
			blocked = true
		}
		if u := c.UsageMetadata; u != nil {
			res.Usage = Usage{Input: u.PromptTokenCount, Output: u.CandidatesTokenCount + u.ThoughtsTokenCount, Reasoning: u.ThoughtsTokenCount}
		}
		if len(c.Candidates) == 0 {
			return nil
		}
		cand := c.Candidates[0]
		for _, p := range cand.Content.Parts {
			switch {
			case p.FunctionCall != nil:
				call := &ToolCall{ID: p.FunctionCall.ID, Name: p.FunctionCall.Name, Args: argsOrEmpty(p.FunctionCall.Args), Signature: p.ThoughtSignature}
				if call.ID == "" {
					call.ID = genID("call", len(calls))
				}
				calls = append(calls, call)
				emit(Event{Type: EventToolCall, Call: call})
			case p.Thought:
				if p.Text != "" {
					thinking.WriteString(p.Text)
					emit(Event{Type: EventThinking, Text: p.Text})
				}
			default:
				if p.ThoughtSignature != "" {
					textSig = p.ThoughtSignature
				}
				if p.Text != "" {
					text.WriteString(p.Text)
					emit(Event{Type: EventText, Text: p.Text})
				}
			}
		}
		if cand.FinishReason != "" {
			finish = cand.FinishReason
		}
		return nil
	})
	if err != nil {
		return res, err
	}
	res.Message.Role = RoleAssistant
	if thinking.Len() > 0 {
		res.Message.Parts = append(res.Message.Parts, Part{Type: PartThinking, Text: thinking.String(), Provider: KindGemini})
	}
	if text.Len() > 0 || textSig != "" {
		res.Message.Parts = append(res.Message.Parts, Part{Type: PartText, Text: text.String(), Signature: textSig, Provider: KindGemini})
	}
	for _, c := range calls {
		res.Message.Parts = append(res.Message.Parts, Part{Type: PartToolCall, Call: c})
	}
	switch {
	case finish == "MALFORMED_FUNCTION_CALL":
		return res, &Error{Kind: ErrServer, Detail: "模型生成了格式错误的工具调用（MALFORMED_FUNCTION_CALL）"}
	case len(calls) > 0:
		res.Stop = StopToolCalls
	case finish == "MAX_TOKENS":
		res.Stop = StopMaxTokens
	case blocked || (finish != "" && finish != "STOP" && finish != "FINISH_REASON_UNSPECIFIED"):
		res.Stop = StopRefusal
	default:
		res.Stop = StopEnd
	}
	return res, nil
}

func listGemini(ctx context.Context, cfg Config) ([]ModelInfo, error) {
	var out []ModelInfo
	token := ""
	for page := 0; page < 10; page++ {
		u := cfg.base() + "/v1beta/models?pageSize=1000"
		if token != "" {
			u += "&pageToken=" + url.QueryEscape(token)
		}
		var v struct {
			Models []struct {
				Name                       string   `json:"name"`
				DisplayName                string   `json:"displayName"`
				InputTokenLimit            int      `json:"inputTokenLimit"`
				OutputTokenLimit           int      `json:"outputTokenLimit"`
				SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
			} `json:"models"`
			NextPageToken string `json:"nextPageToken"`
		}
		if err := get(ctx, cfg, u, geminiHeader(cfg), &v); err != nil {
			return nil, err
		}
		for _, m := range v.Models {
			ok := len(m.SupportedGenerationMethods) == 0
			for _, g := range m.SupportedGenerationMethods {
				ok = ok || g == "generateContent"
			}
			if ok {
				out = append(out, ModelInfo{ID: geminiModel(m.Name), Name: m.DisplayName, ContextWindow: m.InputTokenLimit, MaxOutput: m.OutputTokenLimit})
			}
		}
		if v.NextPageToken == "" {
			break
		}
		token = v.NextPageToken
	}
	return out, nil
}
