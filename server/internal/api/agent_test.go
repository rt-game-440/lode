package api

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rt-game-440/lode/server/internal/agent"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/secret"
	"github.com/rt-game-440/lode/server/internal/tools"
)

// lockedBuffer 收集日志输出，供检查日志里有没有明文 key。
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// withAgent 给测试服务器挂上助手：数据单独放在一个已迁移的库里，日志写进 logs。
func withAgent(t *testing.T, master string, logs *lockedBuffer) (func(*Server), *sql.DB) {
	t.Helper()
	adb, err := db.Open(context.Background(), filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { adb.Close() })
	return func(s *Server) {
		log := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
		s.Log = log
		s.Agent = &agent.Service{Store: agent.NewStore(adb, secret.New(master)), Tools: tools.New(s.Notes), Notes: s.Notes, Log: log}
		t.Cleanup(s.Agent.Close)
	}, adb
}

// fakeOpenAI 是一个 OpenAI 兼容服务：key 正确时返回模型列表和一段流式回复；
// key 错误时返回 401，并像真实服务那样在错误说明里带出收到的 key。
func fakeOpenAI(t *testing.T, key string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if got != key {
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprintf(w, `{"error":{"message":"Incorrect API key provided: %s","code":"invalid_api_key"}}`, got)
			return
		}
		switch r.URL.Path {
		case "/v1/models":
			io.WriteString(w, `{"object":"list","data":[{"id":"fake-model","object":"model"}]}`)
		case "/v1/chat/completions":
			w.Header().Set("Content-Type", "text/event-stream")
			for _, d := range []string{
				`{"choices":[{"index":0,"delta":{"role":"assistant","content":"你好，"}}]}`,
				`{"choices":[{"index":0,"delta":{"content":"我是助手。"},"finish_reason":"stop"}]}`,
				`{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}`,
			} {
				fmt.Fprintf(w, "data: %s\n\n", d)
			}
			io.WriteString(w, "data: [DONE]\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// raw 发请求并返回原始响应体，用于检查响应里有没有明文 key。
func (c *client) raw(method, path string, body any) (int, string) {
	c.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, r)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// sseReader 读取助手事件流。
type sseReader struct {
	t    *testing.T
	body io.Closer
	sc   *bufio.Scanner
}

func (c *client) stream(chatID string) *sseReader {
	c.t.Helper()
	req, _ := http.NewRequest("GET", c.base+"/api/agent/chats/"+chatID+"/stream", nil)
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		c.t.Fatalf("事件流 = %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	c.t.Cleanup(func() { resp.Body.Close() })
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	return &sseReader{t: c.t, body: resp.Body, sc: sc}
}

// next 返回下一个事件（跳过注释和 retry 行）。
func (s *sseReader) next() agent.Event {
	s.t.Helper()
	done := make(chan agent.Event, 1)
	go func() {
		for s.sc.Scan() {
			line := s.sc.Text()
			if data, ok := strings.CutPrefix(line, "data: "); ok {
				var ev agent.Event
				if err := json.Unmarshal([]byte(data), &ev); err != nil {
					s.t.Errorf("事件不是 JSON：%s", data)
				}
				done <- ev
				return
			}
		}
		close(done)
	}()
	select {
	case ev, ok := <-done:
		if !ok {
			s.t.Fatal("事件流提前结束")
		}
		return ev
	case <-time.After(5 * time.Second):
		s.t.Fatal("等待事件超时")
	}
	return agent.Event{}
}

// until 读到指定类型的事件为止，返回途经的事件类型。
func (s *sseReader) until(typ string) []string {
	s.t.Helper()
	var seen []string
	for {
		ev := s.next()
		seen = append(seen, ev.Type)
		if ev.Type == typ {
			return seen
		}
	}
}

func TestAgentAPIKeyNeverInPlaintext(t *testing.T) {
	const key = "sk-test-PLAINTEXT-a1b2c3d4"
	const wrongKey = "sk-wrong-SECRET-e5f6g7h8"
	logs := &lockedBuffer{}
	opt, adb := withAgent(t, "test-master-key", logs)
	c := newServer(t, opt)
	c.setup()
	llmSrv := fakeOpenAI(t, key)
	var bodies []string
	check := func(what string, st int, body string, want int) {
		t.Helper()
		bodies = append(bodies, body)
		if st != want {
			t.Fatalf("%s = %d %s", what, st, body)
		}
	}

	st, body := c.raw("POST", "/api/agent/providers", map[string]any{"name": "本地", "kind": "openai", "base_url": llmSrv.URL + "/v1", "api_key": key})
	check("新建供应商", st, body, 201)
	var p agent.Provider
	json.Unmarshal([]byte(body), &p)
	if !p.HasKey || p.KeyLast4 != "c3d4" {
		t.Fatalf("应只返回 key 的末 4 位：%s", body)
	}

	// 数据库里是密文
	var enc string
	if err := adb.QueryRow(`SELECT key_enc FROM llm_providers WHERE id = ?`, p.ID).Scan(&enc); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(enc, "v1:") || strings.Contains(enc, key) || strings.Contains(enc, "PLAINTEXT") {
		t.Fatalf("数据库里的 key 应是密文：%q", enc)
	}

	st, body = c.raw("POST", "/api/agent/providers/"+p.ID+"/test", nil)
	check("测试连接", st, body, 200)
	if !strings.Contains(body, `"ok":true`) || !strings.Contains(body, "fake-model") {
		t.Fatalf("测试连接应成功并列出模型：%s", body)
	}

	st, body = c.raw("POST", "/api/agent/providers/"+p.ID+"/models", map[string]any{"model": "fake-model", "context_window": 32000, "max_output": 4096})
	check("新建模型", st, body, 201)
	st, body = c.raw("GET", "/api/agent/config", nil)
	check("读取配置", st, body, 200)
	if !strings.Contains(body, `"secret_key_set":true`) || !strings.Contains(body, `"default_model"`) {
		t.Fatalf("配置应包含主密钥状态和设置：%s", body)
	}

	// 用这个 key 真正发起一次对话：服务端能解密，事件流按顺序推送
	st, body = c.raw("POST", "/api/agent/chats", map[string]any{})
	check("新建对话", st, body, 201)
	var chat agent.Chat
	json.Unmarshal([]byte(body), &chat)
	if chat.ModelID == "" {
		t.Fatal("不指定模型时应使用默认模型")
	}
	es := c.stream(chat.ID)
	if ev := es.next(); ev.Type != "state" || ev.Running {
		t.Fatalf("第一条事件应是空闲的状态快照：%+v", ev)
	}
	st, body = c.raw("POST", "/api/agent/chats/"+chat.ID+"/messages", map[string]any{"text": "你好"})
	check("发送消息", st, body, 202)
	if got := strings.Join(es.until("done"), " "); got != "message chat text text message chat done" {
		t.Errorf("事件顺序 = %s", got)
	}
	es.until("state") // 生成结束
	st, body = c.raw("GET", "/api/agent/chats/"+chat.ID, nil)
	check("读取对话", st, body, 200)
	var view agent.ChatView
	json.Unmarshal([]byte(body), &view)
	if len(view.Messages) != 2 || view.Messages[1].Parts[0].Text != "你好，我是助手。" || view.Running || view.Chat.Title != "你好" {
		t.Fatalf("对话内容不对：%s", body)
	}
	if view.Chat.InputTokens != 12 || view.Chat.OutputTokens != 5 {
		t.Errorf("用量应累计：%+v", view.Chat)
	}

	// 换成错误的 key：供应商在错误说明里带出 key，接口返回前要去掉
	st, body = c.raw("PUT", "/api/agent/providers/"+p.ID, map[string]any{"name": "本地", "kind": "openai", "base_url": llmSrv.URL + "/v1", "api_key": wrongKey})
	check("修改 key", st, body, 200)
	st, body = c.raw("POST", "/api/agent/providers/"+p.ID+"/test", nil)
	check("错误 key 测试连接", st, body, 200)
	if !strings.Contains(body, `"ok":false`) || !strings.Contains(body, `"kind":"auth"`) {
		t.Fatalf("错误 key 应报鉴权失败：%s", body)
	}
	st, body = c.raw("POST", "/api/agent/chats/"+chat.ID+"/messages", map[string]any{"text": "再来"})
	check("错误 key 发送", st, body, 202)
	if got := es.until("error"); got[len(got)-1] != "error" {
		t.Fatal("应推送 error 事件")
	}
	es.until("state")
	st, body = c.raw("GET", "/api/agent/chats/"+chat.ID, nil)
	check("读取出错的对话", st, body, 200)
	if !strings.Contains(body, "鉴权失败") {
		t.Errorf("出错说明应保存在消息里：%s", body)
	}

	// 不修改 key 时 api_key 省略；清除 key 用空字符串
	st, body = c.raw("PUT", "/api/agent/providers/"+p.ID, map[string]any{"name": "改名", "kind": "openai", "base_url": llmSrv.URL + "/v1"})
	check("只改名", st, body, 200)
	if !strings.Contains(body, `"has_key":true`) {
		t.Fatalf("省略 api_key 时应保留原 key：%s", body)
	}

	for _, secretText := range []string{key, wrongKey, "PLAINTEXT", "SECRET-e5f6"} {
		for _, b := range bodies {
			if strings.Contains(b, secretText) {
				t.Errorf("接口响应里出现了明文 key（%s）：%s", secretText, b)
			}
		}
		if strings.Contains(logs.String(), secretText) {
			t.Errorf("日志里出现了明文 key（%s）", secretText)
		}
	}
	if !strings.Contains(logs.String(), "/api/agent/providers") {
		t.Error("应确实捕获到了请求日志")
	}
}

func TestAgentAPIWithoutSecretKey(t *testing.T) {
	opt, _ := withAgent(t, "", &lockedBuffer{})
	c := newServer(t, opt)
	c.setup()
	if st, body := c.do("GET", "/api/agent/config", nil); st != 200 || body["secret_key_set"] != false {
		t.Fatalf("config = %d %v", st, body)
	}
	st, body := c.do("POST", "/api/agent/providers", map[string]any{"name": "x", "kind": "openai", "api_key": "sk-123"})
	if st != 400 || !strings.Contains(fmt.Sprint(body["message"]), "LODE_SECRET_KEY") {
		t.Fatalf("没有主密钥时保存 key 应 400 并说明原因：%d %v", st, body)
	}
	// 不带 key 的供应商（例如本地模型）可以保存
	if st, body := c.do("POST", "/api/agent/providers", map[string]any{"name": "ollama", "kind": "openai", "base_url": "http://127.0.0.1:11434/v1"}); st != 201 {
		t.Fatalf("不带 key 应能保存：%d %v", st, body)
	}
}

func TestAgentAPIErrors(t *testing.T) {
	opt, _ := withAgent(t, "m", &lockedBuffer{})
	c := newServer(t, opt)
	if st, _ := c.do("GET", "/api/agent/config", nil); st != 401 {
		t.Fatalf("未登录应 401，得到 %d", st)
	}
	c.setup()
	cases := []struct {
		method, path string
		body         any
		want         int
	}{
		{"GET", "/api/agent/chats/nope", nil, 404},
		{"GET", "/api/agent/chats/nope/stream", nil, 404},
		{"POST", "/api/agent/chats", map[string]any{"model_id": "nope"}, 404},
		{"POST", "/api/agent/providers", map[string]any{"name": "x", "kind": "bard"}, 400},
		{"POST", "/api/agent/providers/nope/models", map[string]any{"model": "m", "context_window": 8000, "max_output": 100}, 404},
		{"PUT", "/api/agent/models/nope", map[string]any{"model": "m", "context_window": 8000, "max_output": 100}, 404},
		{"PUT", "/api/agent/settings", map[string]any{"default_model": "nope"}, 400},
	}
	for _, tc := range cases {
		if st, body := c.do(tc.method, tc.path, tc.body); st != tc.want {
			t.Errorf("%s %s = %d %v，期望 %d", tc.method, tc.path, st, body, tc.want)
		}
	}
	// 没有模型时也能建对话，发送时报清楚的错误
	st, body := c.do("POST", "/api/agent/chats", map[string]any{})
	if st != 201 {
		t.Fatalf("新建对话 = %d %v", st, body)
	}
	if st, body := c.do("POST", "/api/agent/chats/"+body["id"].(string)+"/messages", map[string]any{"text": "hi"}); st != 400 {
		t.Errorf("没有模型时发送应 400：%d %v", st, body)
	}
}
