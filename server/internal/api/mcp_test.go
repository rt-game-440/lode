package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestTokenEndpointsAndMCPMount(t *testing.T) {
	c := newServer(t)
	if st, _ := c.do("GET", "/api/tokens", nil); st != 401 {
		t.Fatalf("token 管理需要登录，得到 %d", st)
	}
	c.setup()

	st, body := c.do("POST", "/api/tokens", map[string]string{"name": "Claude Code", "scope": "write"})
	if st != 201 {
		t.Fatalf("创建 token = %d %v", st, body)
	}
	secret, _ := body["secret"].(string)
	tok, _ := body["token"].(map[string]any)
	if !strings.HasPrefix(secret, "lode_") || tok["name"] != "Claude Code" || tok["scope"] != "write" {
		t.Fatalf("创建结果：%v", body)
	}
	if st, body := c.do("POST", "/api/tokens", map[string]string{"name": "", "scope": "write"}); st != 400 {
		t.Fatalf("空名称应 400：%d %v", st, body)
	}

	st, body = c.do("GET", "/api/tokens", nil)
	list, _ := body["tokens"].([]any)
	if st != 200 || len(list) != 1 || strings.Contains(mustJSON(body), secret) {
		t.Fatalf("列表不应包含明文：%d %v", st, body)
	}

	// /mcp 只认 Bearer token，跨站检查不适用（浏览器里的 MCP Inspector 会带 Origin）
	mcpCall := func(token string) int {
		req, _ := http.NewRequest("POST", c.base+"/mcp", strings.NewReader(
			`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_notes","arguments":{}}}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Origin", "http://localhost:6274")
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if st := mcpCall(secret); st != 200 {
		t.Fatalf("有效 token 调用 /mcp 应 200，得到 %d", st)
	}

	st, body = c.do("GET", "/api/audit?limit=10", nil)
	entries, _ := body["entries"].([]any)
	if st != 200 || len(entries) != 1 || entries[0].(map[string]any)["tool"] != "list_notes" || entries[0].(map[string]any)["token_name"] != "Claude Code" {
		t.Fatalf("审计日志：%d %v", st, body)
	}

	if st, _ := c.do("DELETE", "/api/tokens/"+tok["id"].(string), nil); st != 204 {
		t.Fatalf("吊销 = %d", st)
	}
	if st := mcpCall(secret); st != 401 {
		t.Fatalf("吊销后调用 /mcp 应 401，得到 %d", st)
	}
	if st, _ := c.do("DELETE", "/api/tokens/"+tok["id"].(string), nil); st != 404 {
		t.Fatalf("重复吊销应 404，得到 %d", st)
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
