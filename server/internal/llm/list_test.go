package llm

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestListModels(t *testing.T) {
	cases := []struct {
		kind Kind
		body string
		path string
		want []ModelInfo
	}{
		{KindOpenAI, `{"object":"list","data":[{"id":"gpt-b","object":"model"},{"id":"gpt-a","object":"model"}]}`, "/models",
			[]ModelInfo{{ID: "gpt-a"}, {ID: "gpt-b"}}},
		{KindAnthropic, `{"data":[{"id":"claude-x","display_name":"Claude X","max_input_tokens":200000,"max_tokens":64000}],"has_more":false}`, "/v1/models",
			[]ModelInfo{{ID: "claude-x", Name: "Claude X", ContextWindow: 200000, MaxOutput: 64000}}},
		{KindGemini, `{"models":[{"name":"models/gemini-3-flash","displayName":"Gemini 3 Flash","inputTokenLimit":1048576,"outputTokenLimit":65536,"supportedGenerationMethods":["generateContent"]},{"name":"models/embed","supportedGenerationMethods":["embedContent"]}]}`, "/v1beta/models",
			[]ModelInfo{{ID: "gemini-3-flash", Name: "Gemini 3 Flash", ContextWindow: 1048576, MaxOutput: 65536}}},
	}
	for _, c := range cases {
		srv, got := fakeServer(t, jsonError(http.StatusOK, c.body))
		ms, err := ListModels(context.Background(), Config{Kind: c.kind, BaseURL: srv.URL, APIKey: "k"})
		if err != nil {
			t.Fatalf("%s：%v", c.kind, err)
		}
		eq(t, ms, c.want, string(c.kind)+" 模型列表")
		eq(t, got.Path, c.path, string(c.kind)+" 路径")
	}
	srv, _ := fakeServer(t, jsonError(401, `{"error":{"message":"bad key"}}`))
	if _, err := ListModels(context.Background(), Config{Kind: KindOpenAI, BaseURL: srv.URL}); AsError(err).Kind != ErrAuth {
		t.Errorf("401 应归为 auth：%v", err)
	}
	if _, err := ListModels(context.Background(), Config{Kind: KindOpenAI, BaseURL: "http://127.0.0.1:1"}); AsError(err).Kind != ErrNetwork {
		t.Errorf("连不上应归为 network：%v", err)
	}
}

// TestLiveProviders 用真实供应商做冒烟：设置了 LODE_TEST_<家>_KEY 的才跑，没设置的跳过。
// 可选 LODE_TEST_<家>_MODEL、LODE_TEST_<家>_BASE_URL。不打印 key。
func TestLiveProviders(t *testing.T) {
	for _, c := range []struct {
		kind  Kind
		env   string
		model string
	}{
		{KindOpenAI, "OPENAI", "gpt-5-mini"},
		{KindAnthropic, "ANTHROPIC", "claude-haiku-5-5"},
		{KindGemini, "GEMINI", "gemini-3-flash"},
	} {
		t.Run(string(c.kind), func(t *testing.T) {
			key := os.Getenv("LODE_TEST_" + c.env + "_KEY")
			if key == "" {
				t.Skipf("未设置 LODE_TEST_%s_KEY，跳过真实 %s 冒烟", c.env, c.kind)
			}
			model := c.model
			if m := os.Getenv("LODE_TEST_" + c.env + "_MODEL"); m != "" {
				model = m
			}
			cfg := Config{Kind: c.kind, APIKey: key, BaseURL: os.Getenv("LODE_TEST_" + c.env + "_BASE_URL")}
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			if _, err := ListModels(ctx, cfg); err != nil {
				t.Fatalf("模型列表：%v", err)
			}
			req := Request{Model: model, MaxTokens: 2048, Tools: sampleTools, Messages: []Message{{Role: RoleUser, Parts: []Part{
				{Type: PartText, Text: "用 search_notes 工具搜索“周报”。"},
			}}}}
			res, err := Stream(ctx, cfg, req, nil)
			if err != nil {
				t.Fatalf("流式请求：%v", err)
			}
			if len(res.Message.Calls()) == 0 || res.Message.Calls()[0].Name != "search_notes" {
				t.Fatalf("期望调用 search_notes，得到 %+v", res.Message)
			}
			// 把工具结果送回，拿到最终回答
			req.Messages = append(req.Messages, res.Message, Message{Role: RoleUser, Parts: []Part{{Type: PartToolResult, Result: &ToolResult{
				CallID: res.Message.Calls()[0].ID, Name: "search_notes", Content: `[{"path":"周报/第 45 周.md","title":"第 45 周周报"}]`,
			}}}})
			res, err = Stream(ctx, cfg, req, nil)
			if err != nil {
				t.Fatalf("第二轮：%v", err)
			}
			if !strings.Contains(res.Message.Text(), "45") {
				t.Errorf("回答里应提到搜索结果：%q", res.Message.Text())
			}
			t.Logf("%s %s：输入 %d，输出 %d token", c.kind, model, res.Usage.Input, res.Usage.Output)
		})
	}
}
