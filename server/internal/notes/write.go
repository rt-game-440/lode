package notes

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/rt-game-440/lode/server/internal/merge"
	"github.com/rt-game-440/lode/server/internal/vault"
)

// Edit 是 patch 模式中的一处替换：old 必须在正文中唯一匹配。
type Edit struct {
	Old string `json:"old"`
	New string `json:"new"`
}

func (s *Service) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// Create 新建笔记。路径已存在（大小写不敏感）时返回 ErrExists。
func (s *Service) Create(ctx context.Context, p, content string) (NoteContent, error) {
	p, err := vault.CleanNotePath(p)
	if err != nil {
		return NoteContent{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.createLocked(ctx, p, content)
}

func (s *Service) createLocked(ctx context.Context, p, content string) (NoteContent, error) {
	if _, err := getByKey(ctx, s.db, p); err == nil {
		return NoteContent{}, fmt.Errorf("%w: %s", ErrExists, p)
	}
	data := []byte(content)
	info, err := s.vault.CreateFile(p, data)
	if errors.Is(err, fs.ErrExist) {
		// 磁盘上已有文件但还没进索引（外部刚创建），顺手对账。
		_, _ = s.reconcileLocked(ctx, []string{p})
		return NoteContent{}, fmt.Errorf("%w: %s", ErrExists, p)
	}
	if err != nil {
		return NoteContent{}, err
	}
	now := s.nowMs()
	n := noteRow{mtime: info.ModTime().UnixNano(), Note: Note{
		ID: newID(), Path: p, Title: titleOf(p), Rev: 1, Hash: hashContent(data), Size: info.Size(),
		CreatedAt: now, UpdatedAt: now,
	}}
	n.Mtime = n.mtime / 1e6
	ch := s.newChange(ctx, "upsert", n.Note)
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if err := insertNote(ctx, tx, &n, content); err != nil {
			return err
		}
		if err := recordVersion(ctx, tx, n.ID, n.Rev, content, n.Hash, actorFrom(ctx), now); err != nil {
			return err
		}
		return recordChange(ctx, tx, &ch)
	})
	if err != nil {
		return NoteContent{}, err
	}
	s.emit([]Change{ch})
	return NoteContent{Note: n.Note, Content: content}, nil
}

// Update 整篇替换正文。baseRev 与当前 rev 不一致时，以 baseRev 那一版为共同祖先做三方合并：
// 改动不重叠时写入合并结果（返回值 Merged 为 true）；重叠或 base 版本已被清理时保留服务器版本，
// 把 content 另存为冲突副本并返回 *ConflictError。
func (s *Service) Update(ctx context.Context, id string, baseRev int64, content string) (NoteContent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, err := s.freshLocked(ctx, id)
	if err != nil {
		return NoteContent{}, err
	}
	if baseRev != n.Rev {
		base, ok, err := s.versionContent(ctx, n.ID, baseRev)
		if err != nil {
			return NoteContent{}, err
		}
		return s.mergeLocked(ctx, n, base, ok, content)
	}
	return s.writeContentLocked(ctx, n, content)
}

// mergeLocked 把客户端基于 base 的版本 theirs 合并进服务器当前版本。
func (s *Service) mergeLocked(ctx context.Context, n noteRow, base string, haveBase bool, theirs string) (NoteContent, error) {
	if haveBase {
		cur, err := s.vault.ReadFile(n.Path)
		if err != nil {
			return NoteContent{}, err
		}
		if merged, ok := merge.Merge3(base, string(cur), theirs); ok {
			res, err := s.writeContentLocked(ctx, n, merged)
			res.Merged = err == nil
			return res, err
		}
	}
	cp, err := s.createLocked(ctx, s.conflictPathLocked(ctx, n.Path, actorFrom(ctx).DeviceName), theirs)
	if err != nil {
		return NoteContent{}, err
	}
	return NoteContent{}, &ConflictError{CurrentRev: n.Rev, CopyID: cp.ID, CopyPath: cp.Path}
}

// conflictPathLocked 返回冲突副本的路径：与原笔记同目录，名为 "名称.conflict-<设备名>-<yyyyMMdd-HHmmss>.md"。
func (s *Service) conflictPathLocked(ctx context.Context, p, device string) string {
	device = sanitizeFileName(strings.TrimSpace(device))
	if device == "file" {
		device = "未知设备"
	}
	stem := strings.TrimSuffix(p, path.Ext(p))
	return s.freePathLocked(ctx, fmt.Sprintf("%s.conflict-%s-%s.md", stem, device, s.now().Format("20060102-150405")))
}

// Patch 按 edits 依次替换正文片段，每个 old 必须唯一匹配。
func (s *Service) Patch(ctx context.Context, id string, baseRev int64, edits []Edit) (NoteContent, error) {
	if len(edits) == 0 {
		return NoteContent{}, fmt.Errorf("%w: edits 不能为空", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	n, err := s.freshLocked(ctx, id)
	if err != nil {
		return NoteContent{}, err
	}
	if baseRev != n.Rev {
		// 把 edits 应用到 base 版本得到客户端想要的全文，再与当前版本三方合并。
		// base 版本已被清理时无法还原客户端版本，直接返回冲突（不生成副本），由调用方重新读取后再改。
		base, ok, err := s.versionContent(ctx, n.ID, baseRev)
		if err != nil {
			return NoteContent{}, err
		}
		if !ok {
			return NoteContent{}, &ConflictError{CurrentRev: n.Rev}
		}
		theirs, err := ApplyEdits(base, edits)
		if err != nil {
			return NoteContent{}, err
		}
		return s.mergeLocked(ctx, n, base, true, theirs)
	}
	b, err := s.vault.ReadFile(n.Path)
	if err != nil {
		return NoteContent{}, err
	}
	content, err := ApplyEdits(string(b), edits)
	if err != nil {
		return NoteContent{}, err
	}
	return s.writeContentLocked(ctx, n, content)
}

// Append 在笔记末尾追加 text：总是基于最新版本，不会冲突。原文不以换行结尾时先补一个换行，
// 追加后保证以换行结尾；换行符沿用原文（含 CRLF 时用 CRLF）。
func (s *Service) Append(ctx context.Context, id, text string) (NoteContent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, err := s.freshLocked(ctx, id)
	if err != nil {
		return NoteContent{}, err
	}
	b, err := s.vault.ReadFile(n.Path)
	if err != nil {
		return NoteContent{}, err
	}
	cur := string(b)
	nl := "\n"
	if strings.Contains(cur, "\r\n") {
		nl = "\r\n"
		text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\r\n")
	}
	if cur != "" && !strings.HasSuffix(cur, "\n") {
		cur += nl
	}
	if !strings.HasSuffix(text, "\n") {
		text += nl
	}
	return s.writeContentLocked(ctx, n, cur+text)
}

// ApplyEdits 依次应用替换；任何一处 old 不是唯一匹配时返回 *PatchError。
func ApplyEdits(content string, edits []Edit) (string, error) {
	for i, e := range edits {
		if e.Old == "" {
			return "", fmt.Errorf("%w: 第 %d 处的 old 不能为空", ErrInvalid, i+1)
		}
		if c := strings.Count(content, e.Old); c != 1 {
			return "", &PatchError{Index: i, Matches: c}
		}
		content = strings.Replace(content, e.Old, e.New, 1)
	}
	return content, nil
}

// freshLocked 读取笔记行，并确保索引与磁盘一致（外部修改尚未被监听到时先对账）。
func (s *Service) freshLocked(ctx context.Context, id string) (noteRow, error) {
	n, err := getByID(ctx, s.db, id)
	if err != nil {
		return n, err
	}
	info, err := s.vault.Stat(n.Path)
	if err == nil && info.Size() == n.Size && info.ModTime().UnixNano() == n.mtime {
		return n, nil
	}
	if _, err := s.reconcileLocked(ctx, []string{n.Path}); err != nil {
		return n, err
	}
	return getByID(ctx, s.db, id)
}

// writeContentLocked 写入新正文：原子写文件、rev+1、记录历史版本与变更。正文未变化时不产生新版本。
func (s *Service) writeContentLocked(ctx context.Context, n noteRow, content string) (NoteContent, error) {
	data := []byte(content)
	h := hashContent(data)
	if h == n.Hash {
		return NoteContent{Note: n.Note, Content: content}, nil
	}
	info, err := s.vault.WriteFile(n.Path, data)
	if err != nil {
		return NoteContent{}, err
	}
	now := s.nowMs()
	n.Rev++
	n.Hash = h
	n.Size = info.Size()
	n.mtime = info.ModTime().UnixNano()
	n.Mtime = n.mtime / 1e6
	n.UpdatedAt = now
	ch := s.newChange(ctx, "upsert", n.Note)
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if err := updateContentRow(ctx, tx, &n, content); err != nil {
			return err
		}
		if err := recordVersion(ctx, tx, n.ID, n.Rev, content, n.Hash, actorFrom(ctx), now); err != nil {
			return err
		}
		return recordChange(ctx, tx, &ch)
	})
	if err != nil {
		return NoteContent{}, err
	}
	s.emit([]Change{ch})
	return NoteContent{Note: n.Note, Content: content}, nil
}

// MoveResult 是改名/移动的结果。
type MoveResult struct {
	Note    Note   `json:"note"`
	Updated []Note `json:"updated"` // 因更新引用而被改写的其他笔记
}

// Move 改名或移动笔记，保留 id，并更新其他笔记中指向它的 [[链接]]。
func (s *Service) Move(ctx context.Context, id, newPath string) (MoveResult, error) {
	newPath, err := vault.CleanNotePath(newPath)
	if err != nil {
		return MoveResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	n, err := s.freshLocked(ctx, id)
	if err != nil {
		return MoveResult{}, err
	}
	if n.Path == newPath {
		return MoveResult{Note: n.Note}, nil
	}
	if other, err := getByKey(ctx, s.db, newPath); err == nil && other.ID != n.ID {
		return MoveResult{}, fmt.Errorf("%w: %s", ErrExists, newPath)
	}
	plan, err := s.planLinkRewrites(ctx, map[string]string{n.ID: newPath})
	if err != nil {
		return MoveResult{}, err
	}
	if err := s.vault.Rename(n.Path, newPath); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return MoveResult{}, fmt.Errorf("%w: %s", ErrExists, newPath)
		}
		return MoveResult{}, err
	}
	oldPath := n.Path
	n.Path = newPath
	n.Title = titleOf(newPath)
	if info, err := s.vault.Stat(newPath); err == nil {
		n.mtime, n.Size = info.ModTime().UnixNano(), info.Size()
		n.Mtime = n.mtime / 1e6
	}
	n.UpdatedAt = s.nowMs()
	ch := s.newChange(ctx, "move", n.Note)
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if err := updatePathRow(ctx, tx, &n); err != nil {
			return err
		}
		return recordChange(ctx, tx, &ch)
	})
	if err != nil {
		_ = s.vault.Rename(newPath, oldPath)
		return MoveResult{}, err
	}
	s.emit([]Change{ch})
	updated, err := s.applyRewritesLocked(ctx, plan)
	if err != nil {
		return MoveResult{Note: n.Note, Updated: updated}, err
	}
	if n2, err := getByID(ctx, s.db, n.ID); err == nil {
		n = n2 // 自身包含指向自己的链接时 rev 会变化
	}
	return MoveResult{Note: n.Note, Updated: updated}, nil
}

// TrashItem 是回收站中的一项。
type TrashItem struct {
	ID        string `json:"id"`
	Path      string `json:"path"` // 原路径
	Title     string `json:"title"`
	DeletedAt int64  `json:"deleted_at"`
}

// Delete 把笔记移入回收站（DATA_DIR/trash），可用 Restore 恢复并保留 id。
func (s *Service) Delete(ctx context.Context, id string) (TrashItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, err := s.freshLocked(ctx, id)
	if err != nil {
		return TrashItem{}, err
	}
	return s.deleteLocked(ctx, n)
}

func (s *Service) deleteLocked(ctx context.Context, n noteRow) (TrashItem, error) {
	now := s.nowMs()
	file := fmt.Sprintf("%s-%d.md", n.ID, now)
	if err := s.vault.MoveOut(n.Path, filepath.Join(s.trashDir, file)); err != nil {
		return TrashItem{}, err
	}
	ch := s.newChange(ctx, "delete", n.Note)
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if err := deleteNoteRow(ctx, tx, n.num); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO trash(id, orig_path, file, rev, hash, created_at, deleted_at) VALUES (?,?,?,?,?,?,?)`,
			n.ID, n.Path, file, n.Rev, n.Hash, n.CreatedAt, now); err != nil {
			return err
		}
		return recordChange(ctx, tx, &ch)
	})
	if err != nil {
		// 索引没更新成功：把文件放回原处，保持文件与索引一致
		if rerr := s.vault.MoveIn(filepath.Join(s.trashDir, file), n.Path); rerr != nil {
			s.log.Error("删除失败且无法放回原文件", "path", n.Path, "trash", file, "err", rerr)
		}
		return TrashItem{}, err
	}
	s.emit([]Change{ch})
	return TrashItem{ID: n.ID, Path: n.Path, Title: titleOf(n.Path), DeletedAt: now}, nil
}

// ListTrash 列出回收站，最近删除的在前。
func (s *Service) ListTrash(ctx context.Context) ([]TrashItem, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, orig_path, deleted_at FROM trash ORDER BY deleted_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TrashItem{}
	for rows.Next() {
		var t TrashItem
		if err := rows.Scan(&t.ID, &t.Path, &t.DeletedAt); err != nil {
			return nil, err
		}
		t.Title = titleOf(t.Path)
		out = append(out, t)
	}
	return out, rows.Err()
}

type trashRow struct {
	id, origPath, file, hash string
	rev, createdAt           int64
}

func (s *Service) getTrash(ctx context.Context, id string) (trashRow, error) {
	var t trashRow
	err := s.db.QueryRowContext(ctx, `SELECT id, orig_path, file, hash, rev, created_at FROM trash WHERE id = ?`, id).
		Scan(&t.id, &t.origPath, &t.file, &t.hash, &t.rev, &t.createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, err
}

// Restore 从回收站恢复笔记，保留原 id。原路径被占用时自动加序号。
func (s *Service) Restore(ctx context.Context, id string) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.restoreLocked(ctx, id)
}

func (s *Service) restoreLocked(ctx context.Context, id string) (Note, error) {
	t, err := s.getTrash(ctx, id)
	if err != nil {
		return Note{}, err
	}
	target := s.freePathLocked(ctx, t.origPath)
	src := filepath.Join(s.trashDir, t.file)
	if err := s.vault.MoveIn(src, target); err != nil {
		return Note{}, err
	}
	data, err := s.vault.ReadFile(target)
	if err != nil {
		return Note{}, err
	}
	info, err := s.vault.Stat(target)
	if err != nil {
		return Note{}, err
	}
	now := s.nowMs()
	n := noteRow{mtime: info.ModTime().UnixNano(), Note: Note{
		ID: t.id, Path: target, Title: titleOf(target), Rev: t.rev, Hash: hashContent(data), Size: info.Size(),
		CreatedAt: t.createdAt, UpdatedAt: now,
	}}
	n.Mtime = n.mtime / 1e6
	if n.Hash != t.hash {
		n.Rev++
	}
	ch := s.newChange(ctx, "upsert", n.Note)
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if err := insertNote(ctx, tx, &n, string(data)); err != nil {
			return err
		}
		if n.Hash != t.hash {
			if err := recordVersion(ctx, tx, n.ID, n.Rev, string(data), n.Hash, actorFrom(ctx), now); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM trash WHERE id = ?`, id); err != nil {
			return err
		}
		return recordChange(ctx, tx, &ch)
	})
	if err != nil {
		_ = s.vault.MoveOut(target, src)
		return Note{}, err
	}
	s.emit([]Change{ch})
	return n.Note, nil
}

// freePathLocked 返回一个未被占用的笔记路径：p 被占用时依次尝试 "名称 1.md"、"名称 2.md"……
func (s *Service) freePathLocked(ctx context.Context, p string) string {
	ext := path.Ext(p)
	stem := strings.TrimSuffix(p, ext)
	cand := p
	for i := 1; ; i++ {
		if _, err := getByKey(ctx, s.db, cand); errors.Is(err, ErrNotFound) && !s.vault.Exists(cand) {
			return cand
		}
		cand = fmt.Sprintf("%s %d%s", stem, i, ext)
	}
}

// FreePath 返回一个未被占用的笔记路径，供界面"新建笔记"使用。
func (s *Service) FreePath(ctx context.Context, p string) (string, error) {
	p, err := vault.CleanNotePath(p)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.freePathLocked(ctx, p), nil
}

// Purge 永久删除回收站中的一项。
func (s *Service) Purge(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := s.getTrash(ctx, id)
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(s.trashDir, t.file)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM trash WHERE id = ?`, id); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM versions WHERE note_id = ?`, id)
		return err
	})
}

// EmptyTrash 清空回收站。
func (s *Service) EmptyTrash(ctx context.Context) error {
	items, err := s.ListTrash(ctx)
	if err != nil {
		return err
	}
	for _, it := range items {
		if err := s.Purge(ctx, it.ID); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
	}
	return nil
}
