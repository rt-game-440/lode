package notes

import (
	"context"
	"path"
	"sort"
	"strings"

	"github.com/rt-game-440/lode/server/internal/mdparse"
)

// resolve 解析 [[target]] 指向哪篇笔记，规则与 Obsidian 的"尽量最短路径"一致：
//   - 目标含 "/"：先精确匹配 vault 根起的路径，否则匹配以该路径结尾的笔记（取路径最短者）；
//   - 只有名称：按文件名匹配，多篇同名时优先与源笔记同目录的，其次路径最短的，再按字典序。
func resolve(ctx context.Context, q dbtx, target, srcPath string) (noteRow, bool) {
	t := normalizeTarget(target)
	if t == "" {
		return noteRow{}, false
	}
	if strings.Contains(t, "/") {
		if r, err := getNote(ctx, q, `pkey = ?`, t); err == nil {
			return r, true
		}
		rows, err := queryNotes(ctx, q, `SELECT `+noteCols+` FROM notes WHERE base = ? AND pkey LIKE ? ESCAPE '\'`,
			path.Base(t), "%/"+escapeLike(t))
		if err != nil || len(rows) == 0 {
			return noteRow{}, false
		}
		return pickBest(rows, ""), true
	}
	rows, err := queryNotes(ctx, q, `SELECT `+noteCols+` FROM notes WHERE base = ?`, t)
	if err != nil || len(rows) == 0 {
		return noteRow{}, false
	}
	return pickBest(rows, path.Dir(srcPath)), true
}

func pickBest(rows []noteRow, srcDir string) noteRow {
	sort.Slice(rows, func(i, j int) bool {
		a, b := rows[i].Path, rows[j].Path
		if srcDir != "" {
			sa, sb := path.Dir(a) == srcDir, path.Dir(b) == srcDir
			if sa != sb {
				return sa
			}
		}
		if len(a) != len(b) {
			return len(a) < len(b)
		}
		return a < b
	})
	return rows[0]
}

// linkKeys 返回可能指向 p 的所有链接键：文件名，以及从各级目录起的路径后缀。
func linkKeys(p string) []string {
	k := keyOf(p)
	segs := strings.Split(k, "/")
	keys := make([]string, 0, len(segs))
	for i := len(segs) - 1; i >= 0; i-- {
		keys = append(keys, strings.Join(segs[i:], "/"))
	}
	return keys
}

type linkRef struct {
	srcNum  int64
	srcID   string
	srcPath string
	target  string
	line    int
}

// candidateLinks 查出所有可能指向 p 的出链（尚未经过 resolve 校验）。
func candidateLinks(ctx context.Context, q dbtx, p string) ([]linkRef, error) {
	keys := linkKeys(p)
	args := make([]any, len(keys))
	ph := make([]string, len(keys))
	for i, k := range keys {
		args[i], ph[i] = k, "?"
	}
	rows, err := q.QueryContext(ctx, `SELECT l.src_num, n.id, n.path, l.target, l.line FROM links l JOIN notes n ON n.num = l.src_num
		WHERE l.target IN (`+strings.Join(ph, ",")+`) ORDER BY n.path, l.line`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []linkRef
	for rows.Next() {
		var r linkRef
		if err := rows.Scan(&r.srcNum, &r.srcID, &r.srcPath, &r.target, &r.line); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Backlink 是一篇引用了目标笔记的笔记及引用所在的行。
type Backlink struct {
	ID    string         `json:"id"`
	Path  string         `json:"path"`
	Title string         `json:"title"`
	Lines []BacklinkLine `json:"lines"`
}

// BacklinkLine 是引用所在行的上下文。
type BacklinkLine struct {
	Line int    `json:"line"`
	Text string `json:"text"`
}

// Backlinks 返回所有链接到该笔记的其他笔记。
func (s *Service) Backlinks(ctx context.Context, id string) ([]Backlink, error) {
	n, err := getByID(ctx, s.db, id)
	if err != nil {
		return nil, err
	}
	refs, err := candidateLinks(ctx, s.db, n.Path)
	if err != nil {
		return nil, err
	}
	out := []Backlink{}
	idx := map[string]int{}
	bodies := map[int64][]string{}
	for _, r := range refs {
		if r.srcID == n.ID {
			continue
		}
		if to, ok := resolve(ctx, s.db, r.target, r.srcPath); !ok || to.ID != n.ID {
			continue
		}
		i, ok := idx[r.srcID]
		if !ok {
			i = len(out)
			idx[r.srcID] = i
			out = append(out, Backlink{ID: r.srcID, Path: r.srcPath, Title: titleOf(r.srcPath)})
		}
		lines, ok := bodies[r.srcNum]
		if !ok {
			var body string
			_ = s.db.QueryRowContext(ctx, `SELECT body FROM notes_fts WHERE rowid = ?`, r.srcNum).Scan(&body)
			lines = strings.Split(body, "\n")
			bodies[r.srcNum] = lines
		}
		text := ""
		if r.line-1 < len(lines) {
			text = truncateRunes(strings.TrimSpace(strings.TrimSuffix(lines[r.line-1], "\r")), 200)
		}
		bl := &out[i]
		if len(bl.Lines) == 0 || bl.Lines[len(bl.Lines)-1].Line != r.line {
			bl.Lines = append(bl.Lines, BacklinkLine{Line: r.line, Text: text})
		}
	}
	return out, nil
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// rewrite 是一次链接改写计划：把某篇笔记的正文替换为 content。
type rewrite struct {
	id      string
	content string
}

// planLinkRewrites 在移动发生前计算需要改写的引用。moves 为 笔记 id → 新路径。
func (s *Service) planLinkRewrites(ctx context.Context, moves map[string]string) ([]rewrite, error) {
	moved := map[string]noteRow{}
	keySet := map[string]bool{}
	srcSet := map[string]bool{}
	var srcOrder []string
	for id := range moves {
		n, err := getByID(ctx, s.db, id)
		if err != nil {
			return nil, err
		}
		moved[id] = n
		for _, k := range linkKeys(n.Path) {
			keySet[k] = true
		}
		refs, err := candidateLinks(ctx, s.db, n.Path)
		if err != nil {
			return nil, err
		}
		for _, r := range refs {
			if !srcSet[r.srcID] {
				srcSet[r.srcID] = true
				srcOrder = append(srcOrder, r.srcID)
			}
		}
	}
	var plan []rewrite
	for _, srcID := range srcOrder {
		src, err := getByID(ctx, s.db, srcID)
		if err != nil {
			continue
		}
		b, err := s.vault.ReadFile(src.Path)
		if err != nil {
			continue
		}
		content := string(b)
		links := mdparse.ParseLinks(content)
		type repl struct {
			start, end int
			text       string
		}
		var repls []repl
		for _, l := range links {
			if l.Embed || !keySet[normalizeTarget(l.Target)] {
				continue
			}
			to, ok := resolve(ctx, s.db, l.Target, src.Path)
			if !ok {
				continue
			}
			newPath, isMoved := moves[to.ID]
			if !isMoved {
				continue
			}
			text, err := s.newLinkText(ctx, l.Target, to.ID, newPath, moves)
			if err != nil {
				return nil, err
			}
			if text != l.Target {
				repls = append(repls, repl{l.TargetStart, l.TargetEnd, text})
			}
		}
		if len(repls) == 0 {
			continue
		}
		var sb strings.Builder
		last := 0
		for _, r := range repls {
			sb.WriteString(content[last:r.start])
			sb.WriteString(r.text)
			last = r.end
		}
		sb.WriteString(content[last:])
		plan = append(plan, rewrite{id: srcID, content: sb.String()})
	}
	return plan, nil
}

// newLinkText 计算移动后的链接文本：原来只写名称且新名称在移动后仍唯一时只写名称，否则写 vault 根起的路径。
func (s *Service) newLinkText(ctx context.Context, oldTarget, id, newPath string, moves map[string]string) (string, error) {
	hadMd := strings.HasSuffix(strings.ToLower(strings.TrimSpace(oldTarget)), ".md")
	pathStyle := strings.Contains(normalizeTarget(oldTarget), "/")
	text := strings.TrimSuffix(newPath, path.Ext(newPath))
	if !pathStyle {
		newBase := baseOf(newPath)
		rows, err := queryNotes(ctx, s.db, `SELECT `+noteCols+` FROM notes WHERE base = ?`, newBase)
		if err != nil {
			return "", err
		}
		clash := false
		for _, r := range rows {
			if _, m := moves[r.ID]; !m && r.ID != id {
				clash = true
			}
		}
		for mid, mp := range moves {
			if mid != id && baseOf(mp) == newBase {
				clash = true
			}
		}
		if !clash {
			text = titleOf(newPath)
		}
	}
	if hadMd {
		text += ".md"
	}
	return text, nil
}

// applyRewritesLocked 执行改写计划，返回被改写的笔记。
func (s *Service) applyRewritesLocked(ctx context.Context, plan []rewrite) ([]Note, error) {
	updated := []Note{}
	for _, r := range plan {
		n, err := getByID(ctx, s.db, r.id)
		if err != nil {
			continue
		}
		nc, err := s.writeContentLocked(ctx, n, r.content)
		if err != nil {
			return updated, err
		}
		updated = append(updated, nc.Note)
	}
	return updated, nil
}
