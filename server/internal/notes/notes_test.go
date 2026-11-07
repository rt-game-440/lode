package notes

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/vault"
)

type fixture struct {
	svc  *Service
	root string // vault 根目录
	ctx  context.Context
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	ctx := context.Background()
	d, err := db.Open(ctx, filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	v, err := vault.New(filepath.Join(dir, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	svc := New(Options{DB: d, Vault: v, TrashDir: filepath.Join(dir, "trash")})
	return &fixture{svc: svc, root: v.Root(), ctx: ctx}
}

func (f *fixture) create(t *testing.T, p, content string) NoteContent {
	t.Helper()
	n, err := f.svc.Create(f.ctx, p, content)
	if err != nil {
		t.Fatalf("create %s: %v", p, err)
	}
	return n
}

func (f *fixture) disk(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.root, filepath.FromSlash(p)))
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	return string(b)
}

func (f *fixture) writeDisk(t *testing.T, p, content string) {
	t.Helper()
	abs := filepath.Join(f.root, filepath.FromSlash(p))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func searchPaths(t *testing.T, f *fixture, q string) []string {
	t.Helper()
	res, err := f.svc.Search(f.ctx, SearchQuery{Query: q})
	if err != nil {
		t.Fatalf("search %q: %v", q, err)
	}
	var out []string
	for _, r := range res {
		out = append(out, r.Path)
	}
	return out
}

func TestCreateReadUpdateWritesFileAndBumpsRev(t *testing.T) {
	f := newFixture(t)
	n := f.create(t, "日记/第一篇.md", "你好")
	if n.Rev != 1 || n.Title != "第一篇" {
		t.Fatalf("unexpected note %+v", n.Note)
	}
	if got := f.disk(t, "日记/第一篇.md"); got != "你好" {
		t.Fatalf("disk = %q", got)
	}
	u, err := f.svc.Update(f.ctx, n.ID, 1, "你好，世界")
	if err != nil {
		t.Fatal(err)
	}
	if u.Rev != 2 || f.disk(t, "日记/第一篇.md") != "你好，世界" {
		t.Fatalf("update failed: rev=%d disk=%q", u.Rev, f.disk(t, "日记/第一篇.md"))
	}
	r, err := f.svc.Read(f.ctx, n.ID)
	if err != nil || r.Content != "你好，世界" || r.Rev != 2 {
		t.Fatalf("read = %+v, %v", r, err)
	}
	if _, err := f.svc.Create(f.ctx, "日记/第一篇.md", "x"); !errors.Is(err, ErrExists) {
		t.Fatalf("重复创建应返回 ErrExists，得到 %v", err)
	}
	if _, err := f.svc.Create(f.ctx, "日记/第一篇.MD", "x"); !errors.Is(err, ErrExists) {
		t.Fatalf("仅大小写不同也应视为已存在，得到 %v", err)
	}
}

func TestUpdateWithStaleBaseRevReturnsConflict(t *testing.T) {
	f := newFixture(t)
	n := f.create(t, "a.md", "v1")
	if _, err := f.svc.Update(f.ctx, n.ID, 1, "v2"); err != nil {
		t.Fatal(err)
	}
	_, err := f.svc.Update(f.ctx, n.ID, 1, "来自旧版本的修改")
	var ce *ConflictError
	if !errors.As(err, &ce) || ce.CurrentRev != 2 {
		t.Fatalf("want ConflictError{2}, got %v", err)
	}
	if got := f.disk(t, "a.md"); got != "v2" {
		t.Fatalf("冲突时文件不应被修改，得到 %q", got)
	}
}

func TestPatchRequiresUniqueMatch(t *testing.T) {
	f := newFixture(t)
	n := f.create(t, "p.md", "苹果 香蕉 苹果")
	_, err := f.svc.Patch(f.ctx, n.ID, 1, []Edit{{Old: "苹果", New: "梨"}})
	var pe *PatchError
	if !errors.As(err, &pe) || pe.Matches != 2 {
		t.Fatalf("want PatchError{Matches:2}, got %v", err)
	}
	_, err = f.svc.Patch(f.ctx, n.ID, 1, []Edit{{Old: "西瓜", New: "梨"}})
	if !errors.As(err, &pe) || pe.Matches != 0 {
		t.Fatalf("want PatchError{Matches:0}, got %v", err)
	}
	u, err := f.svc.Patch(f.ctx, n.ID, 1, []Edit{{Old: "香蕉", New: "梨"}})
	if err != nil || u.Content != "苹果 梨 苹果" {
		t.Fatalf("patch = %q, %v", u.Content, err)
	}
}

func TestPathTraversalIsRejected(t *testing.T) {
	f := newFixture(t)
	bad := []string{"../evil.md", "a/../../evil.md", "/etc/passwd.md", `..\evil.md`, "C:/evil.md", ".obsidian/x.md", "a/.hidden.md", ""}
	for _, p := range bad {
		if _, err := f.svc.Create(f.ctx, p, "x"); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("Create(%q) 应拒绝，得到 %v", p, err)
		}
	}
	n := f.create(t, "ok.md", "x")
	if _, err := f.svc.Move(f.ctx, n.ID, "../../outside.md"); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("Move 越界应拒绝，得到 %v", err)
	}
	if _, _, err := f.svc.OpenFile("../app.db"); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("OpenFile 越界应拒绝，得到 %v", err)
	}
	if _, err := f.svc.CreateFolder(f.ctx, "../x"); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("CreateFolder 越界应拒绝，得到 %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(f.root), "evil.md")); err == nil {
		t.Fatal("vault 外出现了文件")
	}
}

func TestChineseSearchShortAndLongQueries(t *testing.T) {
	f := newFixture(t)
	f.create(t, "笔记一.md", "今天学习了全文搜索的实现原理")
	f.create(t, "笔记二.md", "Lode 是一个笔记应用，支持中文")
	f.create(t, "其他.md", "nothing here")

	if got := searchPaths(t, f, "搜索"); len(got) != 1 || got[0] != "笔记一.md" {
		t.Fatalf("2 字查询: %v", got)
	}
	if got := searchPaths(t, f, "全文搜索"); len(got) != 1 || got[0] != "笔记一.md" {
		t.Fatalf("4 字查询: %v", got)
	}
	if got := searchPaths(t, f, "笔记"); len(got) != 2 {
		t.Fatalf("按标题命中: %v", got)
	}
	if got := searchPaths(t, f, "lode 中文"); len(got) != 1 || got[0] != "笔记二.md" {
		t.Fatalf("多词与查询: %v", got)
	}
	res, _ := f.svc.Search(f.ctx, SearchQuery{Query: "全文搜索"})
	if !strings.Contains(res[0].Snippet, "\x02") {
		t.Fatalf("片段应包含高亮标记: %q", res[0].Snippet)
	}
}

func TestMoveUpdatesReferencesAndBacklinks(t *testing.T) {
	f := newFixture(t)
	target := f.create(t, "旧名.md", "我是目标")
	a := f.create(t, "a.md", "见 [[旧名]] 和 [[旧名#小节|别名]]，不要动 `[[旧名]]`")
	b := f.create(t, "dir/b.md", "路径写法 [[旧名.md]]")
	f.create(t, "c.md", "无关 [[别的]]")

	bl, err := f.svc.Backlinks(f.ctx, target.ID)
	if err != nil || len(bl) != 2 {
		t.Fatalf("改名前反链 = %+v, %v", bl, err)
	}

	res, err := f.svc.Move(f.ctx, target.ID, "文件夹/新名.md")
	if err != nil {
		t.Fatal(err)
	}
	if res.Note.ID != target.ID || res.Note.Path != "文件夹/新名.md" {
		t.Fatalf("move 结果 %+v", res.Note)
	}
	if len(res.Updated) != 2 {
		t.Fatalf("应改写 2 篇笔记，实际 %d", len(res.Updated))
	}
	if got := f.disk(t, "a.md"); got != "见 [[新名]] 和 [[新名#小节|别名]]，不要动 `[[旧名]]`" {
		t.Fatalf("a.md = %q", got)
	}
	if got := f.disk(t, "dir/b.md"); got != "路径写法 [[新名.md]]" {
		t.Fatalf("dir/b.md = %q", got)
	}
	if _, err := os.Stat(filepath.Join(f.root, "旧名.md")); err == nil {
		t.Fatal("旧文件应已不存在")
	}

	bl, err = f.svc.Backlinks(f.ctx, target.ID)
	if err != nil || len(bl) != 2 {
		t.Fatalf("改名后反链 = %+v, %v", bl, err)
	}
	ids := map[string]bool{bl[0].ID: true, bl[1].ID: true}
	if !ids[a.ID] || !ids[b.ID] {
		t.Fatalf("反链来源不对: %+v", bl)
	}
	if bl[0].Lines[0].Text == "" {
		t.Fatal("反链应带上下文")
	}
}

func TestMoveUsesFullPathWhenNewNameIsAmbiguous(t *testing.T) {
	f := newFixture(t)
	target := f.create(t, "x/甲.md", "目标")
	f.create(t, "y/乙.md", "同名的另一篇")
	src := f.create(t, "src.md", "[[甲]]")
	if _, err := f.svc.Move(f.ctx, target.ID, "x/乙.md"); err != nil {
		t.Fatal(err)
	}
	if got := f.disk(t, "src.md"); got != "[[x/乙]]" {
		t.Fatalf("新名称有歧义时应写完整路径，得到 %q", got)
	}
	bl, _ := f.svc.Backlinks(f.ctx, target.ID)
	if len(bl) != 1 || bl[0].ID != src.ID {
		t.Fatalf("反链 = %+v", bl)
	}
}

func TestExternalRenameKeepsID(t *testing.T) {
	f := newFixture(t)
	n := f.create(t, "外部/原名.md", "内容不变")
	if err := os.MkdirAll(filepath.Join(f.root, "外部", "新目录"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(f.root, "外部", "原名.md"), filepath.Join(f.root, "外部", "新目录", "改名后.md")); err != nil {
		t.Fatal(err)
	}
	st, err := f.svc.Reconcile(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Moved != 1 || st.Added != 0 || st.Removed != 0 {
		t.Fatalf("stats = %+v", st)
	}
	got, err := f.svc.Get(f.ctx, n.ID)
	if err != nil || got.Path != "外部/新目录/改名后.md" {
		t.Fatalf("改名后 id 应保留: %+v, %v", got, err)
	}
}

func TestReconcilePicksUpExternalChanges(t *testing.T) {
	f := newFixture(t)
	f.writeDisk(t, "外部新建.md", "外部写入的独特内容")
	f.writeDisk(t, ".obsidian/workspace.md", "应被忽略")
	f.writeDisk(t, "attachments/图.png", "png")
	st, err := f.svc.Reconcile(f.ctx)
	if err != nil || st.Added != 1 {
		t.Fatalf("stats = %+v, %v", st, err)
	}
	tree, _ := f.svc.Tree(f.ctx)
	if len(tree.Notes) != 1 || tree.Notes[0].Path != "外部新建.md" {
		t.Fatalf("tree = %+v", tree.Notes)
	}
	// 修改与删除
	time.Sleep(10 * time.Millisecond)
	f.writeDisk(t, "外部新建.md", "改过的内容")
	st, _ = f.svc.Reconcile(f.ctx)
	if st.Updated != 1 {
		t.Fatalf("修改应被识别: %+v", st)
	}
	if got := searchPaths(t, f, "改过的"); len(got) != 1 {
		t.Fatalf("修改后应可搜到: %v", got)
	}
	os.Remove(filepath.Join(f.root, "外部新建.md"))
	st, _ = f.svc.Reconcile(f.ctx)
	if st.Removed != 1 {
		t.Fatalf("删除应被识别: %+v", st)
	}
}

func TestWatcherReflectsExternalEditsWithinTwoSeconds(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	done := make(chan struct{})
	ready := make(chan struct{})
	go func() {
		defer close(done)
		_ = f.svc.Watch(ctx, 150*time.Millisecond, func() { close(ready) })
	}()
	defer func() { cancel(); <-done }()
	<-ready

	f.writeDisk(t, "监听/新文件.md", "监听测试独特词")
	deadline := time.Now().Add(2 * time.Second)
	for {
		if got := searchPaths(t, f, "监听测试独特词"); len(got) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("2 秒内没有反映到搜索结果")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestDeleteAndRestoreKeepsID(t *testing.T) {
	f := newFixture(t)
	n := f.create(t, "待删.md", "回收站内容")
	if _, err := f.svc.Delete(f.ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.root, "待删.md")); err == nil {
		t.Fatal("删除后文件应移出 vault")
	}
	items, _ := f.svc.ListTrash(f.ctx)
	if len(items) != 1 || items[0].ID != n.ID {
		t.Fatalf("trash = %+v", items)
	}
	if got := searchPaths(t, f, "回收站内容"); len(got) != 0 {
		t.Fatalf("删除后不应搜到: %v", got)
	}
	r, err := f.svc.Restore(f.ctx, n.ID)
	if err != nil || r.ID != n.ID || r.Path != "待删.md" {
		t.Fatalf("restore = %+v, %v", r, err)
	}
	if f.disk(t, "待删.md") != "回收站内容" {
		t.Fatal("恢复后内容不一致")
	}
}

func TestTagsAndFolders(t *testing.T) {
	f := newFixture(t)
	f.create(t, "t1.md", "#项目/lode 和 #想法")
	f.create(t, "t2.md", "#项目")
	tags, _ := f.svc.Tags(f.ctx)
	if len(tags) != 3 {
		t.Fatalf("tags = %+v", tags)
	}
	ns, _ := f.svc.NotesByTag(f.ctx, "#项目")
	if len(ns) != 2 {
		t.Fatalf("按父标签应包含子标签: %+v", ns)
	}
	if _, err := f.svc.CreateFolder(f.ctx, "空/文件夹"); err != nil {
		t.Fatal(err)
	}
	n := f.create(t, "空/文件夹/x.md", "[[y]]")
	f.create(t, "y.md", "被 [[空/文件夹/x]] 引用")
	if _, err := f.svc.MoveFolder(f.ctx, "空", "满"); err != nil {
		t.Fatal(err)
	}
	got, _ := f.svc.Get(f.ctx, n.ID)
	if got.Path != "满/文件夹/x.md" {
		t.Fatalf("移动文件夹后路径 = %s", got.Path)
	}
	if f.disk(t, "y.md") != "被 [[满/文件夹/x]] 引用" {
		t.Fatalf("文件夹移动应更新路径式链接: %q", f.disk(t, "y.md"))
	}
	tree, _ := f.svc.Tree(f.ctx)
	if strings.Join(tree.Folders, ",") != "满,满/文件夹" {
		t.Fatalf("folders = %v", tree.Folders)
	}
	if _, err := f.svc.DeleteFolder(f.ctx, "满"); err != nil {
		t.Fatal(err)
	}
	items, _ := f.svc.ListTrash(f.ctx)
	if len(items) != 1 {
		t.Fatalf("删除文件夹后其中笔记应进回收站: %+v", items)
	}
}

func TestSearchTitleOnlyHitStillHasSnippet(t *testing.T) {
	f := newFixture(t)
	f.create(t, "季度计划草稿.md", "第一行正文内容\n第二行")
	for _, q := range []string{"季度计划", "季度"} {
		res, err := f.svc.Search(f.ctx, SearchQuery{Query: q})
		if err != nil || len(res) != 1 {
			t.Fatalf("%q: %v %v", q, res, err)
		}
		if !strings.Contains(res[0].Snippet, "第一行正文") {
			t.Errorf("%q 只命中标题时应返回正文开头作为摘要，得到 %q", q, res[0].Snippet)
		}
	}
}
