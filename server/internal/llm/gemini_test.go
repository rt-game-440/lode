package llm

import (
	"context"
	"testing"
)

func TestGeminiStreamTextThinkingAndTools(t *testing.T) {
	srv, got := fakeServer(t, sseFrames(
		`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"想一","thought":true}]}}]}`,
		`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"想。","thought":true}]}}]}`,
		`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"好的，"}]}}]}`,
		`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"我来查。"}]}}]}`,
		`data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"search_notes","args":{"query":"周报"}},"thoughtSignature":"GSIG"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":30,"thoughtsTokenCount":8,"totalTokenCount":138}}`,
	))
	req := Request{
		Model: "gemini-3-flash", System: "你是助手", Messages: toolHistory(KindGemini), Tools: sampleTools,
		MaxTokens: 1000, Temperature: float(0.3), Effort: EffortLow,
	}
	evs, res, err := collect(t, context.Background(), Config{Kind: KindGemini, BaseURL: srv.URL, APIKey: "g-key"}, req)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, summary(evs), []string{
		"thinking:想一想。",
		"text:好的，我来查。",
		`tool_call:search_notes {"query":"周报"}`,
		`usage:{"input":100,"output":38,"reasoning":8}`,
		"done:tool_calls",
	}, "事件")
	call := res.Message.Calls()[0]
	eq(t, call.Signature, "GSIG", "functionCall 的 thoughtSignature 要保存")
	if call.ID == "" {
		t.Error("没有 id 的 functionCall 要补一个 id")
	}

	eq(t, got.Path, "/v1beta/models/gemini-3-flash:streamGenerateContent", "路径")
	eq(t, got.Query, "alt=sse", "查询参数（key 不放在 URL 里）")
	eq(t, got.Header.Get("x-goog-api-key"), "g-key", "鉴权头")
	b := got.Body
	eq(t, b["systemInstruction"], map[string]any{"parts": []any{map[string]any{"text": "你是助手"}}}, "系统提示")
	eq(t, b["generationConfig"], map[string]any{
		"maxOutputTokens": 1000, "temperature": 0.3,
		"thinkingConfig": map[string]any{"thinkingLevel": "LOW", "includeThoughts": true},
	}, "generationConfig")
	eq(t, path(b, "tools.0.functionDeclarations.0.name"), "search_notes", "工具")
	eq(t, path(b, "tools.0.functionDeclarations.0.parametersJsonSchema.required"), []string{"query"}, "工具参数")
	eq(t, path(b, "contents.0"), map[string]any{"role": "user", "parts": []any{
		map[string]any{"text": "找一下周报"},
		map[string]any{"inlineData": map[string]any{"mimeType": "image/png", "data": "UE5H"}},
	}}, "用户消息")
	eq(t, path(b, "contents.1"), map[string]any{"role": "model", "parts": []any{
		map[string]any{"text": "我来搜索。"},
		map[string]any{"functionCall": map[string]any{"id": "call_1", "name": "search_notes", "args": map[string]any{"query": "周报"}}, "thoughtSignature": "fsig"},
	}}, "模型消息（思考摘要不带回，签名带回）")
	eq(t, path(b, "contents.2"), map[string]any{"role": "user", "parts": []any{
		map[string]any{"functionResponse": map[string]any{"id": "call_1", "name": "search_notes", "response": map[string]any{"result": `[{"path":"周报.md"}]`}}},
	}}, "工具结果")
}

func TestGeminiErrors(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   ErrorKind
	}{
		{400, `{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}`, ErrAuth},
		{403, `{"error":{"code":403,"message":"Permission denied","status":"PERMISSION_DENIED"}}`, ErrAuth},
		{429, `{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}`, ErrRateLimit},
		{400, `{"error":{"code":400,"message":"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}`, ErrContextLength},
		{404, `{"error":{"code":404,"message":"models/gemini-x is not found for API version v1beta","status":"NOT_FOUND"}}`, ErrModelNotFound},
		{503, `{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}`, ErrServer},
	}
	for _, c := range cases {
		srv, _ := fakeServer(t, jsonError(c.status, c.body))
		_, _, err := collect(t, context.Background(), Config{Kind: KindGemini, BaseURL: srv.URL}, Request{Model: "m", MaxTokens: 10})
		if e := AsError(err); e.Kind != c.want {
			t.Errorf("HTTP %d：得到 %s，期望 %s", c.status, e.Kind, c.want)
		}
	}
	srv, _ := fakeServer(t, sseFrames(
		`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"半"}]}}]}`,
		`data: {"error":{"code":500,"message":"Internal error","status":"INTERNAL"}}`,
	))
	evs, _, err := collect(t, context.Background(), Config{Kind: KindGemini, BaseURL: srv.URL}, Request{Model: "m", MaxTokens: 10})
	if AsError(err).Kind != ErrServer {
		t.Errorf("流中途错误：%v", err)
	}
	eq(t, summary(evs), []string{"text:半", "error:server"}, "流中途错误事件")
	srv, _ = fakeServer(t, sseFrames(`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"x"}]},"finishReason":"SAFETY"}]}`))
	_, res, err := collect(t, context.Background(), Config{Kind: KindGemini, BaseURL: srv.URL}, Request{Model: "m", MaxTokens: 10})
	if err != nil || res.Stop != StopRefusal {
		t.Errorf("SAFETY 应结束为 refusal：%v %v", res.Stop, err)
	}
}

func TestGeminiCancel(t *testing.T) {
	testCancel(t, KindGemini, `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"第一段"}]}}]}`)
}
