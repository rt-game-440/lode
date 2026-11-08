package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/workspace"
)

// 按工作空间区分的接口同时挂在 /api/<原路径>（默认工作空间）和 /api/w/{ws}/<原路径> 下，
// 处理函数一律用 currentWorkspace(r) 取当前工作空间，不读 s.Notes。见 docs/workspaces.md 第 6 节。

// route 是一条路由：ServeMux 模式和处理函数。
type route struct {
	pattern string
	handler http.HandlerFunc
}

// workspaceRoutes 是所有按工作空间区分的路由，模式写原路径（/api/...）。
// 全局接口（登录、通行密钥、token、审计、助手供应商/模型/设置、API key 保护、健康检查）不在这里。
func (s *Server) workspaceRoutes() []route {
	rs := []route{
		{"GET /api/tree", s.tree},
		{"GET /api/notes", s.listNotes},
		{"POST /api/notes", s.createNote},
		{"GET /api/notes/by-path", s.readNoteByPath},
		{"GET /api/notes/{id}", s.readNote},
		{"PUT /api/notes/{id}", s.updateNote},
		{"PATCH /api/notes/{id}", s.patchNote},
		{"DELETE /api/notes/{id}", s.deleteNote},
		{"POST /api/notes/{id}/move", s.moveNote},
		{"GET /api/notes/{id}/backlinks", s.backlinks},
		{"GET /api/notes/{id}/tags", s.noteTags},
		{"GET /api/search", s.search},
		{"GET /api/tags", s.tags},
		{"GET /api/tags/notes", s.notesByTag},
		{"POST /api/folders", s.createFolder},
		{"POST /api/folders/move", s.moveFolder},
		{"DELETE /api/folders", s.deleteFolder},
		{"GET /api/trash", s.listTrash},
		{"DELETE /api/trash", s.emptyTrash},
		{"POST /api/trash/{id}/restore", s.restoreTrash},
		{"DELETE /api/trash/{id}", s.purgeTrash},
		{"POST /api/attachments", s.uploadAttachment},
		{"GET /api/images", s.listImages},
		{"GET /api/files/{path...}", s.serveFile},
		{"GET /api/changes", s.changes},
		{"GET /api/ws", s.ws},
	}
	if s.Agent != nil {
		rs = append(rs, s.agentChatRoutes()...)
	}
	return rs
}

// workspacePrefix 处理 /api/w/{ws}/...：找到工作空间放进 context，去掉 /w/{ws} 后交给 next
// （next 上注册的是原路径）。工作空间不存在时返回 404 {"error":"workspace_not_found"}。
func (s *Server) workspacePrefix(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/api/w/"), "/")
		ws, err := s.Workspaces.Get(r.Context(), id)
		if err != nil {
			s.workspaceFail(w, r, err)
			return
		}
		prefix := "/api/w/" + id
		r2 := new(http.Request)
		*r2 = *r
		u := *r.URL
		r2.URL = &u
		r2.URL.Path = "/api/" + rest
		if r.URL.RawPath != "" {
			// 和 http.StripPrefix 一样同时处理转义形式；id 里有需要转义的字符时上面已经找不到工作空间
			r2.URL.RawPath = "/api" + strings.TrimPrefix(r.URL.RawPath, prefix)
		}
		next.ServeHTTP(w, r2.WithContext(workspace.WithContext(r.Context(), ws)))
	})
}

// inWorkspace 把工作空间 id 对应的工作空间放进 context 再调用 h，用于原路径（默认工作空间）。
func (s *Server) inWorkspace(id string, h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := s.Workspaces.Get(r.Context(), id)
		if err != nil {
			s.workspaceFail(w, r, err)
			return
		}
		h(w, r.WithContext(workspace.WithContext(r.Context(), ws)))
	})
}

func (s *Server) workspaceFail(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, workspace.ErrNotFound) {
		writeError(w, http.StatusNotFound, "workspace_not_found", "工作空间不存在", map[string]any{"error": "workspace_not_found"})
		return
	}
	s.fail(w, r, err)
}

// currentWorkspace 返回当前请求的工作空间。只能在 workspaceRoutes 里的处理函数中调用，
// 否则是编程错误（panic 由 recoverer 转成 500）。
func currentWorkspace(r *http.Request) *workspace.Workspace {
	ws := workspace.FromContext(r.Context())
	if ws == nil {
		panic("api: 请求 context 里没有工作空间")
	}
	return ws
}

// wsNotes 返回当前工作空间的笔记服务。
func wsNotes(r *http.Request) *notes.Service { return currentWorkspace(r).Notes }

// apiPrefix 返回工作空间的接口前缀：默认工作空间是 /api（保持原有链接不变），其他是 /api/w/<id>。
func apiPrefix(ws *workspace.Workspace) string {
	if ws.ID == workspace.DefaultID {
		return "/api"
	}
	return "/api/w/" + ws.ID
}

// ---- 工作空间登记（全局接口）----

// listWorkspaces 列出所有工作空间，不会打开它们。
func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request) {
	list, err := s.Workspaces.List(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspaces": list})
}

// createWorkspace 新建一个内置位置的工作空间（data/workspaces/<id>/），不立即打开。
// 外部目录（vault_dir）由之后的票支持，现在传了就拒绝，免得被悄悄建成内置位置。
func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name     string `json:"name"`
		VaultDir string `json:"vault_dir"`
	}
	if err := decode(w, r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if in.VaultDir != "" {
		writeError(w, http.StatusBadRequest, "bad_request", "暂不支持外部目录", nil)
		return
	}
	info, err := s.Workspaces.Create(r.Context(), workspace.CreateOptions{Name: in.Name})
	if errors.Is(err, workspace.ErrInvalid) {
		writeError(w, http.StatusBadRequest, "bad_request", strings.TrimPrefix(err.Error(), workspace.ErrInvalid.Error()+": "), nil)
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, info)
}

// patchWorkspace 修改工作空间的名称和/或位置。name 去掉首尾空白后不能为空；sort 是移动到的位置
// （从 0 开始，列表里的第几个），其余工作空间的 sort 随之重新编号。至少要传一个字段。
func (s *Server) patchWorkspace(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name *string `json:"name"`
		Sort *int    `json:"sort"`
	}
	if err := decode(w, r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if in.Name == nil && in.Sort == nil {
		writeError(w, http.StatusBadRequest, "bad_request", "需要提供 name 或 sort", nil)
		return
	}
	id := r.PathValue("id")
	if in.Sort != nil && *in.Sort < 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "sort 不能为负数", nil)
		return
	}
	var info workspace.Info
	var err error
	if in.Name != nil {
		info, err = s.Workspaces.Rename(r.Context(), id, *in.Name)
	}
	if err == nil && in.Sort != nil {
		info, err = s.Workspaces.Reorder(r.Context(), id, *in.Sort)
	}
	if s.managementFail(w, r, err) {
		return
	}
	writeJSON(w, http.StatusOK, info)
}

// deleteWorkspace 删除工作空间：目录移到 data/trash-workspaces/ 下，绑定它的 MCP token 一并作废。
// 响应里的 trash 是相对数据目录的位置。默认工作空间不能删除（403 forbidden）。
func (s *Server) deleteWorkspace(w http.ResponseWriter, r *http.Request) {
	res, err := s.Workspaces.Remove(r.Context(), r.PathValue("id"))
	if s.managementFail(w, r, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"trash": res.Trash, "revoked_tokens": res.RevokedTokens})
}

// managementFail 把改名、排序、删除的错误转成响应，返回是否已经处理（err 不为空）。
func (s *Server) managementFail(w http.ResponseWriter, r *http.Request, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, workspace.ErrInvalid):
		writeError(w, http.StatusBadRequest, "bad_request", strings.TrimPrefix(err.Error(), workspace.ErrInvalid.Error()+": "), nil)
	case errors.Is(err, workspace.ErrNotFound):
		// 不用 workspace_not_found：前端收到它会把当前工作空间切回默认，而这里只是管理对象不存在
		writeError(w, http.StatusNotFound, "not_found", "工作空间不存在", nil)
	case errors.Is(err, workspace.ErrProtected):
		writeError(w, http.StatusForbidden, "forbidden", "默认工作空间不能删除", nil)
	default:
		s.fail(w, r, err)
	}
	return true
}
