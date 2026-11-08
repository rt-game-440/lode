package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/rt-game-440/lode/server/internal/passkey"
)

// ---- 通行密钥（WebAuthn）。登记/管理需要会话，登录是公开接口且沿用密码登录的失败限流 ----

// passkeyRP 由请求推导依赖方：主机取 Host；直连方是可信代理时优先取 X-Forwarded-Host，
// 协议取 isHTTPS（直连 TLS，或可信代理转发的 https）。
func (s *Server) passkeyRP(r *http.Request) (passkey.RP, error) {
	host := r.Host
	if a, _ := remoteAddr(r); s.trusted(a) {
		if fwd, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Host"), ","); strings.TrimSpace(fwd) != "" {
			host = strings.TrimSpace(fwd)
		}
	}
	return passkey.RPFromHost(host, s.isHTTPS(r))
}

// hasPasskey 判断当前访问的域名下是否登记过通行密钥。
func (s *Server) hasPasskey(r *http.Request) bool {
	if s.Passkeys == nil {
		return false
	}
	rp, err := s.passkeyRP(r)
	if err != nil {
		return false
	}
	ok, _ := s.Passkeys.AvailableFor(r.Context(), rp.ID)
	return ok
}

// ceremonyResp 是 begin 接口的响应：仪式 ID 加浏览器 WebAuthn API 需要的选项。
type ceremonyResp struct {
	Ceremony string `json:"ceremony"`
	Options  any    `json:"options"`
}

func (s *Server) passkeyRPOrFail(w http.ResponseWriter, r *http.Request) (passkey.RP, bool) {
	rp, err := s.passkeyRP(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "passkey_unsupported", "通行密钥需要通过域名并使用 HTTPS（或 localhost）访问，不能用 IP 地址", nil)
		return rp, false
	}
	return rp, true
}

// limited 检查登录失败限流，被锁定时写出 429 并返回 false。
func (s *Server) limited(w http.ResponseWriter, ip string) bool {
	ok, wait := s.Auth.Limiter.Allow(ip)
	if ok {
		return true
	}
	secs := int(wait.Seconds() + 0.999)
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	writeError(w, http.StatusTooManyRequests, "rate_limited", fmt.Sprintf("尝试次数过多，请 %d 秒后再试", secs), map[string]any{"retry_after": secs})
	return false
}

// 完成接口的请求体是浏览器 PublicKeyCredential 的 JSON（含公钥/签名），限制大小。
func limitCredentialBody(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
}

func (s *Server) passkeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	if !s.limited(w, s.clientIP(r)) {
		return
	}
	rp, ok := s.passkeyRPOrFail(w, r)
	if !ok {
		return
	}
	id, opts, err := s.Passkeys.BeginLogin(rp)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, ceremonyResp{Ceremony: id, Options: opts})
}

func (s *Server) passkeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if !s.limited(w, ip) {
		return
	}
	limitCredentialBody(w, r)
	_, err := s.Passkeys.FinishLogin(r.Context(), r.URL.Query().Get("ceremony"), r)
	switch {
	case errors.Is(err, passkey.ErrNoCeremony):
		writeError(w, http.StatusBadRequest, "ceremony_expired", "验证已过期，请重试", nil)
		return
	case errors.Is(err, passkey.ErrVerify):
		locked := s.Auth.Limiter.Fail(ip)
		s.Log.Warn("通行密钥登录失败", "ip", ip, "locked", locked)
		writeError(w, http.StatusUnauthorized, "passkey_failed", "通行密钥验证失败", nil)
		return
	case err != nil:
		s.fail(w, r, err)
		return
	}
	s.Auth.Limiter.Success(ip)
	s.startSession(w, r)
}

func (s *Server) listPasskeys(w http.ResponseWriter, r *http.Request) {
	list, err := s.Passkeys.List(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"passkeys": list})
}

func (s *Server) passkeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	rp, ok := s.passkeyRPOrFail(w, r)
	if !ok {
		return
	}
	id, opts, err := s.Passkeys.BeginRegistration(r.Context(), rp, req.Name)
	if errors.Is(err, passkey.ErrInvalidName) {
		writeError(w, http.StatusBadRequest, "bad_request", fmt.Sprintf("名称不能为空，且不超过 %d 个字符", passkey.MaxNameLen), nil)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, ceremonyResp{Ceremony: id, Options: opts})
}

func (s *Server) passkeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	limitCredentialBody(w, r)
	info, err := s.Passkeys.FinishRegistration(r.Context(), r.URL.Query().Get("ceremony"), r)
	switch {
	case errors.Is(err, passkey.ErrNoCeremony):
		writeError(w, http.StatusBadRequest, "ceremony_expired", "登记已过期，请重试", nil)
		return
	case errors.Is(err, passkey.ErrVerify):
		writeError(w, http.StatusBadRequest, "passkey_failed", "通行密钥登记失败，请重试", nil)
		return
	case err != nil:
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"passkey": info})
}

func (s *Server) deletePasskey(w http.ResponseWriter, r *http.Request) {
	err := s.Passkeys.Delete(r.Context(), r.PathValue("id"))
	if errors.Is(err, passkey.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "通行密钥不存在", nil)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
