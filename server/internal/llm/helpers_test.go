package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// captured 是模拟服务收到的请求。
type captured struct {
	Method string
	Path   string
	Query  string
	Header http.Header
	Body   map[string]any
}

// fakeServer 启动一个模拟供应商：记录请求，按 respond 写响应。
func fakeServer(t *testing.T, respond func(w http.ResponseWriter, r *http.Request)) (*httptest.Server, *captured) {
	t.Helper()
	got := &captured{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.Method, got.Path, got.Query, got.Header = r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Clone()
		b, _ := io.ReadAll(r.Body)
		got.Body = nil
		if len(b) > 0 {
			if err := json.Unmarshal(b, &got.Body); err != nil {
				t.Errorf("请求体不是 JSON：%s", b)
			}
		}
		respond(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

// sseFrames 按顺序写出 SSE 帧，每帧之后 flush。
func sseFrames(frames ...string) func(w http.ResponseWriter, r *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, f := range frames {
			io.WriteString(w, f+"\n\n")
			w.(http.Flusher).Flush()
		}
	}
}

// jsonError 写一个错误响应。
func jsonError(status int, body string) func(w http.ResponseWriter, r *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	}
}

// collect 跑一次 Stream，返回事件列表。
func collect(t *testing.T, ctx context.Context, cfg Config, req Request) ([]Event, Result, error) {
	t.Helper()
	var evs []Event
	res, err := Stream(ctx, cfg, req, func(e Event) { evs = append(evs, e) })
	return evs, res, err
}

// summary 把事件压成便于比较的字符串：text 和 thinking 连续的增量合并。
func summary(evs []Event) []string {
	var out []string
	for _, e := range evs {
		var s string
		switch e.Type {
		case EventText, EventThinking:
			s = string(e.Type) + ":" + e.Text
			if n := len(out); n > 0 && strings.HasPrefix(out[n-1], string(e.Type)+":") {
				out[n-1] += e.Text
				continue
			}
		case EventToolCall:
			s = "tool_call:" + e.Call.Name + " " + compactJSON(e.Call.Args)
		case EventUsage:
			b, _ := json.Marshal(e.Usage)
			s = "usage:" + string(b)
		case EventDone:
			s = "done:" + string(e.Stop)
		case EventError:
			s = "error:" + string(e.Err.Kind)
		}
		out = append(out, s)
	}
	return out
}

func compactJSON(raw json.RawMessage) string {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return string(raw)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// path 按 a.b.0.c 取 JSON 里的值。
func path(v any, p string) any {
	for _, k := range strings.Split(p, ".") {
		switch x := v.(type) {
		case map[string]any:
			v = x[k]
		case []any:
			i := 0
			for _, c := range k {
				i = i*10 + int(c-'0')
			}
			if i >= len(x) {
				return nil
			}
			v = x[i]
		default:
			return nil
		}
	}
	return v
}

func eq(t *testing.T, got, want any, what string) {
	t.Helper()
	gb, _ := json.Marshal(got)
	wb, _ := json.Marshal(want)
	if string(gb) != string(wb) {
		t.Errorf("%s：得到 %s，期望 %s", what, gb, wb)
	}
}

// sampleTools 是测试用的工具定义。
var sampleTools = []ToolDef{{
	Name:        "search_notes",
	Description: "搜索笔记",
	Schema:      json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}`),
}}

// toolHistory 是一段带工具调用的历史：用户提问 → 助手调用工具 → 工具结果。
func toolHistory(provider Kind) []Message {
	return []Message{
		{Role: RoleUser, Parts: []Part{
			{Type: PartText, Text: "找一下周报"},
			{Type: PartMedia, Media: &Media{MIME: "image/png", Name: "a.png", Data: []byte("PNG")}},
		}},
		{Role: RoleAssistant, Parts: []Part{
			{Type: PartThinking, Text: "先搜索", Signature: "sig-1", Provider: provider},
			{Type: PartText, Text: "我来搜索。"},
			{Type: PartToolCall, Call: &ToolCall{ID: "call_1", Name: "search_notes", Args: json.RawMessage(`{"query":"周报"}`), Signature: "fsig"}},
		}},
		{Role: RoleUser, Parts: []Part{
			{Type: PartToolResult, Result: &ToolResult{CallID: "call_1", Name: "search_notes", Content: `[{"path":"周报.md"}]`}},
		}},
	}
}

func float(f float64) *float64 { return &f }
