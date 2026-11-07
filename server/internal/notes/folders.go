package notes

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/rt-game-440/lode/server/internal/vault"
)

// CreateFolder 新建文件夹（含父目录）。
func (s *Service) CreateFolder(ctx context.Context, p string) (string, error) {
	p, err := vault.Clean(p, false)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if info, err := s.vault.Stat(p); err == nil && !info.IsDir() {
		return "", fmt.Errorf("%w: %s", ErrExists, p)
	}
	if err := s.vault.Mkdir(p); err != nil {
		return "", err
	}
	dirs := append([]string{p}, parentDirs(p)...)
	if err := ensureFolders(ctx, s.db, dirs...); err != nil {
		return "", err
	}
	return p, nil
}

// MoveFolder 改名或移动文件夹，其中的笔记保留 id，并更新指向它们的链接。
func (s *Service) MoveFolder(ctx context.Context, from, to string) (MoveFolderResult, error) {
	from, err := vault.Clean(from, false)
	if err != nil {
		return MoveFolderResult{}, err
	}
	to, err = vault.Clean(to, false)
	if err != nil {
		return MoveFolderResult{}, err
	}
	if from == to {
		return MoveFolderResult{}, nil
	}
	if strings.HasPrefix(to+"/", from+"/") {
		return MoveFolderResult{}, fmt.Errorf("%w: 不能把文件夹移动到它自己里面", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := s.vault.Stat(from)
	if err != nil || !info.IsDir() {
		return MoveFolderResult{}, fmt.Errorf("%w: 文件夹 %s", ErrNotFound, from)
	}
	if s.vault.Exists(to) && !strings.EqualFold(from, to) {
		return MoveFolderResult{}, fmt.Errorf("%w: %s", ErrExists, to)
	}
	// 先对账该目录，确保索引与磁盘一致。
	if _, err := s.reconcileLocked(ctx, []string{from}); err != nil {
		return MoveFolderResult{}, err
	}
	rows, err := queryNotes(ctx, s.db, `SELECT `+noteCols+` FROM notes WHERE path LIKE ? ESCAPE '\'`, escapeLike(from)+"/%")
	if err != nil {
		return MoveFolderResult{}, err
	}
	moves := map[string]string{}
	for _, r := range rows {
		np := to + strings.TrimPrefix(r.Path, from)
		if other, err := getByKey(ctx, s.db, np); err == nil && other.ID != r.ID {
			return MoveFolderResult{}, fmt.Errorf("%w: %s", ErrExists, np)
		}
		moves[r.ID] = np
	}
	plan, err := s.planLinkRewrites(ctx, moves)
	if err != nil {
		return MoveFolderResult{}, err
	}
	if err := s.vault.Rename(from, to); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return MoveFolderResult{}, fmt.Errorf("%w: %s", ErrExists, to)
		}
		return MoveFolderResult{}, err
	}
	now := s.nowMs()
	var changes []Change
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		for _, r := range rows {
			r.Path = moves[r.ID]
			r.Title = titleOf(r.Path)
			r.UpdatedAt = now
			if err := updatePathRow(ctx, tx, &r); err != nil {
				return err
			}
			ch := s.newChange(ctx, "move", r.Note)
			if err := recordChange(ctx, tx, &ch); err != nil {
				return err
			}
			changes = append(changes, ch)
		}
		if err := deleteFolders(ctx, tx, from); err != nil {
			return err
		}
		dirs := append([]string{to}, parentDirs(to)...)
		if err := ensureFolders(ctx, tx, dirs...); err != nil {
			return err
		}
		return s.vault.Walk(to, func(e vault.Entry) error {
			if e.IsDir && e.Path != "" {
				return ensureFolders(ctx, tx, e.Path)
			}
			return nil
		})
	})
	if err != nil {
		_ = s.vault.Rename(to, from)
		return MoveFolderResult{}, err
	}
	s.emit(changes)
	updated, err := s.applyRewritesLocked(ctx, plan)
	return MoveFolderResult{Path: to, Moved: len(rows), Updated: updated}, err
}

// MoveFolderResult 是移动文件夹的结果。
type MoveFolderResult struct {
	Path    string `json:"path"`
	Moved   int    `json:"moved"`   // 移动的笔记数
	Updated []Note `json:"updated"` // 因更新引用而被改写的笔记
}

// DeleteFolder 删除文件夹：其中的笔记逐篇进回收站；剩下的非笔记文件整体移到 DATA_DIR/trash/folders 下。
func (s *Service) DeleteFolder(ctx context.Context, p string) (int, error) {
	p, err := vault.Clean(p, false)
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := s.vault.Stat(p)
	if err != nil || !info.IsDir() {
		return 0, fmt.Errorf("%w: 文件夹 %s", ErrNotFound, p)
	}
	if _, err := s.reconcileLocked(ctx, []string{p}); err != nil {
		return 0, err
	}
	rows, err := queryNotes(ctx, s.db, `SELECT `+noteCols+` FROM notes WHERE path LIKE ? ESCAPE '\'`, escapeLike(p)+"/%")
	if err != nil {
		return 0, err
	}
	for _, r := range rows {
		if _, err := s.deleteLocked(ctx, r); err != nil {
			return 0, err
		}
	}
	abs := s.vault.Abs(p)
	if hasFiles(abs) {
		dst := filepath.Join(s.trashDir, "folders", fmt.Sprintf("%d-%s", time.Now().UnixMilli(), path.Base(p)))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return 0, err
		}
		if err := os.Rename(abs, dst); err != nil {
			return 0, err
		}
	} else if err := os.RemoveAll(abs); err != nil {
		return 0, err
	}
	return len(rows), deleteFolders(ctx, s.db, p)
}

func hasFiles(dir string) bool {
	found := false
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

// AttachmentDir 是附件所在目录。
const AttachmentDir = "attachments"

// SaveAttachment 把上传的文件保存到 vault/attachments，重名时自动加序号，返回相对路径。
func (s *Service) SaveAttachment(ctx context.Context, name string, r io.Reader, maxBytes int64) (string, error) {
	name = sanitizeFileName(name)
	if strings.EqualFold(path.Ext(name), ".md") {
		return "", fmt.Errorf("%w: 附件不能是 .md 文件", ErrInvalid)
	}
	if err := s.vault.Mkdir(AttachmentDir); err != nil {
		return "", err
	}
	dir := s.vault.Abs(AttachmentDir)
	tmp, err := os.CreateTemp(dir, ".lode-tmp-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	n, err := io.Copy(tmp, io.LimitReader(r, maxBytes+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if n > maxBytes {
		return "", fmt.Errorf("%w: 文件超过 %d 字节", ErrInvalid, maxBytes)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ext := path.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; ; i++ {
		cand := name
		if i > 0 {
			cand = fmt.Sprintf("%s-%d%s", stem, i, ext)
		}
		rel := AttachmentDir + "/" + cand
		if s.vault.Exists(rel) {
			continue
		}
		if err := os.Rename(tmpName, s.vault.Abs(rel)); err != nil {
			return "", err
		}
		return rel, nil
	}
}

func sanitizeFileName(name string) string {
	name = path.Base(strings.ReplaceAll(name, "\\", "/"))
	var sb strings.Builder
	for _, r := range name {
		switch {
		case r < 0x20 || r == 0x7f || strings.ContainsRune(`<>:"/\|?*#^[]`, r):
			sb.WriteRune('-')
		default:
			sb.WriteRune(r)
		}
	}
	out := strings.Trim(strings.TrimSpace(sb.String()), ".")
	if out == "" || out == "-" {
		out = "file"
	}
	return out
}

// OpenFile 打开 vault 内的文件（用于下载附件）。路径会做防穿越校验。
func (s *Service) OpenFile(p string) (*os.File, fs.FileInfo, error) {
	p, err := vault.Clean(p, false)
	if err != nil {
		return nil, nil, err
	}
	// 防止通过 vault 内的符号链接读到 vault 之外的文件。
	abs, err := s.vault.Resolve(p)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		f.Close()
		return nil, nil, ErrNotFound
	}
	return f, info, nil
}
