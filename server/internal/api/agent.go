package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/rt-game-440/lode/server/internal/agent"
	"github.com/rt-game-440/lode/server/internal/llm"
	"github.com/rt-game-440/lode/server/internal/secret"
	"github.com/rt-game-440/lode/server/internal/workspace"
)

// 助手接口：供应商与模型配置、对话、SSE 事件流、停止和批准。见 docs/api.md 的“助手”一节。

// routeAgent 注册全局的助手接口（供应商、模型、设置）。对话接口按工作空间区分，见 agentChatRoutes。
func (s *Server) routeAgent(p *http.ServeMux) {
	p.HandleFunc("GET /api/agent/config", s.agentConfig)
	p.HandleFunc("POST /api/agent/providers", s.createProvider)
	p.HandleFunc("PUT /api/agent/providers/{id}", s.updateProvider)
	p.HandleFunc("DELETE /api/agent/providers/{id}", s.deleteProvider)
	p.HandleFunc("POST /api/agent/providers/{id}/test", s.testProvider)
	p.HandleFunc("POST /api/agent/providers/{id}/models", s.createModel)
	p.HandleFunc("PUT /api/agent/models/{id}", s.updateModel)
	p.HandleFunc("DELETE /api/agent/models/{id}", s.deleteModel)
	p.HandleFunc("PUT /api/agent/settings", s.updateAgentSettings)
}

// agentChatRoutes 是按工作空间区分的助手对话接口。
func (s *Server) agentChatRoutes() []route {
	rs := []route{
		{"GET /api/agent/chats", s.listChats},
		{"POST /api/agent/chats", s.createChat},
		{"GET /api/agent/chats/{id}", s.getChat},
		{"PATCH /api/agent/chats/{id}", s.patchChat},
		{"DELETE /api/agent/chats/{id}", s.deleteChat},
		{"POST /api/agent/chats/{id}/messages", s.sendMessage},
		{"GET /api/agent/chats/{id}/stream", s.chatStream},
		{"POST /api/agent/chats/{id}/stop", s.stopChat},
		{"POST /api/agent/chats/{id}/approvals/{callId}", s.resolveApproval},
	}
	for i := range rs {
		rs[i].handler = defaultWorkspaceOnly(rs[i].handler)
	}
	return rs
}

// chatAgent 返回处理当前工作空间对话的助手服务。目前助手只服务默认工作空间：其他工作空间的请求
// 已经被 defaultWorkspaceOnly 挡掉。#61 拆出按工作空间的 ChatStore 后改为按 currentWorkspace(r) 取依赖。
func (s *Server) chatAgent(r *http.Request) *agent.Service {
	_ = currentWorkspace(r)
	return s.Agent
}

// defaultWorkspaceOnly 让助手对话接口只在默认工作空间可用。其他工作空间返回
// 501 workspace_agent_unsupported，而不是悄悄用默认工作空间的对话和笔记（那样会串数据）。#61 去掉它。
func defaultWorkspaceOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if currentWorkspace(r).ID != workspace.DefaultID {
			writeError(w, http.StatusNotImplemented, "workspace_agent_unsupported", "这个工作空间暂不支持助手对话", nil)
			return
		}
		h(w, r)
	}
}

// agentFail 先映射助手的错误，其余交给 fail。
func (s *Server) agentFail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, agent.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "不存在或已删除", nil)
	case errors.Is(err, agent.ErrInvalid):
		writeError(w, http.StatusBadRequest, "bad_request", strings.TrimPrefix(err.Error(), agent.ErrInvalid.Error()+": "), nil)
	case errors.Is(err, agent.ErrBusy):
		writeError(w, http.StatusConflict, "busy", "助手正在回复，请先停止或等待完成", nil)
	case errors.Is(err, secret.ErrLocked):
		writeError(w, http.StatusConflict, "keys_locked", err.Error(), nil)
	default:
		s.fail(w, r, err)
	}
}

func (s *Server) agentConfig(w http.ResponseWriter, r *http.Request) {
	st, err := s.Agent.Store.Settings(r.Context())
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	ps, err := s.Agent.Store.Providers(r.Context())
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"secret_key_set": s.Agent.Store.CanStoreKeys(), "keys_locked": s.Agent.Store.KeysLocked(),
		"settings": st, "providers": ps})
}

func (s *Server) createProvider(w http.ResponseWriter, r *http.Request) {
	var in agent.ProviderInput
	if err := decode(w, r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	p, err := s.Agent.Store.CreateProvider(r.Context(), in)
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) updateProvider(w http.ResponseWriter, r *http.Request) {
	var in agent.ProviderInput
	if err := decode(w, r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	p, err := s.Agent.Store.UpdateProvider(r.Context(), r.PathValue("id"), in)
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) deleteProvider(w http.ResponseWriter, r *http.Request) {
	if err := s.Agent.Store.DeleteProvider(r.Context(), r.PathValue("id")); err != nil {
		s.agentFail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// testProvider 调用模型列表接口检查 base URL 和 key。连接失败也返回 200，结果在 ok 和 message 里。
func (s *Server) testProvider(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.Agent.Store.Config(r.Context(), r.PathValue("id"))
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	cfg.HTTP = s.Agent.HTTP
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	models, err := llm.ListModels(ctx, cfg)
	if err != nil {
		e := llm.AsError(err)
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "kind": e.Kind, "message": e.Error(), "models": []llm.ModelInfo{}})
		return
	}
	if models == nil {
		models = []llm.ModelInfo{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": fmt.Sprintf("连接成功，找到 %d 个模型", len(models)), "models": models})
}

func (s *Server) createModel(w http.ResponseWriter, r *http.Request) {
	var in agent.ModelInput
	if err := decode(w, r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	m, err := s.Agent.Store.CreateModel(r.Context(), r.PathValue("id"), in)
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (s *Server) updateModel(w http.ResponseWriter, r *http.Request) {
	var in agent.ModelInput
	if err := decode(w, r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	m, err := s.Agent.Store.UpdateModel(r.Context(), r.PathValue("id"), in)
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) deleteModel(w http.ResponseWriter, r *http.Request) {
	if err := s.Agent.Store.DeleteModel(r.Context(), r.PathValue("id")); err != nil {
		s.agentFail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) updateAgentSettings(w http.ResponseWriter, r *http.Request) {
	var in agent.Settings
	if err := decode(w, r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	st, err := s.Agent.Store.UpdateSettings(r.Context(), in)
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) listChats(w http.ResponseWriter, r *http.Request) {
	ag := s.chatAgent(r)
	chats, err := ag.Store.Chats(r.Context(), 200)
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"chats": chats})
}

// createChat 新建对话；不指定模型时用默认模型。
func (s *Server) createChat(w http.ResponseWriter, r *http.Request) {
	ag := s.chatAgent(r)
	var in struct {
		ModelID string `json:"model_id"`
	}
	if err := decode(w, r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if in.ModelID == "" {
		st, err := ag.Store.Settings(r.Context())
		if err != nil {
			s.agentFail(w, r, err)
			return
		}
		in.ModelID = st.DefaultModel
	}
	if in.ModelID != "" {
		if _, err := ag.Store.Model(r.Context(), in.ModelID); err != nil {
			s.agentFail(w, r, err)
			return
		}
	}
	c, err := ag.Store.CreateChat(r.Context(), in.ModelID)
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) getChat(w http.ResponseWriter, r *http.Request) {
	ag := s.chatAgent(r)
	v, err := ag.View(r.Context(), r.PathValue("id"))
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) patchChat(w http.ResponseWriter, r *http.Request) {
	ag := s.chatAgent(r)
	var in struct {
		Title   *string     `json:"title"`
		ModelID *string     `json:"model_id"`
		Effort  *llm.Effort `json:"effort"`
	}
	if err := decode(w, r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	c, err := ag.Store.UpdateChat(r.Context(), r.PathValue("id"), in.Title, in.ModelID, in.Effort)
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// deleteChat 删除对话；正在生成时返回 409，避免生成结束时写入已删除的对话。
func (s *Server) deleteChat(w http.ResponseWriter, r *http.Request) {
	ag := s.chatAgent(r)
	id := r.PathValue("id")
	if ag.Running(id) {
		s.agentFail(w, r, agent.ErrBusy)
		return
	}
	if err := ag.Store.DeleteChat(r.Context(), id); err != nil {
		s.agentFail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request) {
	ag := s.chatAgent(r)
	var in agent.SendInput
	if err := decode(w, r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	m, err := ag.Send(r.Context(), r.PathValue("id"), in)
	if err != nil {
		s.agentFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"message": m})
}

func (s *Server) stopChat(w http.ResponseWriter, r *http.Request) {
	ag := s.chatAgent(r)
	if err := ag.Stop(r.Context(), r.PathValue("id")); err != nil {
		s.agentFail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) resolveApproval(w http.ResponseWriter, r *http.Request) {
	ag := s.chatAgent(r)
	var in struct {
		Approve bool `json:"approve"`
	}
	if err := decode(w, r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := ag.Resolve(r.Context(), r.PathValue("id"), r.PathValue("callId"), in.Approve); err != nil {
		s.agentFail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// chatStream 以 SSE 推送对话事件。第一条是状态快照；订阅被断开（客户端太慢）时结束响应，
// EventSource 会自动重连，前端重连后重新拉取对话。
func (s *Server) chatStream(w http.ResponseWriter, r *http.Request) {
	ag := s.chatAgent(r)
	id := r.PathValue("id")
	if _, err := ag.Store.Chat(r.Context(), id); err != nil {
		s.agentFail(w, r, err)
		return
	}
	rc := http.NewResponseController(w)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no") // 让 nginx 不缓冲
	w.WriteHeader(http.StatusOK)

	events, unsubscribe := ag.Subscribe(id)
	defer unsubscribe()
	ping := time.NewTicker(s.SSEPingInterval)
	defer ping.Stop()
	if _, err := fmt.Fprint(w, "retry: 2000\n\n"); err != nil {
		return
	}
	_ = rc.Flush()
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return
			}
			b, err := json.Marshal(ev)
			if err != nil {
				s.Log.Error("序列化助手事件失败", "err", err)
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
				return
			}
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
		case <-r.Context().Done():
			return
		case <-s.done:
			return
		}
		if err := rc.Flush(); err != nil {
			return
		}
	}
}
