package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/rt-game-440/lode/server/internal/keyprotect"
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
	res, err := s.Passkeys.FinishLogin(r.Context(), r.URL.Query().Get("ceremony"), r)
	defer clear(res.PRF)
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
	if s.KeyProtect != nil {
		// 开启了 API key 保护时，登录顺便带回 PRF 输出：用它解锁（或在已解锁时把这个通行密钥加入保护）
		s.KeyProtect.AfterLogin(r.Context(), res.ID, res.PRF)
	}
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
	ctx := r.Context()
	res, err := s.Passkeys.FinishRegistration(ctx, r.URL.Query().Get("ceremony"), r)
	defer clear(res.PRF)
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
	info := res.Info
	if s.KeyProtect != nil && res.PRF != nil {
		// 开启了保护且已解锁时，登记就给出 PRF 输出的通行密钥直接加入保护；其余情况由前端再做一次验证（action: enroll）
		if err := s.KeyProtect.Enroll(ctx, res.ID, res.PRF); err == nil {
			if fresh, err := s.Passkeys.Get(ctx, res.ID); err == nil {
				info = fresh
			}
		} else if !errors.Is(err, keyprotect.ErrLocked) && !errors.Is(err, keyprotect.ErrDisabled) {
			s.Log.Warn("把新登记的通行密钥加入 API key 保护失败", "err", err)
		}
	}
	writeJSON(w, http.StatusCreated, map[string]any{"passkey": info})
}

// deletePasskey 删除通行密钥。开启了 API key 保护且它是最后一个能解锁的通行密钥时，
// 不带 ?force=1 返回 409 last_key_passkey；带上则删除并自动关闭保护（锁定时已保存的 key 会被清除）。
func (s *Server) deletePasskey(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if s.KeyProtect != nil && r.URL.Query().Get("force") != "1" {
		last, err := s.KeyProtect.LastWrapped(ctx, id)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if last {
			writeError(w, http.StatusConflict, "last_key_passkey",
				"这是最后一个能解锁 API key 的通行密钥：删除后会关闭通行密钥保护，如果当前处于锁定状态，已保存的 API key 也会被清除", nil)
			return
		}
	}
	err := s.Passkeys.Delete(ctx, id)
	if errors.Is(err, passkey.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "通行密钥不存在", nil)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if s.KeyProtect != nil {
		if off, n, err := s.KeyProtect.AfterDelete(ctx); err != nil {
			s.fail(w, r, err)
			return
		} else if off {
			s.Log.Info("删除了最后一个能解锁 API key 的通行密钥，已关闭通行密钥保护", "cleared_keys", n)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
