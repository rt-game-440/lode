package notes

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"os"
	"sort"
	"strings"

	"github.com/rt-game-440/lode/server/internal/vault"
)

// ReconcileStats 是一次对账的统计。
type ReconcileStats struct {
	Added, Updated, Moved, Removed int
}

// Reconcile 让索引与磁盘一致。scopes 为空时对整个 vault 对账（启动时调用），
// 否则只检查给定的相对路径（文件或目录，fsnotify 增量更新时调用）。
//
// 外部改名的识别：同一批次里"一个路径消失、一个新路径出现、内容哈希相同"，视为改名并保留原 id。
func (s *Service) Reconcile(ctx context.Context, scopes ...string) (ReconcileStats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reconcileLocked(ctx, scopes)
}

type diskFile struct {
	vault.Entry
	hash string
}

func (s *Service) reconcileLocked(ctx context.Context, scopes []string) (ReconcileStats, error) {
	var st ReconcileStats
	if len(scopes) == 0 {
		scopes = []string{""}
	}
	scopes = minimalScopes(scopes)
	disk := map[string]*diskFile{}
	dirs := map[string]bool{}
	known := map[string]noteRow{} // 范围内索引中已有的笔记，按路径
	goneDirs := []string{}        // 已不存在的目录范围

	for _, sc := range scopes {
		info, err := os.Lstat(s.vault.Abs(sc))
		switch {
		case errors.Is(err, fs.ErrNotExist):
			goneDirs = append(goneDirs, sc)
			if err := s.loadKnown(ctx, sc, known); err != nil {
				return st, err
			}
		case err != nil:
			return st, err
		case info.IsDir():
			if err := s.vault.Walk(sc, func(e vault.Entry) error {
				if e.IsDir {
					if e.Path != "" {
						dirs[e.Path] = true
					}
					return nil
				}
				disk[e.Path] = &diskFile{Entry: e}
				return nil
			}); err != nil {
				return st, err
			}
			if err := s.loadKnown(ctx, sc, known); err != nil {
				return st, err
			}
		case info.Mode().IsRegular() && vault.IsNote(sc):
			disk[sc] = &diskFile{Entry: vault.Entry{Path: sc, Size: info.Size(), Mtime: info.ModTime().UnixNano()}}
			if r, err := getByPath(ctx, s.db, sc); err == nil {
				known[sc] = r
			}
		default:
			// 非笔记文件（附件等）不入索引
		}
	}

	var changes []Change
	var newFiles []*diskFile
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return st, err
	}
	defer tx.Rollback()
	now := s.nowMs()
	ctxFS := WithActor(ctx, fsActor)

	// 1. 已知路径：比对 mtime/size，必要时读内容比对哈希。
	paths := sortedKeys(disk)
	for _, p := range paths {
		f := disk[p]
		r, ok := known[p]
		if !ok {
			newFiles = append(newFiles, f)
			continue
		}
		delete(known, p)
		if r.Size == f.Size && r.mtime == f.Mtime {
			continue
		}
		data, err := s.vault.ReadFile(p)
		if err != nil {
			continue
		}
		h := hashContent(data)
		r.mtime, r.Size = f.Mtime, int64(len(data))
		r.Mtime = r.mtime / 1e6
		if h == r.Hash {
			if _, err := tx.ExecContext(ctx, `UPDATE notes SET mtime = ?, size = ? WHERE num = ?`, r.mtime, r.Size, r.num); err != nil {
				return st, err
			}
			continue
		}
		r.Rev++
		r.Hash = h
		r.UpdatedAt = now
		if err := updateContentRow(ctx, tx, &r, string(data)); err != nil {
			return st, err
		}
		if err := recordVersion(ctx, tx, r.ID, r.Rev, string(data), h, fsActor, now); err != nil {
			return st, err
		}
		ch := s.newChange(ctxFS, "upsert", r.Note)
		if err := recordChange(ctx, tx, &ch); err != nil {
			return st, err
		}
		changes = append(changes, ch)
		st.Updated++
	}

	// 2. 消失的路径与新路径按哈希配对，识别为改名。
	missing := make([]noteRow, 0, len(known))
	for _, r := range known {
		missing = append(missing, r)
	}
	sort.Slice(missing, func(i, j int) bool { return missing[i].Path < missing[j].Path })
	if len(missing) > 0 {
		byHash := map[string][]int{}
		for i, r := range missing {
			byHash[r.Hash] = append(byHash[r.Hash], i)
		}
		used := make([]bool, len(missing))
		remaining := newFiles[:0]
		for _, f := range newFiles {
			data, err := s.vault.ReadFile(f.Path)
			if err != nil {
				continue
			}
			f.hash = hashContent(data)
			idx := -1
			for _, i := range byHash[f.hash] {
				if !used[i] {
					idx = i
					break
				}
			}
			if idx < 0 {
				remaining = append(remaining, f)
				continue
			}
			used[idx] = true
			r := missing[idx]
			r.Path = f.Path
			r.Title = titleOf(f.Path)
			r.mtime, r.Size = f.Mtime, f.Size
			r.Mtime = r.mtime / 1e6
			r.UpdatedAt = now
			if err := updatePathRow(ctx, tx, &r); err != nil {
				return st, err
			}
			ch := s.newChange(ctxFS, "move", r.Note)
			if err := recordChange(ctx, tx, &ch); err != nil {
				return st, err
			}
			changes = append(changes, ch)
			st.Moved++
		}
		newFiles = remaining
		kept := missing[:0]
		for i, r := range missing {
			if !used[i] {
				kept = append(kept, r)
			}
		}
		missing = kept
	}

	// 3. 真正消失的笔记：从索引移除（文件已不在，不进回收站）。
	for _, r := range missing {
		if err := deleteNoteRow(ctx, tx, r.num); err != nil {
			return st, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM versions WHERE note_id = ?`, r.ID); err != nil {
			return st, err
		}
		ch := s.newChange(ctxFS, "delete", r.Note)
		if err := recordChange(ctx, tx, &ch); err != nil {
			return st, err
		}
		changes = append(changes, ch)
		st.Removed++
	}

	// 4. 新笔记。
	for _, f := range newFiles {
		data, err := s.vault.ReadFile(f.Path)
		if err != nil {
			continue
		}
		// 大小写不敏感文件系统上，同名不同大小写的路径已在索引中时跳过。
		if _, err := getByKey(ctx, tx, f.Path); err == nil {
			continue
		}
		n := noteRow{mtime: f.Mtime, Note: Note{
			ID: newID(), Path: f.Path, Title: titleOf(f.Path), Rev: 1, Hash: hashContent(data), Size: int64(len(data)),
			CreatedAt: now, UpdatedAt: now,
		}}
		n.Mtime = n.mtime / 1e6
		if err := insertNote(ctx, tx, &n, string(data)); err != nil {
			return st, err
		}
		if err := recordVersion(ctx, tx, n.ID, n.Rev, string(data), n.Hash, fsActor, now); err != nil {
			return st, err
		}
		ch := s.newChange(ctxFS, "upsert", n.Note)
		if err := recordChange(ctx, tx, &ch); err != nil {
			return st, err
		}
		changes = append(changes, ch)
		st.Added++
	}

	// 5. 文件夹。
	for _, sc := range scopes {
		if err := syncFolders(ctx, tx, sc, dirs); err != nil {
			return st, err
		}
	}
	for _, sc := range goneDirs {
		if err := deleteFolders(ctx, tx, sc); err != nil {
			return st, err
		}
	}
	if err := tx.Commit(); err != nil {
		return st, err
	}
	s.emit(changes)
	return st, nil
}

// loadKnown 把索引中位于 scope 内（含 scope 本身作为文件）的笔记放进 known。
func (s *Service) loadKnown(ctx context.Context, scope string, known map[string]noteRow) error {
	var rows []noteRow
	var err error
	if scope == "" {
		rows, err = queryNotes(ctx, s.db, `SELECT `+noteCols+` FROM notes`)
	} else {
		rows, err = queryNotes(ctx, s.db, `SELECT `+noteCols+` FROM notes WHERE path = ? OR path LIKE ? ESCAPE '\'`, scope, escapeLike(scope)+"/%")
	}
	if err != nil {
		return err
	}
	for _, r := range rows {
		known[r.Path] = r
	}
	return nil
}

// syncFolders 让索引中 scope 下的文件夹与磁盘一致（scope 不是目录时什么都不做）。
func syncFolders(ctx context.Context, tx *sql.Tx, scope string, dirs map[string]bool) error {
	var rows *sql.Rows
	var err error
	if scope == "" {
		rows, err = tx.QueryContext(ctx, `SELECT path FROM folders`)
	} else {
		rows, err = tx.QueryContext(ctx, `SELECT path FROM folders WHERE path LIKE ? ESCAPE '\'`, escapeLike(scope)+"/%")
	}
	if err != nil {
		return err
	}
	var stale []string
	seen := map[string]bool{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			return err
		}
		seen[p] = true
		if !dirs[p] {
			stale = append(stale, p)
		}
	}
	rows.Close()
	for _, p := range stale {
		if _, err := tx.ExecContext(ctx, `DELETE FROM folders WHERE path = ?`, p); err != nil {
			return err
		}
	}
	for d := range dirs {
		if scope != "" && d != scope && !strings.HasPrefix(d, scope+"/") {
			continue
		}
		if !seen[d] {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO folders(path) VALUES (?)`, d); err != nil {
				return err
			}
		}
	}
	return nil
}

func deleteFolders(ctx context.Context, tx dbtx, scope string) error {
	if scope == "" {
		_, err := tx.ExecContext(ctx, `DELETE FROM folders`)
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM folders WHERE path = ? OR path LIKE ? ESCAPE '\'`, scope, escapeLike(scope)+"/%")
	return err
}

// minimalScopes 去重并去掉被其他范围包含的范围。
func minimalScopes(scopes []string) []string {
	sort.Strings(scopes)
	var out []string
	for _, sc := range scopes {
		covered := false
		for _, o := range out {
			if o == "" || sc == o || strings.HasPrefix(sc, o+"/") {
				covered = true
				break
			}
		}
		if !covered {
			out = append(out, sc)
		}
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
