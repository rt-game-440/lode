package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// post 发送 JSON 请求；非 2xx 时读出响应体并转成 *Error。
func post(ctx context.Context, cfg Config, url string, header http.Header, body any) (*http.Response, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, &Error{Kind: ErrBadRequest, Detail: err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, &Error{Kind: ErrNetwork, Detail: err.Error()}
	}
	req.Header = header.Clone()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	return send(cfg, req)
}

// get 发送 GET 请求并把 2xx 响应解码到 out。
func get(ctx context.Context, cfg Config, url string, header http.Header, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return &Error{Kind: ErrNetwork, Detail: err.Error()}
	}
	req.Header = header.Clone()
	resp, err := send(cfg, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(out); err != nil {
		return &Error{Kind: ErrServer, Status: resp.StatusCode, Detail: "响应不是合法的 JSON"}
	}
	return nil
}

func send(cfg Config, req *http.Request) (*http.Response, error) {
	resp, err := cfg.client().Do(req)
	if err != nil {
		return nil, &Error{Kind: ErrNetwork, Detail: networkDetail(err)}
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return nil, httpError(resp.StatusCode, body)
	}
	return resp, nil
}

// networkDetail 只保留网络错误的最后一段说明，不带完整 URL（URL 里可能有查询参数）。
func networkDetail(err error) string {
	s := err.Error()
	if i := strings.LastIndex(s, ": "); i >= 0 {
		s = s[i+2:]
	}
	return s
}

// httpError 按状态码和错误体归类。三家的错误体都形如 {"error": {"message": ...}}。
func httpError(status int, body []byte) *Error {
	detail := errorMessage(body)
	lower := strings.ToLower(detail + " " + string(body))
	kind := ErrBadRequest
	switch {
	case status == 401 || status == 403 || strings.Contains(lower, "api_key_invalid") || strings.Contains(lower, "api key not valid"):
		kind = ErrAuth
	case status == 429:
		kind = ErrRateLimit
	case isContextError(lower):
		kind = ErrContextLength
	case status == 404:
		kind = ErrModelNotFound
	case status >= 500:
		kind = ErrServer
	case status == 400 && (strings.Contains(lower, "model_not_found") || strings.Contains(lower, "does not exist")):
		kind = ErrModelNotFound
	}
	return &Error{Kind: kind, Status: status, Detail: detail}
}

func isContextError(lower string) bool {
	for _, s := range []string{"context_length_exceeded", "context length", "context window", "maximum context", "prompt is too long", "input token count", "too many tokens"} {
		if strings.Contains(lower, s) {
			return true
		}
	}
	return false
}

func errorMessage(body []byte) string {
	var v struct {
		Error json.RawMessage `json:"error"`
		Msg   string          `json:"message"`
	}
	msg := ""
	if json.Unmarshal(body, &v) == nil {
		var inner struct {
			Message string `json:"message"`
		}
		var s string
		switch {
		case json.Unmarshal(v.Error, &inner) == nil && inner.Message != "":
			msg = inner.Message
		case json.Unmarshal(v.Error, &s) == nil:
			msg = s
		default:
			msg = v.Msg
		}
	}
	if msg == "" {
		msg = strings.TrimSpace(string(body))
	}
	return truncate(msg, 300)
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// readSSE 逐个读取 SSE 事件，调用 fn(event, data)。fn 返回 errStop 时提前结束。
func readSSE(r io.Reader, fn func(event, data string) error) error {
	br := bufio.NewReaderSize(r, 64<<10)
	var event string
	var data strings.Builder
	flush := func() error {
		if data.Len() == 0 {
			event = ""
			return nil
		}
		d := strings.TrimSuffix(data.String(), "\n")
		err := fn(event, d)
		event = ""
		data.Reset()
		return err
	}
	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 || err == nil {
			line = strings.TrimRight(line, "\r\n")
			switch {
			case line == "":
				if ferr := flush(); ferr != nil {
					return ferr
				}
			case strings.HasPrefix(line, ":"):
			default:
				field, value, _ := strings.Cut(line, ":")
				value = strings.TrimPrefix(value, " ")
				switch field {
				case "event":
					event = value
				case "data":
					data.WriteString(value)
					data.WriteByte('\n')
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return flush()
			}
			return &Error{Kind: ErrNetwork, Detail: "读取响应流时连接中断：" + networkDetail(err)}
		}
	}
}

// errStop 让 readSSE 提前结束（例如收到 [DONE]）。
var errStop = errors.New("stop")
