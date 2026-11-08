package api

import (
	"errors"
	"net/http"

	"github.com/rt-game-440/lode/server/internal/keyprotect"
	"github.com/rt-game-440/lode/server/internal/passkey"
)

// ---- 用通行密钥保护 API key（#29）。都需要会话；开启、解锁、加入保护要先做一次指定凭据的通行密钥验证 ----

func (s *Server) routeKeyProtect(p *http.ServeMux) {
	p.HandleFunc("GET /api/key-protection", s.keyProtectStatus)
	p.HandleFunc("POST /api/key-protection/begin", s.keyProtectBegin)
	p.HandleFunc("POST /api/key-protection/finish", s.keyProtectFinish)
	p.HandleFunc("POST /api/key-protection/lock", s.keyProtectLock)
	p.HandleFunc("POST /api/key-protection/disable", s.keyProtectDisable)
}

// keyProtectFail 把保护相关的错误映射为 HTTP 状态码，其余交给 fail。
func (s *Server) keyProtectFail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, keyprotect.ErrUnavailable):
		writeError(w, http.StatusConflict, "env_secret_key", err.Error(), nil)
	case errors.Is(err, keyprotect.ErrEnabled):
		writeError(w, http.StatusConflict, "already_enabled", err.Error(), nil)
	case errors.Is(err, keyprotect.ErrDisabled):
		writeError(w, http.StatusConflict, "not_enabled", err.Error(), nil)
	case errors.Is(err, keyprotect.ErrNoPRF):
		writeError(w, http.StatusBadRequest, "prf_unsupported", err.Error(), nil)
	case errors.Is(err, keyprotect.ErrNotEnrolled):
		writeError(w, http.StatusConflict, "not_enrolled", err.Error(), nil)
	case errors.Is(err, keyprotect.ErrUnwrap):
		writeError(w, http.StatusBadRequest, "unwrap_failed", err.Error(), nil)
	case errors.Is(err, keyprotect.ErrLocked):
		writeError(w, http.StatusConflict, "keys_locked", err.Error(), nil)
	case errors.Is(err, passkey.ErrNoCeremony):
		writeError(w, http.StatusBadRequest, "ceremony_expired", "验证已过期，请重试", nil)
	case errors.Is(err, passkey.ErrVerify):
		writeError(w, http.StatusBadRequest, "passkey_failed", "通行密钥验证失败", nil)
	case errors.Is(err, passkey.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "当前域名下没有可用的通行密钥", nil)
	default:
		s.fail(w, r, err)
	}
}

func (s *Server) writeKeyProtectStatus(w http.ResponseWriter, r *http.Request, status int, extra map[string]any) {
	st, err := s.KeyProtect.Status(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	body := map[string]any{"key_protection": st}
	for k, v := range extra {
		body[k] = v
	}
	writeJSON(w, status, body)
}

func (s *Server) keyProtectStatus(w http.ResponseWriter, r *http.Request) {
	s.writeKeyProtectStatus(w, r, http.StatusOK, nil)
}

// keyProtectBegin 开始一次带 PRF 的通行密钥验证。action：
//   - enable：开启保护，可以用当前域名下任意一个通行密钥（passkey 给出时只用它）；
//   - unlock：解锁，只列出加入了保护的通行密钥；
//   - enroll：把 passkey 这个通行密钥加入保护（需要已解锁）。
func (s *Server) keyProtectBegin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action  string `json:"action"`
		Passkey string `json:"passkey"`
	}
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	rp, ok := s.passkeyRPOrFail(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	st, err := s.KeyProtect.Status(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var ids []string
	switch req.Action {
	case "enable":
		switch {
		case !st.Available:
			err = keyprotect.ErrUnavailable
		case st.Enabled:
			err = keyprotect.ErrEnabled
		case req.Passkey != "":
			ids = []string{req.Passkey}
		default:
			ids, err = s.Passkeys.IDs(ctx, rp.ID)
		}
	case "unlock":
		if !st.Enabled {
			err = keyprotect.ErrDisabled
		} else if ids, err = s.Passkeys.Wrapped(ctx, rp.ID); err == nil && len(ids) == 0 {
			writeError(w, http.StatusConflict, "not_enrolled", "当前域名下没有加入保护的通行密钥，换一个域名访问或关闭保护", nil)
			return
		}
	case "enroll":
		switch {
		case !st.Enabled:
			err = keyprotect.ErrDisabled
		case !st.Unlocked:
			err = keyprotect.ErrLocked
		case req.Passkey == "":
			err = errBadRequest
		default:
			ids = []string{req.Passkey}
		}
	default:
		err = errBadRequest
	}
	if err != nil {
		s.keyProtectFail(w, r, err)
		return
	}
	id, opts, err := s.Passkeys.BeginAssert(ctx, rp, ids, s.KeyProtect.Salt(), req.Action)
	if err != nil {
		s.keyProtectFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, ceremonyResp{Ceremony: id, Options: opts})
}

// keyProtectFinish 校验验证结果并按 begin 时的 action 开启、解锁或加入保护。PRF 输出用完即清零。
func (s *Server) keyProtectFinish(w http.ResponseWriter, r *http.Request) {
	limitCredentialBody(w, r)
	ctx := r.Context()
	res, err := s.Passkeys.FinishAssert(ctx, r.URL.Query().Get("ceremony"), r)
	if err != nil {
		s.keyProtectFail(w, r, err)
		return
	}
	defer clear(res.PRF)
	switch res.Tag {
	case "enable":
		err = s.KeyProtect.Enable(ctx, res.ID, res.PRF)
	case "unlock":
		err = s.KeyProtect.Unlock(ctx, res.ID, res.PRF)
	case "enroll":
		err = s.KeyProtect.Enroll(ctx, res.ID, res.PRF)
	default:
		err = errBadRequest
	}
	if err != nil {
		s.keyProtectFail(w, r, err)
		return
	}
	s.writeKeyProtectStatus(w, r, http.StatusOK, nil)
}

func (s *Server) keyProtectLock(w http.ResponseWriter, r *http.Request) {
	if err := s.KeyProtect.Lock(); err != nil {
		s.keyProtectFail(w, r, err)
		return
	}
	s.writeKeyProtectStatus(w, r, http.StatusOK, nil)
}

// keyProtectDisable 关闭保护。锁定时必须带 discard: true（放弃已保存的 API key），否则返回 keys_locked。
func (s *Server) keyProtectDisable(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Discard bool `json:"discard"`
	}
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	n, err := s.KeyProtect.Disable(r.Context(), req.Discard)
	if err != nil {
		s.keyProtectFail(w, r, err)
		return
	}
	s.writeKeyProtectStatus(w, r, http.StatusOK, map[string]any{"cleared_keys": n})
}
