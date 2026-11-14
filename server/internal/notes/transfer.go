package notes

// 在两个工作空间（两个 Service）之间移动或复制笔记和文件夹（#72）。
//
// 流程（两个 Service 的写锁全程持有，按 vault 根目录的字典序加锁，避免相反方向的两次传输互相等待）：
//  1. 规划：解析条目、去重、算目标路径（重名时自动改名）、找出正文引用的附件、统计移动后会失效的链接；
//  2. 暂存：把所有文件写进目标 vault 根目录下的隐藏目录（.lode-transfer-*，监听和对账都会忽略）；
//  3. 提交：把暂存的顶层条目和附件逐个改名到最终位置，在目标库的事务里登记笔记、历史版本和变更；
//  4. 移动时把源笔记逐篇移进源空间的回收站；
//  5. 提交目标库事务，推送目标空间的变更。
// 第 2–5 步任何一步失败都会撤销：删掉已放进目标 vault 的文件和新建的空目录，回滚目标库事务，
// 已进回收站的源笔记恢复原位。所以失败时目标空间不会留下半成品。

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/rt-game-440/lode/server/internal/mdparse"
	"github.com/rt-game-440/lode/server/internal/vault"
)

// TransferItem 是要移动或复制的一项：笔记（按 ID，也可以按 Path）或文件夹（Path）。
type TransferItem struct {
	Kind string `json:"kind"` // note | folder
	ID   string `json:"id,omitempty"`
	Path string `json:"path,omitempty"`
}

// TransferOptions 描述一次跨工作空间的移动或复制。
type TransferOptions struct {
	Items []TransferItem
	// Dir 是目标空间里的文件夹，空表示根目录；不存在时自动创建。
	Dir string
	// Move 为 true 时移动（源条目进源空间的回收站），否则复制。
	Move bool
	// DryRun 只规划不执行：返回会改名的条目和会失效的链接数，供确认对话框使用。
	DryRun bool
}

// TransferRename 是一项路径变化：From 是源空间里的路径，To 是目标空间里的路径。
type TransferRename struct {
	Kind string `json:"kind"` // note | folder | attachment
	From string `json:"from"`
	To   string `json:"to"`
}

// TransferNote 是一篇被传输的笔记。DryRun 时 ID 为空。
type TransferNote struct {
	FromID   string `json:"from_id"`
	FromPath string `json:"from_path"`
	ID       string `json:"id"`
	Path     string `json:"path"`
}

// TransferResult 是传输结果。
type TransferResult struct {
	// Items 是顶层条目在目标空间里的位置（与请求的条目一一对应，去重后的）。
	Items []TransferRename `json:"items"`
	// Notes 是所有传输的笔记（含文件夹里的）。
	Notes []TransferNote `json:"notes"`
	// Attachments 是另外复制到目标空间的附件（正文引用的、不在所传文件夹里的文件）。
	Attachments []TransferRename `json:"attachments"`
	// Renamed 是因为目标位置已有同名条目而改了名的笔记、文件夹和附件。
	Renamed []TransferRename `json:"renamed"`
	// BrokenLinks 是源空间里其他笔记指向被移走笔记的链接数（只在移动时统计）。
	BrokenLinks int `json:"broken_links"`
	// Trashed 是移进源空间回收站的笔记数。
	Trashed int `json:"trashed"`
}

// transferHook 供测试在各阶段注入失败：staged、unit（每提交一个顶层条目或附件之后）、indexed、trashed。
var transferHook func(stage string) error

func tHook(stage string) error {
	if transferHook != nil {
		return transferHook(stage)
	}
	return nil
}

// tfile 是要放进目标空间的一个文件。
type tfile struct {
	src     string // 源 vault 里的相对路径
	dst     string // 目标 vault 里的相对路径
	note    *noteRow
	content []byte // 笔记正文（可能改写过附件链接）；非笔记文件为 nil，从 src 复制
}

type transferPlan struct {
	res     TransferResult
	files   []*tfile
	units   []string          // 提交单元：顶层条目和附件的目标路径
	dirs    []string          // 目标里要登记的文件夹
	folders map[string]string // 选中的源文件夹 → 目标路径
	planned map[string]string // 目标路径（小写）→ 源路径
	notes   []noteRow         // 选中的所有源笔记
	srcDirs []string          // 选中的源文件夹（移动时最后删除）
}

// Transfer 把 src 里的条目移动或复制到 dst 的 opts.Dir 下。见文件开头的说明。
func Transfer(ctx context.Context, src, dst *Service, opts TransferOptions) (TransferResult, error) {
	if src == dst || src.vault.Root() == dst.vault.Root() {
		return TransferResult{}, fmt.Errorf("%w: 目标工作空间与来源相同", ErrInvalid)
	}
	if len(opts.Items) == 0 {
		return TransferResult{}, fmt.Errorf("%w: items 不能为空", ErrInvalid)
	}
	dir, err := vault.Clean(opts.Dir, true)
	if err != nil {
		return TransferResult{}, err
	}
	first, second := src, dst
	if dst.vault.Root() < src.vault.Root() {
		first, second = dst, src
	}
	first.mu.Lock()
	defer first.mu.Unlock()
	second.mu.Lock()
	defer second.mu.Unlock()

	p, err := planTransfer(ctx, src, dst, opts.Items, dir, opts.Move)
	if err != nil || opts.DryRun {
		return p.res, err
	}
	return p.res, p.execute(ctx, src, dst, dir, opts.Move)
}

func planTransfer(ctx context.Context, src, dst *Service, items []TransferItem, dir string, move bool) (*transferPlan, error) {
	p := &transferPlan{folders: map[string]string{}, planned: map[string]string{}}
	p.res = TransferResult{Items: []TransferRename{}, Notes: []TransferNote{}, Attachments: []TransferRename{}, Renamed: []TransferRename{}}
	if dir != "" {
		if info, err := dst.vault.Stat(dir); err == nil && !info.IsDir() {
			return p, fmt.Errorf("%w: 目标 %s 不是文件夹", ErrInvalid, dir)
		}
	}

	// 1. 解析条目
	var noteItems []noteRow
	var folderItems []string
	seen := map[string]bool{}
	for _, it := range items {
		switch it.Kind {
		case "note":
			var n noteRow
			var err error
			if it.ID != "" {
				n, err = src.freshLocked(ctx, it.ID)
			} else {
				var cp string
				if cp, err = vault.CleanNotePath(it.Path); err == nil {
					n, err = getByKey(ctx, src.db, cp)
				}
			}
			if err != nil {
				return p, fmt.Errorf("笔记 %s%s: %w", it.ID, it.Path, err)
			}
			if !seen["n:"+n.ID] {
				seen["n:"+n.ID] = true
				noteItems = append(noteItems, n)
			}
		case "folder":
			fp, err := vault.Clean(it.Path, false)
			if err != nil {
				return p, err
			}
			if info, err := src.vault.Stat(fp); err != nil || !info.IsDir() {
				return p, fmt.Errorf("%w: 文件夹 %s", ErrNotFound, fp)
			}
			if !seen["f:"+strings.ToLower(fp)] {
				seen["f:"+strings.ToLower(fp)] = true
				folderItems = append(folderItems, fp)
			}
		default:
			return p, fmt.Errorf("%w: kind 必须是 note 或 folder", ErrInvalid)
		}
	}
	// 去掉位于其他选中文件夹里的条目
	inSelected := func(rel string, self string) bool {
		for _, f := range folderItems {
			if f != self && strings.HasPrefix(strings.ToLower(rel)+"/", strings.ToLower(f)+"/") && !strings.EqualFold(rel, f) {
				return true
			}
		}
		return false
	}
	var keptFolders []string
	for _, f := range folderItems {
		if !inSelected(f, f) {
			keptFolders = append(keptFolders, f)
		}
	}
	folderItems = keptFolders
	var keptNotes []noteRow
	for _, n := range noteItems {
		if !inSelected(n.Path, "") {
			keptNotes = append(keptNotes, n)
		}
	}
	noteItems = keptNotes

	// 2. 顶层条目的目标路径
	for _, n := range noteItems {
		to := p.freeNotePath(ctx, dst, join(dir, path.Base(n.Path)))
		p.addItem("note", n.Path, to, join(dir, path.Base(n.Path)))
		nr := n
		p.add(&tfile{src: n.Path, dst: to, note: &nr})
		p.units = append(p.units, to)
		p.notes = append(p.notes, n)
	}
	for _, f := range folderItems {
		if _, err := src.reconcileLocked(ctx, []string{f}); err != nil {
			return p, err
		}
		want := join(dir, path.Base(f))
		to := p.freeFolderPath(ctx, dst, want)
		p.addItem("folder", f, to, want)
		p.folders[f] = to
		p.units = append(p.units, to)
		p.srcDirs = append(p.srcDirs, f)
		if err := p.addFolder(ctx, src, f, to); err != nil {
			return p, err
		}
	}

	// 3. 附件
	for _, tf := range p.files {
		if tf.note == nil {
			continue
		}
		b, err := src.vault.ReadFile(tf.src)
		if err != nil {
			return p, err
		}
		content, err := p.planAttachments(src, dst, tf, string(b))
		if err != nil {
			return p, err
		}
		tf.content = []byte(content)
		p.res.Notes = append(p.res.Notes, TransferNote{FromID: tf.note.ID, FromPath: tf.src, Path: tf.dst})
	}

	// 4. 移动后源空间里会失效的链接
	if move {
		moved := map[string]bool{}
		for _, n := range p.notes {
			moved[n.ID] = true
		}
		for _, n := range p.notes {
			refs, err := candidateLinks(ctx, src.db, n.Path)
			if err != nil {
				return p, err
			}
			for _, r := range refs {
				if moved[r.srcID] {
					continue
				}
				if to, ok := resolve(ctx, src.db, r.target, r.srcPath); ok && to.ID == n.ID {
					p.res.BrokenLinks++
				}
			}
		}
	}
	return p, nil
}

func join(dir, name string) string {
	if dir == "" {
		return name
	}
	return dir + "/" + name
}

func (p *transferPlan) add(f *tfile) {
	p.files = append(p.files, f)
	p.planned[strings.ToLower(f.dst)] = f.src
}

func (p *transferPlan) addItem(kind, from, to, want string) {
	r := TransferRename{Kind: kind, From: from, To: to}
	p.res.Items = append(p.res.Items, r)
	if to != want {
		p.res.Renamed = append(p.res.Renamed, r)
	}
}

// taken 判断目标空间里 rel 是否已被占用（磁盘上已有，或本次已规划为文件或新文件夹）。
// 本次新建的文件夹里没有规划的位置算空着：放进去的文件会随文件夹一起提交。
func (p *transferPlan) taken(dst *Service, rel string) bool {
	if _, ok := p.planned[strings.ToLower(rel)]; ok {
		return true
	}
	for _, u := range p.units {
		if strings.EqualFold(u, rel) {
			return true
		}
	}
	return dst.vault.Exists(rel)
}

// freeNotePath 与“导入笔记”的自动改名一致：被占用时依次尝试 "名称 1.md"、"名称 2.md"……
func (p *transferPlan) freeNotePath(ctx context.Context, dst *Service, want string) string {
	ext := path.Ext(want)
	stem := strings.TrimSuffix(want, ext)
	cand := want
	for i := 1; ; i++ {
		if _, err := getByKey(ctx, dst.db, cand); errors.Is(err, ErrNotFound) && !p.taken(dst, cand) {
			return cand
		}
		cand = fmt.Sprintf("%s %d%s", stem, i, ext)
	}
}

// freeFolderPath 同上，文件夹依次尝试 "名称 1"、"名称 2"……
func (p *transferPlan) freeFolderPath(ctx context.Context, dst *Service, want string) string {
	cand := want
	for i := 1; ; i++ {
		if !p.taken(dst, cand) && !indexHasPrefix(ctx, dst.db, cand) {
			return cand
		}
		cand = fmt.Sprintf("%s %d", want, i)
	}
}

func indexHasPrefix(ctx context.Context, q dbtx, dir string) bool {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM notes WHERE pkey LIKE ? ESCAPE '\' LIMIT 1`, escapeLike(strings.ToLower(dir))+"/%").Scan(&one)
	return err == nil
}

// addFolder 规划整个源文件夹：笔记、非笔记文件（图片等）和空目录都带过去；隐藏文件和符号链接跳过。
func (p *transferPlan) addFolder(ctx context.Context, src *Service, from, to string) error {
	rows, err := queryNotes(ctx, src.db, `SELECT `+noteCols+` FROM notes WHERE path LIKE ? ESCAPE '\'`, escapeLike(from)+"/%")
	if err != nil {
		return err
	}
	byPath := map[string]noteRow{}
	for _, r := range rows {
		byPath[r.Path] = r
	}
	root := src.vault.Abs(from)
	return filepath.WalkDir(root, func(abs string, d fs.DirEntry, err error) error {
		if err != nil {
			if abs == root {
				return err
			}
			return nil
		}
		rel, ok := src.vault.Rel(abs)
		if !ok {
			return nil
		}
		if vault.IsIgnored(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		target := to + strings.TrimPrefix(rel, from)
		switch {
		case d.IsDir():
			p.dirs = append(p.dirs, target)
		case !d.Type().IsRegular():
		case vault.IsNote(rel):
			r, ok := byPath[rel]
			if !ok {
				return fmt.Errorf("笔记 %s 还没有进索引，请稍后再试", rel)
			}
			p.add(&tfile{src: rel, dst: target, note: &r})
			p.notes = append(p.notes, r)
		default:
			p.add(&tfile{src: rel, dst: target})
		}
		return nil
	})
}

// ---- 附件 ----

var schemeRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)

// attachRef 是笔记正文里对附件（非 .md 文件）的一处引用。
type attachRef struct {
	start, end int    // 目标在正文里的字节范围
	target     string // 解码后的目标
	md         bool   // Markdown 链接或图片（目标是 URL，可能带转义）
	angle      bool   // Markdown 链接的目标写在 <...> 里
}

func isAttachmentName(t string) bool {
	ext := path.Ext(strings.ReplaceAll(t, "\\", "/"))
	return ext != "" && !strings.EqualFold(ext, ".md") && !strings.Contains(ext, "/")
}

// attachmentRefs 找出正文里引用 vault 内文件的 ![[...]]、[[...]]、![](...) 和 [](...)。
func attachmentRefs(content string) []attachRef {
	var out []attachRef
	for _, l := range mdparse.ParseLinks(content) {
		if isAttachmentName(l.Target) {
			out = append(out, attachRef{start: l.TargetStart, end: l.TargetEnd, target: l.Target})
		}
	}
	for _, u := range mdparse.ParseURLLinks(content) {
		raw := u.URL
		if schemeRE.MatchString(raw) || strings.HasPrefix(raw, "#") || strings.HasPrefix(raw, "//") {
			continue
		}
		if i := strings.IndexAny(raw, "?#"); i >= 0 {
			raw = raw[:i]
		}
		dec, err := url.PathUnescape(raw)
		if err != nil {
			dec = raw
		}
		if isAttachmentName(dec) {
			out = append(out, attachRef{start: u.Start, end: u.Start + len(raw), target: dec, md: true, angle: u.Angle})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].start < out[j].start })
	return out
}

// embedCandidates 与前端 livePreview 的 embedSources / imageSources 一致：
// 含 "/" 的目标是从 vault 根起的路径（Markdown 链接以 "/" 开头同样），只有文件名时依次找笔记同目录、根目录和 attachments/。
func embedCandidates(target, notePath string, md bool) []string {
	t := strings.ReplaceAll(target, "\\", "/")
	if md && strings.HasPrefix(t, "/") {
		return []string{strings.TrimLeft(t, "/")}
	}
	t = strings.TrimPrefix(t, "./")
	t = strings.TrimPrefix(t, "/")
	if strings.Contains(t, "/") {
		return []string{t}
	}
	dir := path.Dir(notePath)
	if dir == "." {
		dir = ""
	}
	return []string{join(dir, t), t, AttachmentDir + "/" + t}
}

// regularFile 判断 vault 里 rel 是否是普通文件（经过路径校验，不跟随符号链接）。
func regularFile(v *vault.Vault, rel string) bool {
	rel, err := vault.Clean(rel, false)
	if err != nil {
		return false
	}
	abs, err := v.Resolve(rel)
	if err != nil {
		return false
	}
	info, err := os.Lstat(abs)
	return err == nil && info.Mode().IsRegular()
}

// planAttachments 规划笔记 tf 引用的附件：把每个引用的文件放到目标空间里同样能被这条链接找到的位置。
// 那个位置已有内容不同的文件时，附件改名（"名称-1.png"，与上传附件的规则一致）并把链接改成新的完整路径。
// 返回（可能改写过的）正文。
func (p *transferPlan) planAttachments(src, dst *Service, tf *tfile, content string) (string, error) {
	type edit struct {
		start, end int
		text       string
	}
	var edits []edit
	for _, ref := range attachmentRefs(content) {
		srcCands := embedCandidates(ref.target, tf.src, ref.md)
		dstCands := embedCandidates(ref.target, tf.dst, ref.md)
		k := -1
		for i, c := range srcCands {
			if regularFile(src.vault, c) {
				k = i
				break
			}
		}
		if k < 0 {
			continue // 源空间里也找不到：保持原样
		}
		s := srcCands[k]
		want := dstCands[k]
		if c, err := vault.Clean(want, false); err != nil || c != want {
			continue
		}
		// 所在文件夹整体被传过去了：文件已经在规划里
		if m, ok := p.mappedInFolder(s); ok {
			if !strings.EqualFold(m, want) || p.shadowed(dst, dstCands[:k], s) {
				edits = append(edits, edit{ref.start, ref.end, linkText(m, ref)})
			}
			continue
		}
		ok, err := p.placeable(src, dst, s, want)
		if err != nil {
			return "", err
		}
		if ok && !p.shadowed(dst, dstCands[:k], s) {
			p.planAttachment(dst, s, want)
			continue
		}
		// 冲突：改名后用完整路径链接
		to := p.freeAttachmentPath(dst, s, want)
		p.planAttachment(dst, s, to)
		edits = append(edits, edit{ref.start, ref.end, linkText(to, ref)})
	}
	for i := len(edits) - 1; i >= 0; i-- {
		e := edits[i]
		content = content[:e.start] + e.text + content[e.end:]
	}
	return content, nil
}

// mappedInFolder 返回 src 路径的文件在某个选中的文件夹里时，它在目标空间里的路径。
func (p *transferPlan) mappedInFolder(s string) (string, bool) {
	for f, to := range p.folders {
		if strings.HasPrefix(s, f+"/") {
			return to + strings.TrimPrefix(s, f), true
		}
	}
	return "", false
}

// shadowed 判断目标空间里排在前面的候选位置是否已有别的文件（链接会先找到它）。
func (p *transferPlan) shadowed(dst *Service, earlier []string, s string) bool {
	for _, c := range earlier {
		if from, ok := p.planned[strings.ToLower(c)]; ok {
			if from != s {
				return true
			}
			continue
		}
		if dst.vault.Exists(c) {
			return true
		}
	}
	return false
}

// placeable 判断源文件 s 能否放在目标 want：空着、已规划为同一个文件，或已有内容相同的文件。
func (p *transferPlan) placeable(src, dst *Service, s, want string) (bool, error) {
	if from, ok := p.planned[strings.ToLower(want)]; ok {
		return from == s, nil
	}
	if p.taken(dst, want) && !dst.vault.Exists(want) {
		return false, nil // 和本次新建的文件夹同名
	}
	if !dst.vault.Exists(want) {
		return true, nil
	}
	return sameContent(src.vault.Abs(s), dst.vault.Abs(want))
}

// planAttachment 规划把源文件 s 复制到目标 to；目标上已有内容相同的文件时什么也不做。
func (p *transferPlan) planAttachment(dst *Service, s, to string) {
	if _, ok := p.planned[strings.ToLower(to)]; ok || dst.vault.Exists(to) {
		return
	}
	p.add(&tfile{src: s, dst: to})
	p.units = append(p.units, to)
	r := TransferRename{Kind: "attachment", From: s, To: to}
	p.res.Attachments = append(p.res.Attachments, r)
	if path.Base(s) != path.Base(to) {
		p.res.Renamed = append(p.res.Renamed, r)
	}
}

// freeAttachmentPath 在 want 所在目录（根目录时改用 attachments/）找一个空着的名字："名称-1.png"、"名称-2.png"……
// 已有内容相同的同名文件时直接复用。
func (p *transferPlan) freeAttachmentPath(dst *Service, s, want string) string {
	dir := path.Dir(want)
	if dir == "." {
		dir = AttachmentDir
	}
	name := path.Base(want)
	ext := path.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 1; ; i++ {
		cand := fmt.Sprintf("%s/%s-%d%s", dir, stem, i, ext)
		if from, ok := p.planned[strings.ToLower(cand)]; ok {
			if from == s {
				return cand
			}
			continue
		}
		if !p.taken(dst, cand) {
			return cand
		}
	}
}

// linkText 是指向目标路径 to 的链接文字（to 总含 "/"，从 vault 根解析）。
func linkText(to string, ref attachRef) string {
	if !ref.md {
		return to
	}
	if ref.angle {
		return to
	}
	r := strings.NewReplacer("%", "%25", " ", "%20", "(", "%28", ")", "%29", "<", "%3C", ">", "%3E")
	return r.Replace(to)
}

func sameContent(a, b string) (bool, error) {
	ia, err := os.Stat(a)
	if err != nil {
		return false, err
	}
	ib, err := os.Stat(b)
	if err != nil || !ib.Mode().IsRegular() || ia.Size() != ib.Size() {
		return false, nil
	}
	ha, err := fileHash(a)
	if err != nil {
		return false, err
	}
	hb, err := fileHash(b)
	if err != nil {
		return false, nil
	}
	return ha == hb, nil
}

func fileHash(p string) ([32]byte, error) {
	var out [32]byte
	f, err := os.Open(p)
	if err != nil {
		return out, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return out, err
	}
	copy(out[:], h.Sum(nil))
	return out, nil
}

// ---- 执行 ----

func (p *transferPlan) execute(ctx context.Context, src, dst *Service, dir string, move bool) (err error) {
	// 2. 暂存
	staging := filepath.Join(dst.vault.Root(), ".lode-transfer-"+newID())
	defer os.RemoveAll(staging)
	stage := func(rel string) string { return filepath.Join(staging, filepath.FromSlash(rel)) }
	for _, d := range p.dirs {
		if err := os.MkdirAll(stage(d), 0o755); err != nil {
			return err
		}
	}
	for _, f := range p.files {
		if err := os.MkdirAll(filepath.Dir(stage(f.dst)), 0o755); err != nil {
			return err
		}
		if f.note != nil {
			err = os.WriteFile(stage(f.dst), f.content, 0o644)
		} else {
			err = copyRegular(src.vault.Abs(f.src), stage(f.dst))
		}
		if err != nil {
			return err
		}
	}
	if err := tHook("staged"); err != nil {
		return err
	}

	// 3. 提交文件：逐个顶层条目改名到最终位置；失败时撤销已放进去的
	var committed []string // 目标绝对路径
	var createdDirs []string
	undoFiles := func() {
		for i := len(committed) - 1; i >= 0; i-- {
			if rerr := os.RemoveAll(committed[i]); rerr != nil {
				dst.log.Error("撤销传输：删除已放入的文件失败", "path", committed[i], "err", rerr)
			}
		}
		for i := len(createdDirs) - 1; i >= 0; i-- {
			_ = os.Remove(createdDirs[i]) // 只删空目录
		}
	}
	defer func() {
		if err != nil {
			undoFiles()
		}
	}()
	if dir != "" {
		if createdDirs, err = mkdirTracked(dst.vault.Abs(dir), createdDirs); err != nil {
			return err
		}
	}
	for _, u := range p.units {
		if inUnit(u, p.units) {
			continue // 在另一个提交单元（新文件夹）里，随它一起提交
		}
		abs := dst.vault.Abs(u)
		if createdDirs, err = mkdirTracked(filepath.Dir(abs), createdDirs); err != nil {
			return err
		}
		if _, lerr := os.Lstat(abs); lerr == nil {
			return fmt.Errorf("%w: %s", ErrExists, u)
		}
		if err = renameNoReplace(stage(u), abs); err != nil {
			return err
		}
		committed = append(committed, abs)
		if err = tHook("unit"); err != nil {
			return err
		}
	}

	// 目标库事务：登记笔记、历史版本、变更
	tx, err := dst.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	txDone := false
	defer func() {
		if !txDone {
			tx.Rollback()
		}
	}()
	now := dst.nowMs()
	actor := actorFrom(ctx)
	var changes []Change
	if err = ensureFolders(ctx, tx, append(parentDirs(join(dir, "x")), p.dirs...)...); err != nil {
		return err
	}
	ni := 0
	for _, f := range p.files {
		if f.note == nil {
			continue
		}
		info, serr := dst.vault.Stat(f.dst)
		if serr != nil {
			err = serr
			return err
		}
		created := now
		if move {
			created = f.note.CreatedAt
		}
		n := noteRow{mtime: info.ModTime().UnixNano(), Note: Note{
			ID: newID(), Path: f.dst, Title: titleOf(f.dst), Rev: 1, Hash: hashContent(f.content), Size: info.Size(),
			CreatedAt: created, UpdatedAt: now,
		}}
		n.Mtime = n.mtime / 1e6
		if err = insertNote(ctx, tx, &n, string(f.content)); err != nil {
			return err
		}
		if err = recordVersion(ctx, tx, n.ID, n.Rev, string(f.content), n.Hash, actor, now); err != nil {
			return err
		}
		ch := dst.newChange(ctx, "upsert", n.Note)
		if err = recordChange(ctx, tx, &ch); err != nil {
			return err
		}
		changes = append(changes, ch)
		p.res.Notes[ni].ID = n.ID
		ni++
	}
	if err = tHook("indexed"); err != nil {
		return err
	}

	// 4. 移动：源笔记进回收站；失败时恢复已经进回收站的
	var trashed []string
	restore := func() {
		for i := len(trashed) - 1; i >= 0; i-- {
			if _, rerr := src.restoreLocked(ctx, trashed[i]); rerr != nil {
				src.log.Error("撤销传输：恢复源笔记失败", "id", trashed[i], "err", rerr)
			}
		}
	}
	if move {
		for _, n := range p.notes {
			cur, ferr := getByID(ctx, src.db, n.ID)
			if ferr != nil {
				err = ferr
				restore()
				return err
			}
			if _, err = src.deleteLocked(ctx, cur); err != nil {
				restore()
				return err
			}
			trashed = append(trashed, n.ID)
		}
		if err = tHook("trashed"); err != nil {
			restore()
			return err
		}
	}

	// 5. 提交目标库
	if err = tx.Commit(); err != nil {
		txDone = true
		restore()
		return err
	}
	txDone = true
	dst.emit(changes)
	p.res.Trashed = len(trashed)
	if move {
		// 文件夹里剩下的非笔记文件（已经复制过去了）整体进回收站；失败不影响结果，只记日志
		for _, f := range p.srcDirs {
			if rerr := src.removeFolderLocked(ctx, f); rerr != nil {
				src.log.Warn("移动文件夹后清理源文件夹失败", "path", f, "err", rerr)
			}
		}
	}
	a := actor
	src.log.Info("已传输到其他工作空间", "move", move, "items", len(p.res.Items), "notes", len(p.res.Notes),
		"attachments", len(p.res.Attachments), "device_id", a.DeviceID, "device", a.DeviceName)
	return nil
}

// inUnit 判断 u 是否位于 units 里另一个单元（文件夹）之内。
func inUnit(u string, units []string) bool {
	lu := strings.ToLower(u)
	for _, o := range units {
		if o != u && strings.HasPrefix(lu, strings.ToLower(o)+"/") {
			return true
		}
	}
	return false
}

// mkdirTracked 创建目录（含父目录），把新建的各级目录按从外到内的顺序追加到 created，供撤销时删除。
func mkdirTracked(dir string, created []string) ([]string, error) {
	var missing []string
	for d := dir; ; d = filepath.Dir(d) {
		if _, err := os.Lstat(d); err == nil {
			break
		}
		missing = append(missing, d)
		if filepath.Dir(d) == d {
			break
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return created, err
	}
	for i := len(missing) - 1; i >= 0; i-- {
		created = append(created, missing[i])
	}
	return created, nil
}

// renameNoReplace 是暂存区到最终位置的改名，测试里替换它来模拟中途失败。
var renameNoReplace = func(from, to string) error { return os.Rename(from, to) }

func copyRegular(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
