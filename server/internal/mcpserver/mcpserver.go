// Package mcpserver 通过 MCP（Streamable HTTP）对外提供笔记工具，用 API token 做 Bearer 鉴权。
// 工具来自 tools 注册表；只读 token 只能看到和调用只读工具。每次调用写一条审计记录。
package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/rt-game-440/lode/server/internal/audit"
	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/tools"
)

// Options 是 MCP 服务的依赖。
type Options struct {
	Tools   *tools.Registry
	Auth    *auth.Auth
	Audit   *audit.Log
	Version string
	Log     *slog.Logger
}

// instructions 在初始化时发给客户端，帮助模型理解这个服务。
const instructions = `Lode 是用户自托管的个人 Markdown 笔记库。
路径都相对笔记库根目录、用 / 分隔，笔记以 .md 结尾。找笔记先用 search_notes 或 list_notes；
修改前先用 read_note 读取，拿到 rev 作为 update_note 的 base_rev。只改局部时优先用 update_note 的 patch 模式。
删除的笔记进回收站，可以恢复。`

// tokenKey 是 TokenInfo.Extra 里存放 auth.APIToken 的键。
const tokenKey = "lode_token"

// Handler 返回挂在 /mcp 的 HTTP 处理器。
//
// 用无状态模式（不发 Mcp-Session-Id，GET 返回 405）和 JSON 响应：工具调用都是一问一答，不需要服务器推送。
// 关闭 SDK 的本地回环防护：它会拒绝"经回环地址到达、Host 却不是 localhost"的请求，
// 而经 Caddy 等反向代理访问时正是这种情况；这里每个请求都要 Bearer token，DNS rebinding 拿不到 token。
func Handler(o Options) http.Handler {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	ro, rw := newServer(o, false), newServer(o, true)
	h := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		if t, ok := tokenFrom(sdkauth.TokenInfoFromContext(r.Context())); ok && t.CanWrite() {
			return rw
		}
		return ro
	}, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, DisableLocalhostProtection: true})

	verify := func(ctx context.Context, secret string, _ *http.Request) (*sdkauth.TokenInfo, error) {
		t, err := o.Auth.VerifyToken(ctx, secret)
		if errors.Is(err, auth.ErrInvalidToken) {
			return nil, fmt.Errorf("%w: token 无效或已吊销", sdkauth.ErrInvalidToken)
		}
		if err != nil {
			return nil, err
		}
		return &sdkauth.TokenInfo{UserID: t.ID, Scopes: []string{t.Scope}, Extra: map[string]any{tokenKey: t}}, nil
	}
	return sdkauth.RequireBearerToken(verify, &sdkauth.RequireBearerTokenOptions{AllowMissingExpiration: true})(h)
}

func tokenFrom(info *sdkauth.TokenInfo) (auth.APIToken, bool) {
	if info == nil {
		return auth.APIToken{}, false
	}
	t, ok := info.Extra[tokenKey].(auth.APIToken)
	return t, ok
}

// newServer 创建只含调用方可见工具的 MCP Server。
func newServer(o Options, canWrite bool) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "lode", Title: "Lode 笔记", Version: o.Version}, &mcp.ServerOptions{Instructions: instructions})
	closed := false
	for _, t := range o.Tools.Tools(canWrite) {
		s.AddTool(&mcp.Tool{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
			Annotations: &mcp.ToolAnnotations{ReadOnlyHint: t.ReadOnly, OpenWorldHint: &closed},
		}, handle(o, t.Name))
	}
	return s
}

// handle 调用工具并记审计日志。工具失败作为 isError 结果返回给模型（不是协议错误），模型可以据此改正后重试。
func handle(o Options, name string) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		t, ok := tokenFrom(req.Extra.TokenInfo)
		if !ok {
			return nil, errors.New("缺少 token 信息")
		}
		ctx = notes.WithActor(ctx, notes.Actor{DeviceID: "mcp:" + t.ID, DeviceName: t.Name})
		start := time.Now()
		res, err := o.Tools.Call(ctx, name, req.Params.Arguments, t.CanWrite())
		entry := audit.Entry{TokenID: t.ID, TokenName: t.Name, Tool: name, Target: res.Target, OK: err == nil,
			DurationMs: time.Since(start).Milliseconds()}
		out := &mcp.CallToolResult{}
		if err != nil {
			if errors.Is(err, tools.ErrInternal) {
				o.Log.Error("MCP 工具调用失败", "tool", name, "target", res.Target, "err", errors.Unwrap(err))
			}
			entry.Error = err.Error()
			out.SetError(err)
		} else {
			out.Content = []mcp.Content{&mcp.TextContent{Text: res.Text()}}
		}
		if err := o.Audit.Record(context.WithoutCancel(ctx), entry); err != nil {
			o.Log.Warn("写审计日志失败", "tool", name, "err", err)
		}
		return out, nil
	}
}
