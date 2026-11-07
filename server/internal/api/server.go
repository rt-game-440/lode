// Package api 是 REST /api/* 的 HTTP 薄封装，业务逻辑都在 notes 与 auth 包中。
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/notes"
)

// SessionCookie 是会话 cookie 名。
const SessionCookie = "lode_session"

// Server 汇总 HTTP 层依赖。
type Server struct {
	Notes   *notes.Service
	Auth    *auth.Auth
	Version string
	Web     http.Handler // 内嵌前端；为 nil 时只提供 API
	Log     *slog.Logger

	// MaxUploadBytes 是附件大小上限，默认 20MB。
	MaxUploadBytes int64
}

// Handler 构建完整的 HTTP 处理链。
func (s *Server) Handler() http.Handler {
	if s.Log == nil {
		s.Log = slog.Default()
	}
	if s.MaxUploadBytes == 0 {
		s.MaxUploadBytes = 20 << 20
	}
	mux := http.NewServeMux()

	// 公开接口
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/auth/status", s.authStatus)
	mux.HandleFunc("POST /api/auth/setup", s.authSetup)
	mux.HandleFunc("POST /api/auth/login", s.authLogin)
	mux.HandleFunc("POST /api/auth/logout", s.authLogout)

	// 需要会话的接口
	p := http.NewServeMux()
	p.HandleFunc("GET /api/tree", s.tree)
	p.HandleFunc("GET /api/notes", s.listNotes)
	p.HandleFunc("POST /api/notes", s.createNote)
	p.HandleFunc("GET /api/notes/by-path", s.readNoteByPath)
	p.HandleFunc("GET /api/notes/{id}", s.readNote)
	p.HandleFunc("PUT /api/notes/{id}", s.updateNote)
	p.HandleFunc("PATCH /api/notes/{id}", s.patchNote)
	p.HandleFunc("DELETE /api/notes/{id}", s.deleteNote)
	p.HandleFunc("POST /api/notes/{id}/move", s.moveNote)
	p.HandleFunc("GET /api/notes/{id}/backlinks", s.backlinks)
	p.HandleFunc("GET /api/notes/{id}/tags", s.noteTags)
	p.HandleFunc("GET /api/search", s.search)
	p.HandleFunc("GET /api/tags", s.tags)
	p.HandleFunc("GET /api/tags/notes", s.notesByTag)
	p.HandleFunc("POST /api/folders", s.createFolder)
	p.HandleFunc("POST /api/folders/move", s.moveFolder)
	p.HandleFunc("DELETE /api/folders", s.deleteFolder)
	p.HandleFunc("GET /api/trash", s.listTrash)
	p.HandleFunc("DELETE /api/trash", s.emptyTrash)
	p.HandleFunc("POST /api/trash/{id}/restore", s.restoreTrash)
	p.HandleFunc("DELETE /api/trash/{id}", s.purgeTrash)
	p.HandleFunc("POST /api/attachments", s.uploadAttachment)
	p.HandleFunc("GET /api/files/{path...}", s.serveFile)
	p.HandleFunc("GET /api/changes", s.changes)
	mux.Handle("/api/", s.requireSession(p))

	if s.Web != nil {
		mux.Handle("/", s.Web)
	}
	return s.recoverer(s.securityHeaders(s.csrf(s.withActor(mux))))
}

// ---- 中间件 ----

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				s.Log.Error("请求处理崩溃", "path", r.URL.Path, "panic", v)
				writeError(w, http.StatusInternalServerError, "internal", "服务器内部错误", nil)
			}
		}()
		start := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			s.Log.Debug("请求", "method", r.Method, "path", r.URL.Path, "dur", time.Since(start))
		}
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// csrf 拒绝跨站的写请求：Origin 与 Host 不一致，或浏览器标记为 cross-site。
func (s *Server) csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if site := r.Header.Get("Sec-Fetch-Site"); site == "cross-site" {
				writeError(w, http.StatusForbidden, "forbidden", "拒绝跨站请求", nil)
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || !strings.EqualFold(u.Host, r.Host) {
					writeError(w, http.StatusForbidden, "forbidden", "拒绝跨站请求", nil)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// withActor 从请求头读取设备标识（X-Device-Id、X-Device-Name，后者为 URL 编码）。
func (s *Server) withActor(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := truncate(r.Header.Get("X-Device-Id"), 64)
		name := r.Header.Get("X-Device-Name")
		if dec, err := url.PathUnescape(name); err == nil {
			name = dec
		}
		name = truncate(name, 64)
		if id != "" || name != "" {
			r = r.WithContext(notes.WithActor(r.Context(), notes.Actor{DeviceID: id, DeviceName: name}))
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok, err := s.sessionValid(r)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) sessionValid(r *http.Request) (bool, error) {
	c, err := r.Cookie(SessionCookie)
	if err != nil {
		return false, nil
	}
	return s.Auth.ValidateSession(r.Context(), c.Value)
}

// ---- 响应工具 ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

// writeError 输出统一的错误格式：{"code": "...", "message": "...", ...extra}。
func writeError(w http.ResponseWriter, status int, code, msg string, extra map[string]any) {
	body := map[string]any{"code": code, "message": msg}
	for k, v := range extra {
		body[k] = v
	}
	writeJSON(w, status, body)
}

// fail 把业务错误映射为 HTTP 状态码。
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var ce *notes.ConflictError
	var pe *notes.PatchError
	switch {
	case errors.As(err, &ce):
		writeError(w, http.StatusConflict, "conflict", ce.Error(), map[string]any{"current_rev": ce.CurrentRev})
	case errors.As(err, &pe):
		writeError(w, http.StatusUnprocessableEntity, "patch_failed", pe.Error(), map[string]any{"index": pe.Index, "matches": pe.Matches})
	case errors.Is(err, notes.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", err.Error(), nil)
	case errors.Is(err, notes.ErrExists):
		writeError(w, http.StatusConflict, "exists", err.Error(), nil)
	case errors.Is(err, notes.ErrInvalidPath):
		writeError(w, http.StatusBadRequest, "invalid_path", err.Error(), nil)
	case errors.Is(err, notes.ErrInvalid), errors.Is(err, errBadRequest):
		writeError(w, http.StatusBadRequest, "bad_request", err.Error(), nil)
	case errors.Is(err, context.Canceled):
		// 客户端已断开
	default:
		s.Log.Error("请求失败", "method", r.Method, "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "服务器内部错误", nil)
	}
}

var errBadRequest = errors.New("bad request")

// decode 解析 JSON 请求体，限制大小。
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		return errors.Join(errBadRequest, err)
	}
	return nil
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
