package api

import (
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/notes"
)

// ---- 健康检查与鉴权 ----

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "version": s.Version})
}

func (s *Server) authStatus(w http.ResponseWriter, r *http.Request) {
	init, err := s.Auth.Initialized(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ok, err := s.sessionValid(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// passkey：当前访问的域名下是否登记了通行密钥，登录页据此决定是否显示通行密钥按钮
	writeJSON(w, http.StatusOK, map[string]bool{"initialized": init, "authenticated": ok, "passkey": s.hasPasskey(r)})
}

type passwordReq struct {
	Password string `json:"password"`
}

func (s *Server) authSetup(w http.ResponseWriter, r *http.Request) {
	var req passwordReq
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	switch err := s.Auth.Setup(r.Context(), req.Password); {
	case errors.Is(err, auth.ErrAlreadyInitialized):
		writeError(w, http.StatusConflict, "already_initialized", "密码已经设置过", nil)
		return
	case errors.Is(err, auth.ErrWeakPassword):
		writeError(w, http.StatusBadRequest, "weak_password", fmt.Sprintf("密码至少 %d 个字符", auth.MinPasswordLen), nil)
		return
	case err != nil:
		s.fail(w, r, err)
		return
	}
	s.startSession(w, r)
}

func (s *Server) authLogin(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if ok, wait := s.Auth.Limiter.Allow(ip); !ok {
		secs := int(wait.Seconds() + 0.999)
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		writeError(w, http.StatusTooManyRequests, "rate_limited", fmt.Sprintf("尝试次数过多，请 %d 秒后再试", secs), map[string]any{"retry_after": secs})
		return
	}
	var req passwordReq
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	switch err := s.Auth.CheckPassword(r.Context(), req.Password); {
	case errors.Is(err, auth.ErrNotInitialized):
		writeError(w, http.StatusConflict, "not_initialized", "尚未设置密码", nil)
		return
	case errors.Is(err, auth.ErrBadPassword):
		locked := s.Auth.Limiter.Fail(ip)
		s.Log.Warn("登录失败", "ip", ip, "locked", locked)
		writeError(w, http.StatusUnauthorized, "wrong_password", "密码错误", nil)
		return
	case err != nil:
		s.fail(w, r, err)
		return
	}
	s.Auth.Limiter.Success(ip)
	s.startSession(w, r)
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request) {
	token, exp, err := s.Auth.CreateSession(r.Context(), r.UserAgent())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  exp,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   s.isHTTPS(r),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) authLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(SessionCookie); err == nil {
		_ = s.Auth.DeleteSession(r.Context(), c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: s.isHTTPS(r)})
	w.WriteHeader(http.StatusNoContent)
}

// ---- 笔记 ----

func (s *Server) tree(w http.ResponseWriter, r *http.Request) {
	t, err := s.Notes.Tree(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) listNotes(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ns, err := s.Notes.List(r.Context(), q.Get("prefix"), q.Get("recursive") != "false")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": ns})
}

type createReq struct {
	Path       string `json:"path"`
	Content    string `json:"content"`
	AutoRename bool   `json:"auto_rename"` // 路径被占用时自动加序号
}

func (s *Server) createNote(w http.ResponseWriter, r *http.Request) {
	var req createReq
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	p := req.Path
	if req.AutoRename {
		free, err := s.Notes.FreePath(r.Context(), p)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		p = free
	}
	n, err := s.Notes.Create(r.Context(), p, req.Content)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, n)
}

func (s *Server) readNote(w http.ResponseWriter, r *http.Request) {
	n, err := s.Notes.Read(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *Server) readNoteByPath(w http.ResponseWriter, r *http.Request) {
	n, err := s.Notes.ReadByPath(r.Context(), r.URL.Query().Get("path"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

type updateReq struct {
	BaseRev *int64       `json:"base_rev"`
	Content *string      `json:"content"`
	Edits   []notes.Edit `json:"edits"`
}

func (s *Server) updateNote(w http.ResponseWriter, r *http.Request) {
	var req updateReq
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if req.BaseRev == nil || req.Content == nil {
		writeError(w, http.StatusBadRequest, "bad_request", "需要 base_rev 和 content", nil)
		return
	}
	n, err := s.Notes.Update(r.Context(), r.PathValue("id"), *req.BaseRev, *req.Content)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *Server) patchNote(w http.ResponseWriter, r *http.Request) {
	var req updateReq
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if req.BaseRev == nil || len(req.Edits) == 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "需要 base_rev 和 edits", nil)
		return
	}
	n, err := s.Notes.Patch(r.Context(), r.PathValue("id"), *req.BaseRev, req.Edits)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *Server) deleteNote(w http.ResponseWriter, r *http.Request) {
	item, err := s.Notes.Delete(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// pathReq 是只带一个目标路径的请求（移动笔记、新建文件夹）。
type pathReq struct {
	Path string `json:"path"`
}

type folderMoveReq struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func (s *Server) moveNote(w http.ResponseWriter, r *http.Request) {
	var req pathReq
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	res, err := s.Notes.Move(r.Context(), r.PathValue("id"), req.Path)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) backlinks(w http.ResponseWriter, r *http.Request) {
	bl, err := s.Notes.Backlinks(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"backlinks": bl})
}

func (s *Server) noteTags(w http.ResponseWriter, r *http.Request) {
	tags, err := s.Notes.NoteTags(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags})
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	res, err := s.Notes.Search(r.Context(), notes.SearchQuery{Query: q.Get("q"), Limit: limit, PathPrefix: q.Get("path_prefix")})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": res})
}

func (s *Server) tags(w http.ResponseWriter, r *http.Request) {
	tags, err := s.Notes.Tags(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags})
}

func (s *Server) notesByTag(w http.ResponseWriter, r *http.Request) {
	ns, err := s.Notes.NotesByTag(r.Context(), r.URL.Query().Get("tag"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": ns})
}

// ---- 文件夹 ----

func (s *Server) createFolder(w http.ResponseWriter, r *http.Request) {
	var req pathReq
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	p, err := s.Notes.CreateFolder(r.Context(), req.Path)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": p})
}

func (s *Server) moveFolder(w http.ResponseWriter, r *http.Request) {
	var req folderMoveReq
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	res, err := s.Notes.MoveFolder(r.Context(), req.From, req.To)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) deleteFolder(w http.ResponseWriter, r *http.Request) {
	n, err := s.Notes.DeleteFolder(r.Context(), r.URL.Query().Get("path"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"trashed": n})
}

// ---- 回收站 ----

func (s *Server) listTrash(w http.ResponseWriter, r *http.Request) {
	items, err := s.Notes.ListTrash(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) restoreTrash(w http.ResponseWriter, r *http.Request) {
	n, err := s.Notes.Restore(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *Server) purgeTrash(w http.ResponseWriter, r *http.Request) {
	if err := s.Notes.Purge(r.Context(), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) emptyTrash(w http.ResponseWriter, r *http.Request) {
	if err := s.Notes.EmptyTrash(r.Context()); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- 附件与文件 ----

func (s *Server) uploadAttachment(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.MaxUploadBytes+1<<20)
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "需要 multipart 字段 file", nil)
		return
	}
	defer file.Close()
	name := hdr.Filename
	if name == "" || name == "image.png" || name == "blob" {
		// 粘贴的图片通常没有有意义的文件名
		ext := ".png"
		if exts, _ := mime.ExtensionsByType(hdr.Header.Get("Content-Type")); len(exts) > 0 {
			ext = exts[0]
		}
		if e := path.Ext(name); e != "" {
			ext = e
		}
		name = "pasted-" + time.Now().Format("20060102-150405") + ext
	}
	rel, err := s.Notes.SaveAttachment(r.Context(), name, file, s.MaxUploadBytes)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": rel, "url": "/api/files/" + escapePath(rel)})
}

// listImages 列出 vault 里的图片，供助手选择附件。
func (s *Server) listImages(w http.ResponseWriter, r *http.Request) {
	imgs, err := s.Notes.Images(500)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"images": imgs})
}

func (s *Server) serveFile(w http.ResponseWriter, r *http.Request) {
	f, info, err := s.Notes.OpenFile(r.PathValue("path"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer f.Close()
	// 附件可能是用户上传的任意文件（例如 SVG），用沙箱 CSP 防止脚本执行。
	w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

func escapePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}

func (s *Server) changes(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	cs, latest, err := s.Notes.Changes(r.Context(), since, limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"changes": cs, "seq": latest})
}
