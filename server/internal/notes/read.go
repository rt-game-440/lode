package notes

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/rt-game-440/lode/server/internal/vault"
)

// Tree 是文件树：全部文件夹与笔记（不含正文）。
type Tree struct {
	Folders []string `json:"folders"`
	Notes   []Note   `json:"notes"`
	Seq     int64    `json:"seq"` // 生成该树时的最新变更序号
}

// Tree 返回整个文件树。
func (s *Service) Tree(ctx context.Context) (Tree, error) {
	t := Tree{Folders: []string{}, Notes: []Note{}}
	seq, err := s.LatestSeq(ctx)
	if err != nil {
		return t, err
	}
	t.Seq = seq
	rows, err := queryNotes(ctx, s.db, `SELECT `+noteCols+` FROM notes ORDER BY path`)
	if err != nil {
		return t, err
	}
	for _, r := range rows {
		t.Notes = append(t.Notes, r.Note)
	}
	frows, err := s.db.QueryContext(ctx, `SELECT path FROM folders ORDER BY path`)
	if err != nil {
		return t, err
	}
	defer frows.Close()
	for frows.Next() {
		var p string
		if err := frows.Scan(&p); err != nil {
			return t, err
		}
		t.Folders = append(t.Folders, p)
	}
	return t, frows.Err()
}

// List 列出 prefix 下的笔记；recursive 为 false 时只列直接子项。
func (s *Service) List(ctx context.Context, prefix string, recursive bool) ([]Note, error) {
	prefix, err := vault.Clean(prefix, true)
	if err != nil {
		return nil, err
	}
	q := `SELECT ` + noteCols + ` FROM notes`
	var args []any
	if prefix != "" {
		q += ` WHERE path LIKE ? ESCAPE '\'`
		args = append(args, escapeLike(prefix)+"/%")
	}
	rows, err := queryNotes(ctx, s.db, q+` ORDER BY path`, args...)
	if err != nil {
		return nil, err
	}
	out := []Note{}
	for _, r := range rows {
		rest := r.Path
		if prefix != "" {
			rest = strings.TrimPrefix(r.Path, prefix+"/")
		}
		if !recursive && strings.Contains(rest, "/") {
			continue
		}
		out = append(out, r.Note)
	}
	return out, nil
}

// Get 返回笔记元数据。
func (s *Service) Get(ctx context.Context, id string) (Note, error) {
	n, err := getByID(ctx, s.db, id)
	return n.Note, err
}

// Read 读取笔记正文。正文以磁盘文件为准，发现索引落后时先对账。
func (s *Service) Read(ctx context.Context, id string) (NoteContent, error) {
	n, err := getByID(ctx, s.db, id)
	if err != nil {
		return NoteContent{}, err
	}
	return s.readRow(ctx, n)
}

// ReadByPath 按路径读取笔记（大小写不敏感）。
func (s *Service) ReadByPath(ctx context.Context, p string) (NoteContent, error) {
	p, err := vault.CleanNotePath(p)
	if err != nil {
		return NoteContent{}, err
	}
	n, err := getByPath(ctx, s.db, p)
	if errors.Is(err, ErrNotFound) {
		n, err = getByKey(ctx, s.db, p)
	}
	if err != nil {
		return NoteContent{}, fmt.Errorf("%w: %s", err, p)
	}
	return s.readRow(ctx, n)
}

// GetByPath 按路径返回笔记元数据（大小写不敏感）。
func (s *Service) GetByPath(ctx context.Context, p string) (Note, error) {
	p, err := vault.CleanNotePath(p)
	if err != nil {
		return Note{}, err
	}
	n, err := getByKey(ctx, s.db, p)
	if err != nil {
		return Note{}, fmt.Errorf("%w: %s", err, p)
	}
	return n.Note, nil
}

func (s *Service) readRow(ctx context.Context, n noteRow) (NoteContent, error) {
	b, err := s.vault.ReadFile(n.Path)
	if err == nil && hashContent(b) == n.Hash {
		return NoteContent{Note: n.Note, Content: string(b)}, nil
	}
	// 磁盘与索引不一致：外部修改还没被监听到，先对账再读。
	s.mu.Lock()
	_, rerr := s.reconcileLocked(ctx, []string{n.Path})
	s.mu.Unlock()
	if rerr != nil {
		return NoteContent{}, rerr
	}
	n, err = getByID(ctx, s.db, n.ID)
	if err != nil {
		return NoteContent{}, err
	}
	b, err = s.vault.ReadFile(n.Path)
	if err != nil {
		return NoteContent{}, err
	}
	return NoteContent{Note: n.Note, Content: string(b)}, nil
}

// SearchQuery 是全文搜索参数。
type SearchQuery struct {
	Query      string
	Limit      int
	PathPrefix string
}

// SearchResult 是一条搜索结果。Snippet 中命中部分用 \x02 和 \x03 包裹。
type SearchResult struct {
	ID      string `json:"id"`
	Path    string `json:"path"`
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
	Mtime   int64  `json:"mtime"`
}

const (
	markOpen  = "\x02"
	markClose = "\x03"
)

// Search 全文搜索。所有词都不少于 3 个字符时用 FTS5 trigram，否则用 LIKE 兜底。多个词之间是"与"。
func (s *Service) Search(ctx context.Context, sq SearchQuery) ([]SearchResult, error) {
	terms := strings.Fields(sq.Query)
	out := []SearchResult{}
	if len(terms) == 0 {
		return out, nil
	}
	if sq.Limit <= 0 || sq.Limit > 200 {
		sq.Limit = 20
	}
	prefix := ""
	if sq.PathPrefix != "" {
		p, err := vault.Clean(sq.PathPrefix, true)
		if err != nil {
			return nil, err
		}
		prefix = p
	}
	short := false
	for _, t := range terms {
		if utf8.RuneCountInString(t) < 3 {
			short = true
		}
	}
	var where []string
	var args []any
	var q string
	if !short {
		phrases := make([]string, len(terms))
		for i, t := range terms {
			phrases[i] = `"` + strings.ReplaceAll(t, `"`, `""`) + `"`
		}
		q = `SELECT ` + prefixCols("n") + `, snippet(notes_fts, 1, char(2), char(3), '…', 16) FROM notes_fts JOIN notes n ON n.num = notes_fts.rowid`
		where = append(where, `notes_fts MATCH ?`)
		args = append(args, strings.Join(phrases, " "))
	} else {
		q = `SELECT ` + prefixCols("n") + `, notes_fts.body FROM notes_fts JOIN notes n ON n.num = notes_fts.rowid`
		for _, t := range terms {
			like := "%" + escapeLike(t) + "%"
			where = append(where, `(notes_fts.title LIKE ? ESCAPE '\' OR notes_fts.body LIKE ? ESCAPE '\')`)
			args = append(args, like, like)
		}
	}
	if prefix != "" {
		where = append(where, `n.path LIKE ? ESCAPE '\'`)
		args = append(args, escapeLike(prefix)+"/%")
	}
	q += ` WHERE ` + strings.Join(where, " AND ")
	if !short {
		q += ` ORDER BY bm25(notes_fts, 10.0, 1.0)`
	} else {
		q += ` ORDER BY n.mtime DESC`
	}
	q += ` LIMIT ?`
	args = append(args, sq.Limit)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r noteRow
		var text string
		if err := rows.Scan(&r.num, &r.ID, &r.Path, &r.Rev, &r.Hash, &r.Size, &r.mtime, &r.CreatedAt, &r.UpdatedAt, &text); err != nil {
			return nil, err
		}
		if short {
			text = likeSnippet(text, terms, 40)
		}
		out = append(out, SearchResult{ID: r.ID, Path: r.Path, Title: titleOf(r.Path), Snippet: text, Mtime: r.mtime / 1e6})
	}
	return out, rows.Err()
}

func prefixCols(alias string) string {
	cols := strings.Split(noteCols, ", ")
	for i, c := range cols {
		cols[i] = alias + "." + c
	}
	return strings.Join(cols, ", ")
}

// likeSnippet 截取第一个命中词附近的文本，并用标记包裹全部命中。
func likeSnippet(body string, terms []string, radius int) string {
	runes := []rune(body)
	lower := []rune(strings.ToLower(body))
	if len(lower) != len(runes) {
		lower = runes // 大小写转换改变了长度时退回到区分大小写
	}
	first := -1
	for _, t := range terms {
		if i := runeIndex(lower, []rune(strings.ToLower(t))); i >= 0 && (first < 0 || i < first) {
			first = i
		}
	}
	if first < 0 {
		first = 0
	}
	start := max(0, first-radius)
	end := min(len(runes), first+radius*2)
	var sb strings.Builder
	if start > 0 {
		sb.WriteString("…")
	}
	i := start
	for i < end {
		matched := 0
		for _, t := range terms {
			tr := []rune(strings.ToLower(t))
			if i+len(tr) <= len(lower) && string(lower[i:i+len(tr)]) == string(tr) {
				matched = len(tr)
				break
			}
		}
		if matched > 0 {
			sb.WriteString(markOpen + string(runes[i:i+matched]) + markClose)
			i += matched
			continue
		}
		r := runes[i]
		if r == '\n' || r == '\r' {
			r = ' '
		}
		sb.WriteRune(r)
		i++
	}
	if end < len(runes) {
		sb.WriteString("…")
	}
	return sb.String()
}

func runeIndex(hay, needle []rune) int {
	if len(needle) == 0 {
		return -1
	}
	for i := 0; i+len(needle) <= len(hay); i++ {
		if string(hay[i:i+len(needle)]) == string(needle) {
			return i
		}
	}
	return -1
}

// TagCount 是标签及其笔记数。
type TagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// Tags 列出全部标签。
func (s *Service) Tags(ctx context.Context) ([]TagCount, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT tag, count(*) FROM tags GROUP BY tag ORDER BY tag`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TagCount{}
	for rows.Next() {
		var t TagCount
		if err := rows.Scan(&t.Tag, &t.Count); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// NotesByTag 返回带有该标签（含其子标签，如 a 包含 a/b）的笔记。
func (s *Service) NotesByTag(ctx context.Context, tag string) ([]Note, error) {
	tag = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(tag), "#"))
	if tag == "" {
		return nil, fmt.Errorf("%w: tag 不能为空", ErrInvalid)
	}
	rows, err := queryNotes(ctx, s.db, `SELECT DISTINCT `+prefixCols("n")+` FROM notes n JOIN tags t ON t.note_num = n.num
		WHERE t.tag = ? OR t.tag LIKE ? ESCAPE '\' ORDER BY n.path`, tag, escapeLike(tag)+"/%")
	if err != nil {
		return nil, err
	}
	out := []Note{}
	for _, r := range rows {
		out = append(out, r.Note)
	}
	return out, nil
}

// NoteTags 返回一篇笔记的标签。
func (s *Service) NoteTags(ctx context.Context, id string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT t.tag FROM tags t JOIN notes n ON n.num = t.note_num WHERE n.id = ? ORDER BY t.tag`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Changes 返回 seq 大于 since 的变更（最多 limit 条）以及当前最新 seq。
// since 早于已清理的范围或晚于最新 seq（数据库被重建）时返回 ErrGone。
func (s *Service) Changes(ctx context.Context, since int64, limit int) ([]Change, int64, error) {
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	latest, err := s.LatestSeq(ctx)
	if err != nil {
		return nil, 0, err
	}
	floor, err := s.changesFloor(ctx)
	if err != nil {
		return nil, 0, err
	}
	if since < floor || since > latest {
		return nil, latest, ErrGone
	}
	rows, err := s.db.QueryContext(ctx, `SELECT seq, note_id, type, path, rev, device_id, device_name, created_at FROM changes WHERE seq > ? ORDER BY seq LIMIT ?`, since, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Change{}
	for rows.Next() {
		var c Change
		if err := rows.Scan(&c.Seq, &c.ID, &c.Type, &c.Path, &c.Rev, &c.DeviceID, &c.DeviceName, &c.CreatedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, c)
	}
	return out, latest, rows.Err()
}
