package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/rt-game-440/lode/server/internal/auth"
)

// ---- API token 与 MCP 调用记录（需要会话） ----

func (s *Server) listTokens(w http.ResponseWriter, r *http.Request) {
	list, err := s.Auth.ListTokens(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": list})
}

type createTokenReq struct {
	Name  string `json:"name"`
	Scope string `json:"scope"` // read | write
}

// createToken 创建 token；明文只在这次响应里出现。
func (s *Server) createToken(w http.ResponseWriter, r *http.Request) {
	var req createTokenReq
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	t, secret, err := s.Auth.CreateToken(r.Context(), req.Name, req.Scope)
	if errors.Is(err, auth.ErrInvalidTokenInput) {
		writeError(w, http.StatusBadRequest, "bad_request", "名称不能为空且不超过 64 个字符，权限只能是 read 或 write", nil)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": t, "secret": secret})
}

func (s *Server) revokeToken(w http.ResponseWriter, r *http.Request) {
	err := s.Auth.RevokeToken(r.Context(), r.PathValue("id"))
	if errors.Is(err, auth.ErrTokenNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "token 不存在", nil)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// listAudit 返回最近的 MCP 调用记录，limit 默认 100，超过 1000 按 1000 处理。
func (s *Server) listAudit(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if q := r.URL.Query().Get("limit"); q != "" {
		n, err := strconv.Atoi(q)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "bad_request", "limit 必须是正整数", nil)
			return
		}
		limit = min(n, 1000)
	}
	entries, err := s.Audit.List(r.Context(), limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}
