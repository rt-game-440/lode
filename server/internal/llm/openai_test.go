package llm

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestOpenAIStreamTextThinkingAndTools(t *testing.T) {
	srv, got := fakeServer(t, sseFrames(
		`data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"想一"}}]}`,
		`data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"想。"}}]}`,
		`data: {"id":"c1","choices":[{"index":0,"delta":{"content":"好的，"}}]}`,
		`data: {"id":"c1","choices":[{"index":0,"delta":{"content":"我来查。"}}]}`,
		`data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"search_notes","arguments":""}}]}}]}`,
		`data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":"}}]}}]}`,
		`data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"read_note","arguments":"{\"path\":\"a.md\"}"}}]}}]}`,
		`data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"周报\"}"}}]}}]}`,
		`data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
		`data: {"id":"c1","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"completion_tokens_details":{"reasoning_tokens":8}}}`,
		`data: [DONE]`,
	))
	req := Request{
		Model: "gpt-test", System: "你是助手", Messages: toolHistory(KindOpenAI), Tools: sampleTools,
		MaxTokens: 1000, Temperature: float(0.3), Effort: EffortMedium,
	}
	evs, res, err := collect(t, context.Background(), Config{Kind: KindOpenAI, BaseURL: srv.URL + "/v1", APIKey: "sk-test"}, req)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, summary(evs), []string{
		"thinking:想一想。",
		"text:好的，我来查。",
		`tool_call:search_notes {"query":"周报"}`,
		`tool_call:read_note {"path":"a.md"}`,
		`usage:{"input":120,"output":30,"reasoning":8}`,
		"done:tool_calls",
	}, "事件")
	eq(t, res.Message.Text(), "好的，我来查。", "正文")
	eq(t, len(res.Message.Calls()), 2, "工具调用数")
	eq(t, res.Message.Calls()[0].ID, "call_a", "工具调用 id")

	// 请求格式
	eq(t, got.Path, "/v1/chat/completions", "路径")
	eq(t, got.Header.Get("Authorization"), "Bearer sk-test", "鉴权头")
	b := got.Body
	eq(t, b["model"], "gpt-test", "model")
	eq(t, b["stream"], true, "stream")
	eq(t, path(b, "stream_options.include_usage"), true, "include_usage")
	eq(t, b["max_completion_tokens"], 1000, "max_completion_tokens")
	eq(t, b["temperature"], 0.3, "temperature")
	eq(t, b["reasoning_effort"], "medium", "reasoning_effort")
	eq(t, path(b, "tools.0.type"), "function", "工具类型")
	eq(t, path(b, "tools.0.function.name"), "search_notes", "工具名")
	eq(t, path(b, "tools.0.function.parameters.required"), []string{"query"}, "工具参数")
	eq(t, path(b, "messages.0"), map[string]any{"role": "system", "content": "你是助手"}, "系统提示")
	eq(t, path(b, "messages.1.content.0"), map[string]any{"type": "text", "text": "找一下周报"}, "用户正文")
	eq(t, path(b, "messages.1.content.1.image_url.url"), "data:image/png;base64,UE5H", "图片")
	eq(t, path(b, "messages.2.role"), "assistant", "助手消息")
	eq(t, path(b, "messages.2.content"), "我来搜索。", "助手正文（不带思考）")
	eq(t, path(b, "messages.2.tool_calls.0"), map[string]any{
		"id": "call_1", "type": "function", "function": map[string]any{"name": "search_notes", "arguments": `{"query":"周报"}`},
	}, "助手工具调用")
	eq(t, path(b, "messages.3"), map[string]any{"role": "tool", "tool_call_id": "call_1", "content": `[{"path":"周报.md"}]`}, "工具结果")
	eq(t, len(b["messages"].([]any)), 4, "消息条数")
}

func TestOpenAIMediaPDFAndAudio(t *testing.T) {
	srv, got := fakeServer(t, sseFrames(`data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`, `data: [DONE]`))
	req := Request{Model: "m", MaxTokens: 10, Messages: []Message{{Role: RoleUser, Parts: []Part{
		{Type: PartMedia, Media: &Media{MIME: "application/pdf", Name: "r.pdf", Data: []byte("PDF")}},
		{Type: PartMedia, Media: &Media{MIME: "audio/mpeg", Name: "v.mp3", Data: []byte("MP3")}},
	}}}}
	if _, _, err := collect(t, context.Background(), Config{Kind: KindOpenAI, BaseURL: srv.URL}, req); err != nil {
		t.Fatal(err)
	}
	eq(t, path(got.Body, "messages.0.content.0"), map[string]any{"type": "file", "file": map[string]any{"filename": "r.pdf", "file_data": "data:application/pdf;base64,UERG"}}, "PDF")
	eq(t, path(got.Body, "messages.0.content.1"), map[string]any{"type": "input_audio", "input_audio": map[string]any{"data": "TVAz", "format": "mp3"}}, "音频")
	if _, ok := got.Body["reasoning_effort"]; ok {
		t.Error("没有设置推理强度时不应发送 reasoning_effort")
	}
	if _, ok := got.Body["tools"]; ok {
		t.Error("没有工具时不应发送 tools")
	}
}

func TestOpenAIErrors(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   ErrorKind
	}{
		{401, `{"error":{"message":"Incorrect API key provided: sk-secret-key","type":"invalid_request_error","code":"invalid_api_key"}}`, ErrAuth},
		{429, `{"error":{"message":"Rate limit reached","type":"requests","code":"rate_limit_exceeded"}}`, ErrRateLimit},
		{400, `{"error":{"message":"This model's maximum context length is 8192 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}`, ErrContextLength},
		{404, `{"error":{"message":"The model 'gpt-x' does not exist","type":"invalid_request_error","code":"model_not_found"}}`, ErrModelNotFound},
		{400, `{"error":{"message":"Unsupported value: 'none'","type":"invalid_request_error","code":"unsupported_value"}}`, ErrBadRequest},
		{503, `upstream overloaded`, ErrServer},
	}
	for _, c := range cases {
		srv, _ := fakeServer(t, jsonError(c.status, c.body))
		evs, _, err := collect(t, context.Background(), Config{Kind: KindOpenAI, BaseURL: srv.URL, APIKey: "sk-secret-key"}, Request{Model: "m", MaxTokens: 10})
		e := AsError(err)
		if e.Kind != c.want || e.Status != c.status {
			t.Errorf("HTTP %d：得到 %s/%d，期望 %s", c.status, e.Kind, e.Status, c.want)
		}
		eq(t, summary(evs), []string{"error:" + string(c.want)}, "错误事件")
		if strings.Contains(e.Error(), "sk-secret-key") {
			t.Errorf("错误说明里不能有 API key：%s", e.Error())
		}
	}
	// 流中途的错误帧
	srv, _ := fakeServer(t, sseFrames(`data: {"choices":[{"index":0,"delta":{"content":"半"}}]}`, `data: {"error":{"message":"overloaded","type":"server_error"}}`))
	evs, _, err := collect(t, context.Background(), Config{Kind: KindOpenAI, BaseURL: srv.URL}, Request{Model: "m", MaxTokens: 10})
	if AsError(err).Kind != ErrServer {
		t.Errorf("流中途错误：%v", err)
	}
	eq(t, summary(evs), []string{"text:半", "error:server"}, "流中途错误事件")
}

func TestOpenAICancel(t *testing.T) {
	testCancel(t, KindOpenAI, `data: {"choices":[{"index":0,"delta":{"content":"第一段"}}]}`)
}

// testCancel：服务端发出一段内容后挂起，客户端收到第一段后取消，应以 canceled 结束且不再阻塞。
func testCancel(t *testing.T, kind Kind, first string) {
	t.Helper()
	release := make(chan struct{})
	srv, _ := fakeServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, first+"\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-release:
		}
	})
	defer close(release)
	ctx, cancel := context.WithCancel(context.Background())
	var evs []Event
	done := make(chan error, 1)
	go func() {
		_, err := Stream(ctx, Config{Kind: kind, BaseURL: srv.URL}, Request{Model: "m", MaxTokens: 10}, func(e Event) {
			evs = append(evs, e)
			if e.Type == EventText {
				cancel()
			}
		})
		done <- err
	}()
	select {
	case err := <-done:
		if AsError(err).Kind != ErrCanceled {
			t.Fatalf("期望 canceled，得到 %v", err)
		}
		eq(t, summary(evs), []string{"text:第一段", "error:canceled"}, "取消事件")
	case <-time.After(5 * time.Second):
		t.Fatal("取消后没有结束")
	}
}
