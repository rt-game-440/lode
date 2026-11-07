package notes

import (
	"context"
	"database/sql"
	"errors"

	"github.com/rt-game-440/lode/server/internal/mdparse"
)

// dbtx 同时适配 *sql.DB 和 *sql.Tx。
type dbtx interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

const noteCols = `num, id, path, rev, hash, size, mtime, created_at, updated_at`

type noteRow struct {
	num   int64
	mtime int64 // 纳秒，用于与磁盘比对
	Note
}

type scanner interface{ Scan(dest ...any) error }

func scanNoteRow(sc scanner) (noteRow, error) {
	var r noteRow
	err := sc.Scan(&r.num, &r.ID, &r.Path, &r.Rev, &r.Hash, &r.Size, &r.mtime, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return r, err
	}
	r.Title = titleOf(r.Path)
	r.Mtime = r.mtime / 1e6
	return r, nil
}

func getNote(ctx context.Context, q dbtx, where string, arg any) (noteRow, error) {
	r, err := scanNoteRow(q.QueryRowContext(ctx, `SELECT `+noteCols+` FROM notes WHERE `+where, arg))
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	return r, err
}

func getByID(ctx context.Context, q dbtx, id string) (noteRow, error) {
	return getNote(ctx, q, `id = ?`, id)
}

func getByPath(ctx context.Context, q dbtx, p string) (noteRow, error) {
	return getNote(ctx, q, `path = ?`, p)
}

// getByKey 按大小写不敏感的路径查找（用于查重）。
func getByKey(ctx context.Context, q dbtx, p string) (noteRow, error) {
	return getNote(ctx, q, `pkey = ?`, keyOf(p))
}

func queryNotes(ctx context.Context, q dbtx, query string, args ...any) ([]noteRow, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []noteRow
	for rows.Next() {
		r, err := scanNoteRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// insertNote 插入笔记行并建立索引，返回 num。
func insertNote(ctx context.Context, tx dbtx, n *noteRow, content string) error {
	res, err := tx.ExecContext(ctx, `INSERT INTO notes(id, path, pkey, base, rev, hash, size, mtime, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
		n.ID, n.Path, keyOf(n.Path), baseOf(n.Path), n.Rev, n.Hash, n.Size, n.mtime, n.CreatedAt, n.UpdatedAt)
	if err != nil {
		return err
	}
	n.num, err = res.LastInsertId()
	if err != nil {
		return err
	}
	if err := ensureFolders(ctx, tx, parentDirs(n.Path)...); err != nil {
		return err
	}
	return indexContent(ctx, tx, n.num, n.Path, content)
}

// updateContentRow 更新笔记行的内容相关字段并重建索引。
func updateContentRow(ctx context.Context, tx dbtx, n *noteRow, content string) error {
	_, err := tx.ExecContext(ctx, `UPDATE notes SET rev = ?, hash = ?, size = ?, mtime = ?, updated_at = ? WHERE num = ?`,
		n.Rev, n.Hash, n.Size, n.mtime, n.UpdatedAt, n.num)
	if err != nil {
		return err
	}
	return indexContent(ctx, tx, n.num, n.Path, content)
}

// updatePathRow 更新笔记路径（改名/移动），正文索引只更新标题。
func updatePathRow(ctx context.Context, tx dbtx, n *noteRow) error {
	_, err := tx.ExecContext(ctx, `UPDATE notes SET path = ?, pkey = ?, base = ?, mtime = ?, size = ?, updated_at = ? WHERE num = ?`,
		n.Path, keyOf(n.Path), baseOf(n.Path), n.mtime, n.Size, n.UpdatedAt, n.num)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE notes_fts SET title = ? WHERE rowid = ?`, titleOf(n.Path), n.num); err != nil {
		return err
	}
	return ensureFolders(ctx, tx, parentDirs(n.Path)...)
}

// deleteNoteRow 删除笔记行及其索引（链接、标签随外键级联删除）。
func deleteNoteRow(ctx context.Context, tx dbtx, num int64) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM notes_fts WHERE rowid = ?`, num); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM notes WHERE num = ?`, num)
	return err
}

// indexContent 重建一篇笔记的全文、链接和标签索引。
func indexContent(ctx context.Context, tx dbtx, num int64, p, content string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM notes_fts WHERE rowid = ?`, num); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO notes_fts(rowid, title, body) VALUES (?, ?, ?)`, num, titleOf(p), content); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM links WHERE src_num = ?`, num); err != nil {
		return err
	}
	for _, l := range mdparse.ParseLinks(content) {
		if l.Embed {
			continue // 嵌入（多为图片附件）不计入笔记链接
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO links(src_num, target, line) VALUES (?, ?, ?)`, num, normalizeTarget(l.Target), l.Line); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM tags WHERE note_num = ?`, num); err != nil {
		return err
	}
	for _, t := range mdparse.ParseTags(content) {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO tags(note_num, tag) VALUES (?, ?)`, num, t); err != nil {
			return err
		}
	}
	return nil
}

func ensureFolders(ctx context.Context, tx dbtx, dirs ...string) error {
	for _, d := range dirs {
		if d == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO folders(path) VALUES (?)`, d); err != nil {
			return err
		}
	}
	return nil
}

func recordVersion(ctx context.Context, tx dbtx, id string, rev int64, content, hash string, a Actor, ts int64) error {
	_, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO versions(note_id, rev, content, hash, created_at, device_id) VALUES (?,?,?,?,?,?)`,
		id, rev, content, hash, ts, a.DeviceID)
	return err
}

func recordChange(ctx context.Context, tx dbtx, c *Change) error {
	res, err := tx.ExecContext(ctx, `INSERT INTO changes(note_id, type, path, rev, device_id, device_name, created_at) VALUES (?,?,?,?,?,?,?)`,
		c.ID, c.Type, c.Path, c.Rev, c.DeviceID, c.DeviceName, c.CreatedAt)
	if err != nil {
		return err
	}
	c.Seq, err = res.LastInsertId()
	return err
}

// newChange 构造变更事件。
func (s *Service) newChange(ctx context.Context, typ string, n Note) Change {
	a := actorFrom(ctx)
	return Change{Type: typ, ID: n.ID, Path: n.Path, Rev: n.Rev, DeviceID: a.DeviceID, DeviceName: a.DeviceName, CreatedAt: s.nowMs()}
}

// LatestSeq 返回当前最大的变更序号。
func (s *Service) LatestSeq(ctx context.Context) (int64, error) {
	var seq sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT MAX(seq) FROM changes`).Scan(&seq)
	return seq.Int64, err
}
