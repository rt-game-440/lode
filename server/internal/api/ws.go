package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// wsMessage 是心跳和握手消息；变更事件直接发送 notes.Change（type 为 upsert|move|delete）。
type wsMessage struct {
	Type string `json:"type"` // hello | ping
	Seq  int64  `json:"seq"`  // 当前最新的变更序号，客户端发现自己落后时用 /api/changes 补齐
}

// ws 是 GET /api/ws（及 /api/w/{ws}/ws）：推送当前工作空间的变更事件（不含正文），并定期发送心跳。
// 订阅通道满时事件会被丢弃，客户端靠心跳里的 seq 发现缺口后用增量接口补齐。
func (s *Server) ws(w http.ResponseWriter, r *http.Request) {
	// Accept 默认要求 Origin 与 Host 一致，拒绝跨站页面借用会话 cookie 建立连接
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	svc := wsNotes(r)
	events, unsubscribe := svc.Subscribe(256)
	defer unsubscribe()
	ctx := conn.CloseRead(r.Context()) // 不接收客户端消息；对方关闭时 ctx 结束

	send := func(v any) bool {
		b, err := json.Marshal(v)
		if err != nil {
			return false
		}
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return conn.Write(wctx, websocket.MessageText, b) == nil
	}
	heartbeat := func(typ string) bool {
		seq, err := svc.LatestSeq(ctx)
		return err == nil && send(wsMessage{Type: typ, Seq: seq})
	}
	if !heartbeat("hello") {
		return
	}
	gone := currentWorkspace(r).Gone()
	ticker := time.NewTicker(s.WSPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-gone:
			conn.Close(websocket.StatusGoingAway, "工作空间已删除")
			return
		case <-s.done:
			conn.Close(websocket.StatusGoingAway, "服务器正在关闭")
			return
		case c, ok := <-events:
			if !ok || !send(c) {
				return
			}
		case <-ticker.C:
			if !heartbeat("ping") {
				return
			}
		}
	}
}

// Close 通知长连接（WebSocket）退出。http.Server.Shutdown 不会关闭已升级的连接，
// 用 httpServer.RegisterOnShutdown(s.Close) 注册。
func (s *Server) Close() {
	s.closeOnce.Do(func() { close(s.done) })
}
