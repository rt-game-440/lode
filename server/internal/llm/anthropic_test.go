package llm

import (
	"context"
	"strings"
	"testing"
)

func anthropicFrame(event, data string) string { return "event: " + event + "\ndata: " + data }

func TestAnthropicStreamTextThinkingAndTools(t *testing.T) {
	srv, got := fakeServer(t, sseFrames(
		anthropicFrame("message_start", `{"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":100,"cache_read_input_tokens":20,"output_tokens":1}}}`),
		anthropicFrame("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`),
		anthropicFrame("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想一"}}`),
		anthropicFrame("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想。"}}`),
		anthropicFrame("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG"}}`),
		anthropicFrame("content_block_stop", `{"type":"content_block_stop","index":0}`),
		anthropicFrame("content_block_start", `{"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"RED"}}`),
		anthropicFrame("content_block_stop", `{"type":"content_block_stop","index":1}`),
		anthropicFrame("ping", `{"type":"ping"}`),
		anthropicFrame("content_block_start", `{"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}`),
		anthropicFrame("content_block_delta", `{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"好的，"}}`),
		anthropicFrame("content_block_delta", `{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"我来查。"}}`),
		anthropicFrame("content_block_stop", `{"type":"content_block_stop","index":2}`),
		anthropicFrame("content_block_start", `{"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_1","name":"search_notes","input":{}}}`),
		anthropicFrame("content_block_delta", `{"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\"query\":"}}`),
		anthropicFrame("content_block_delta", `{"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"\"周报\"}"}}`),
		anthropicFrame("content_block_stop", `{"type":"content_block_stop","index":3}`),
		anthropicFrame("message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":30}}`),
		anthropicFrame("message_stop", `{"type":"message_stop"}`),
	))
	req := Request{
		Model: "claude-sonnet-5-5", System: "你是助手", Messages: toolHistory(KindAnthropic), Tools: sampleTools,
		MaxTokens: 16000, Temperature: float(0.3), Effort: EffortMedium,
	}
	evs, res, err := collect(t, context.Background(), Config{Kind: KindAnthropic, BaseURL: srv.URL, APIKey: "sk-ant"}, req)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, summary(evs), []string{
		"thinking:想一想。",
		"text:好的，我来查。",
		`tool_call:search_notes {"query":"周报"}`,
		`usage:{"input":120,"output":30}`,
		"done:tool_calls",
	}, "事件")
	// 思考块连同签名、redacted_thinking 都要保存，下一轮原样带回
	eq(t, res.Message.Parts[0], Part{Type: PartThinking, Text: "想一想。", Signature: "SIG", Provider: KindAnthropic}, "思考块")
	eq(t, res.Message.Parts[1], Part{Type: PartThinking, Redacted: "RED", Provider: KindAnthropic}, "redacted 块")
	eq(t, res.Message.Calls()[0].ID, "toolu_1", "工具调用 id")

	eq(t, got.Path, "/v1/messages", "路径")
	eq(t, got.Header.Get("x-api-key"), "sk-ant", "鉴权头")
	eq(t, got.Header.Get("anthropic-version"), "2026-10-21", "API 版本")
	b := got.Body
	eq(t, b["model"], "claude-sonnet-5-5", "model")
	eq(t, b["max_tokens"], 16000, "max_tokens")
	eq(t, b["stream"], true, "stream")
	eq(t, b["system"], "你是助手", "system")
	if _, ok := b["temperature"]; ok {
		t.Error("API 版本 2026-10-21 不接受 temperature，不应发送")
	}
	eq(t, b["thinking"], map[string]any{"type": "adaptive"}, "thinking")
	eq(t, b["output_config"], map[string]any{"effort": "medium"}, "effort")
	eq(t, path(b, "tools.0"), map[string]any{"name": "search_notes", "description": "搜索笔记", "input_schema": map[string]any{
		"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string"}}, "required": []string{"query"},
	}}, "工具")
	eq(t, path(b, "messages.0.content.0"), map[string]any{"type": "text", "text": "找一下周报"}, "用户正文")
	eq(t, path(b, "messages.0.content.1"), map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": "UE5H"}}, "图片")
	eq(t, path(b, "messages.1.role"), "assistant", "助手")
	eq(t, path(b, "messages.1.content.0"), map[string]any{"type": "thinking", "thinking": "先搜索", "signature": "sig-1"}, "带回思考块")
	eq(t, path(b, "messages.1.content.1"), map[string]any{"type": "text", "text": "我来搜索。"}, "助手正文")
	eq(t, path(b, "messages.1.content.2"), map[string]any{"type": "tool_use", "id": "call_1", "name": "search_notes", "input": map[string]any{"query": "周报"}}, "工具调用")
	eq(t, path(b, "messages.2"), map[string]any{"role": "user", "content": []any{
		map[string]any{"type": "tool_result", "tool_use_id": "call_1", "content": `[{"path":"周报.md"}]`},
	}}, "工具结果")
}

func TestAnthropicDropsForeignThinkingAndMergesUserTurns(t *testing.T) {
	srv, got := fakeServer(t, sseFrames(anthropicFrame("message_stop", `{"type":"message_stop"}`)))
	msgs := append(toolHistory(KindOpenAI), Message{Role: RoleUser, Parts: []Part{{Type: PartText, Text: "继续"}}},
		Message{Role: RoleUser, Parts: []Part{{Type: PartMedia, Media: &Media{MIME: "application/pdf", Name: "r.pdf", Data: []byte("PDF")}}}})
	if _, _, err := collect(t, context.Background(), Config{Kind: KindAnthropic, BaseURL: srv.URL}, Request{Model: "claude-opus-5-5", MaxTokens: 100, Messages: msgs}); err != nil {
		t.Fatal(err)
	}
	b := got.Body
	eq(t, path(b, "messages.1.content.0.type"), "text", "其他供应商的思考不带回")
	eq(t, len(b["messages"].([]any)), 3, "连续的 user 消息合并为一条")
	eq(t, path(b, "messages.2.content.0.type"), "tool_result", "tool_result 在前")
	eq(t, path(b, "messages.2.content.1"), map[string]any{"type": "text", "text": "继续"}, "随后是正文")
	eq(t, path(b, "messages.2.content.2.type"), "document", "PDF")
	if _, ok := b["thinking"]; ok {
		t.Error("没有设置推理强度时不应发送 thinking")
	}
}

func TestAnthropicErrors(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   ErrorKind
	}{
		{401, `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`, ErrAuth},
		{429, `{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your rate limit"}}`, ErrRateLimit},
		{400, `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}`, ErrContextLength},
		{404, `{"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}`, ErrModelNotFound},
		{529, `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`, ErrServer},
	}
	for _, c := range cases {
		srv, _ := fakeServer(t, jsonError(c.status, c.body))
		_, _, err := collect(t, context.Background(), Config{Kind: KindAnthropic, BaseURL: srv.URL}, Request{Model: "m", MaxTokens: 10})
		if e := AsError(err); e.Kind != c.want {
			t.Errorf("HTTP %d：得到 %s，期望 %s", c.status, e.Kind, c.want)
		}
	}
	// 流中途的 error 事件
	srv, _ := fakeServer(t, sseFrames(
		anthropicFrame("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
		anthropicFrame("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半"}}`),
		anthropicFrame("error", `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`),
	))
	evs, _, err := collect(t, context.Background(), Config{Kind: KindAnthropic, BaseURL: srv.URL}, Request{Model: "m", MaxTokens: 10})
	if e := AsError(err); e.Kind != ErrServer || !strings.Contains(e.Error(), "Overloaded") {
		t.Errorf("流中途错误：%v", err)
	}
	eq(t, summary(evs), []string{"text:半", "error:server"}, "流中途错误事件")
	// 超出上下文窗口的结束原因
	srv, _ = fakeServer(t, sseFrames(anthropicFrame("message_delta", `{"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded"},"usage":{"output_tokens":3}}`)))
	_, _, err = collect(t, context.Background(), Config{Kind: KindAnthropic, BaseURL: srv.URL}, Request{Model: "m", MaxTokens: 10})
	if AsError(err).Kind != ErrContextLength {
		t.Errorf("model_context_window_exceeded：%v", err)
	}
}

func TestAnthropicCancel(t *testing.T) {
	testCancel(t, KindAnthropic, anthropicFrame("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)+"\n\n"+
		anthropicFrame("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"第一段"}}`))
}
