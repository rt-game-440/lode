package ops

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/rt-game-440/lode/server/internal/agent"
	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/llm"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/vault"
	"github.com/rt-game-440/lode/server/internal/workspace"
)

// #62：多工作空间备份恢复。

// site 是一个打开着的数据目录：app.db、默认工作空间和 workspace.Manager。
type site struct {
	t     *testing.T
	dir   string
	d     *sql.DB
	mgr   *workspace.Manager
	store *agent.Store
}

func openSite(t *testing.T, dir string) *site {
	t.Helper()
	ctx := context.Background()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	d, err := db.Open(ctx, filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	v, err := vault.New(filepath.Join(dir, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	def := notes.New(notes.Options{DB: d, Vault: v, TrashDir: filepath.Join(dir, "trash"), Logger: quiet})
	s := &site{t: t, dir: dir, d: d, store: agent.NewStore(d, nil),
		mgr: workspace.New(workspace.Options{Default: def, DB: d, DataDir: dir, Logger: quiet})}
	t.Cleanup(s.close)
	return s
}

func (s *site) close() {
	if s.mgr != nil {
		s.mgr.Close()
		s.d.Close()
		s.mgr = nil
	}
}

// notesOf 返回工作空间的笔记服务和对话库。
func (s *site) notesOf(id string) (*notes.Service, *agent.ChatStore) {
	s.t.Helper()
	w, err := s.mgr.Get(context.Background(), id)
	if err != nil {
		s.t.Fatalf("打开工作空间 %s: %v", id, err)
	}
	if id == workspace.DefaultID {
		return w.Notes, s.store.DefaultChats()
	}
	return w.Notes, w.Chats
}

func (s *site) create(name, vaultDir string) string {
	s.t.Helper()
	in, err := s.mgr.Create(context.Background(), workspace.CreateOptions{Name: name, VaultDir: vaultDir})
	if err != nil {
		s.t.Fatal(err)
	}
	return in.ID
}

func (s *site) paths(id string) workspace.Paths {
	s.t.Helper()
	in, err := s.mgr.Info(context.Background(), id)
	if err != nil {
		s.t.Fatal(err)
	}
	return workspace.PathsFor(s.dir, id, in.VaultDir)
}

// populate 在工作空间里放一篇笔记（改过一次，有历史版本）、一个附件、一篇回收站里的笔记和一个有消息的对话。
func (s *site) populate(id, tag string) {
	s.t.Helper()
	ctx := context.Background()
	svc, chats := s.notesOf(id)
	n, err := svc.Create(ctx, "日记/"+tag+".md", "# "+tag+"\n\n正文 "+tag+" 初稿\n")
	if err != nil {
		s.t.Fatal(err)
	}
	if _, err := svc.Update(ctx, n.ID, n.Rev, "# "+tag+"\n\n正文 "+tag+" 终稿\n"); err != nil {
		s.t.Fatal(err)
	}
	gone, err := svc.Create(ctx, "回收/"+tag+".md", "要删除的 "+tag+"\n")
	if err != nil {
		s.t.Fatal(err)
	}
	if _, err := svc.Delete(ctx, gone.ID); err != nil {
		s.t.Fatal(err)
	}
	if _, err := svc.SaveAttachment(ctx, tag+".png", bytes.NewReader([]byte("PNG-"+tag)), 1<<20); err != nil {
		s.t.Fatal(err)
	}
	c, err := chats.CreateChat(ctx, "")
	if err != nil {
		s.t.Fatal(err)
	}
	if _, err := chats.AddMessage(ctx, c.ID, agent.Message{Role: llm.RoleUser, Parts: []llm.Part{{Type: llm.PartText, Text: "对话 " + tag}}}); err != nil {
		s.t.Fatal(err)
	}
}

// verify 检查 populate 放进去的东西都在：笔记内容、全文索引、历史版本、附件、回收站、对话。
func (s *site) verify(id, tag string) {
	s.t.Helper()
	ctx := context.Background()
	svc, chats := s.notesOf(id)
	n, err := svc.ReadByPath(ctx, "日记/"+tag+".md")
	if err != nil || n.Content != "# "+tag+"\n\n正文 "+tag+" 终稿\n" {
		s.t.Errorf("[%s] 笔记：%+v %v", id, n, err)
	}
	if res, err := svc.Search(ctx, notes.SearchQuery{Query: "终稿 " + tag}); err != nil || len(res) == 0 {
		s.t.Errorf("[%s] 全文索引：%v %v", id, res, err)
	}
	p := s.paths(id)
	if !s.hasAttachment(p.Vault, tag) {
		s.t.Errorf("[%s] 附件丢失", id)
	}
	items, err := svc.ListTrash(ctx)
	if err != nil || len(items) != 1 || items[0].Path != "回收/"+tag+".md" {
		s.t.Errorf("[%s] 回收站：%+v %v", id, items, err)
	}
	if files, _ := os.ReadDir(p.Trash); len(files) != 1 {
		s.t.Errorf("[%s] 回收站文件：%d 个", id, len(files))
	}
	cs, err := chats.Chats(ctx, 10)
	if err != nil || len(cs) != 1 {
		s.t.Fatalf("[%s] 对话：%v %v", id, cs, err)
	}
	if ms, err := chats.Messages(ctx, cs[0].ID); err != nil || len(ms) != 1 || ms[0].Parts[0].Text != "对话 "+tag {
		s.t.Errorf("[%s] 消息：%+v %v", id, ms, err)
	}
	if v := s.count(id, "versions"); v < 2 {
		s.t.Errorf("[%s] 历史版本 %d 条，应不少于 2", id, v)
	}
}

// hasAttachment 在 vault 里找文件名以 tag.png 结尾的附件（附件会放在带日期的子目录里）。
func (s *site) hasAttachment(root, tag string) bool {
	found := false
	filepath.WalkDir(root, func(p string, e os.DirEntry, err error) error {
		if err == nil && !e.IsDir() && strings.HasSuffix(p, tag+".png") {
			if b, _ := os.ReadFile(p); string(b) == "PNG-"+tag {
				found = true
			}
		}
		return nil
	})
	return found
}

// count 数工作空间索引库里某张表的行数。
func (s *site) count(id, table string) int {
	s.t.Helper()
	var n int
	d := s.d
	if id != workspace.DefaultID {
		var err error
		d, err = openRO(s.paths(id).Index)
		if err != nil {
			s.t.Fatal(err)
		}
		defer d.Close()
	}
	if err := d.QueryRow(`SELECT count(*) FROM ` + table).Scan(&n); err != nil {
		s.t.Fatal(err)
	}
	return n
}

// fixture 是 默认空间 + 内置空间 + 外部空间 都有数据的站点，已备份。
type fixture struct {
	dir, ext, archive string
	builtin, external string
}

func makeFixture(t *testing.T, opts ...BackupOptions) fixture {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	f := fixture{dir: filepath.Join(root, "data"), ext: filepath.Join(root, "obsidian"), archive: filepath.Join(root, "b.tar.gz")}
	if err := os.MkdirAll(filepath.Join(f.ext, ".obsidian"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(f.ext, ".obsidian", "app.json"), []byte(`{"theme":"dark"}`), 0o644)
	os.WriteFile(filepath.Join(f.ext, "原有.md"), []byte("外部库里原有的笔记\n"), 0o644)
	s := openSite(t, f.dir)
	f.builtin = s.create("内置", "")
	f.external = s.create("外部库", f.ext)
	s.populate(workspace.DefaultID, "默认")
	s.populate(f.builtin, "内置")
	s.populate(f.external, "外部")
	if err := auth.New(s.d).Setup(ctx, "correct-horse"); err != nil {
		t.Fatal(err)
	}
	if err := Backup(ctx, s.d, f.dir, f.archive, opts...); err != nil { // 服务（数据库）仍然打开着
		t.Fatal(err)
	}
	s.close()
	return f
}

// 列出备份里的条目名。
func archiveNames(t *testing.T, archive string) []string {
	t.Helper()
	fh, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer fh.Close()
	gz, err := gzip.NewReader(fh)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	var names []string
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return names
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, h.Name)
	}
}

func hasName(names []string, prefix string) bool {
	for _, n := range names {
		if n == prefix || strings.HasPrefix(n, prefix) {
			return true
		}
	}
	return false
}

// 默认空间 + 内置空间 + 外部空间各有笔记、附件、回收站和对话：备份 → 清空数据目录和外部目录 → 恢复后全部完整。
func TestBackupRestoreAllWorkspaces(t *testing.T) {
	ctx := context.Background()
	f := makeFixture(t)

	m, err := ReadManifest(f.archive)
	if err != nil {
		t.Fatal(err)
	}
	if m.Format != 2 || m.ScopeOrAll() != ScopeAll || len(m.Workspaces) != 3 {
		t.Fatalf("清单：%+v", m)
	}
	var ext *WorkspaceEntry
	for i, e := range m.Workspaces {
		if e.ID == f.external {
			ext = &m.Workspaces[i]
		}
	}
	if ext == nil || !ext.External || !workspace.SamePath(ext.VaultDir, f.ext) {
		t.Fatalf("清单里应记下外部目录的原路径 %s：%+v", f.ext, m.Workspaces)
	}
	names := archiveNames(t, f.archive)
	for _, want := range []string{"app.db", "vault/", "trash/", "workspaces/" + f.builtin + "/index.db", "workspaces/" + f.builtin + "/vault/",
		"workspaces/" + f.external + "/index.db", "workspaces/" + f.external + "/vault/.obsidian/app.json", "workspaces/" + f.external + "/vault/原有.md"} {
		if !hasName(names, want) {
			t.Errorf("备份里缺少 %s", want)
		}
	}

	if err := os.RemoveAll(f.dir); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(f.ext); err != nil {
		t.Fatal(err)
	}
	res, err := RestoreArchive(ctx, f.dir, f.archive, RestoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Kept != "" || res.Scope != ScopeAll {
		t.Errorf("没有原有数据时不应有 pre-restore：%+v", res)
	}

	if b, err := os.ReadFile(filepath.Join(f.ext, ".obsidian", "app.json")); err != nil || string(b) != `{"theme":"dark"}` {
		t.Errorf("外部目录里非笔记文件应恢复到原路径：%q %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "workspaces", f.external, "vault")); !os.IsNotExist(err) {
		t.Errorf("外部笔记不应留在数据目录里：%v", err)
	}
	s := openSite(t, f.dir)
	list, err := s.mgr.List(ctx)
	if err != nil || len(list) != 3 {
		t.Fatalf("工作空间：%+v %v", list, err)
	}
	for _, in := range list {
		if in.ID == f.external && (!in.External || !workspace.SamePath(in.VaultDir, f.ext)) {
			t.Errorf("外部空间的登记：%+v", in)
		}
	}
	if n, err := s.mgr.Default().Notes.NoteCount(ctx); err != nil || n != 1 {
		t.Errorf("默认空间笔记数 %d %v", n, err)
	}
	s.verify(workspace.DefaultID, "默认")
	s.verify(f.builtin, "内置")
	s.verify(f.external, "外部")
	if b, err := os.ReadFile(filepath.Join(f.ext, "原有.md")); err != nil || string(b) != "外部库里原有的笔记\n" {
		t.Errorf("外部库原有笔记：%q %v", b, err)
	}
	if err := auth.New(s.d).CheckPassword(ctx, "correct-horse"); err != nil {
		t.Errorf("登录密码：%v", err)
	}
}

// 恢复到有数据的数据目录：现有的内置工作空间目录、默认数据连同旧登记一起移到 pre-restore；不在备份里的外部目录不动。
func TestRestoreAllKeepsExistingData(t *testing.T) {
	ctx := context.Background()
	f := makeFixture(t)
	other := filepath.Join(t.TempDir(), "other-ext")
	os.MkdirAll(other, 0o755)
	os.WriteFile(filepath.Join(other, "我的.md"), []byte("别动\n"), 0o644)
	// 现有数据目录里另有一个内置空间和一个外部空间
	os.RemoveAll(f.ext)
	s := openSite(t, f.dir)
	late := s.create("备份之后", "")
	lateExt := s.create("备份之后的外部", other)
	_ = lateExt
	s.close()

	res, err := RestoreArchive(ctx, f.dir, f.archive, RestoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Kept == "" {
		t.Fatal("应保留原有数据")
	}
	if _, err := os.Stat(filepath.Join(res.Kept, "workspaces", late)); err != nil {
		t.Errorf("现有的内置空间目录应移到 pre-restore：%v", err)
	}
	if b, err := os.ReadFile(filepath.Join(other, "我的.md")); err != nil || string(b) != "别动\n" {
		t.Errorf("不在备份里的外部目录不应被改动：%q %v", b, err)
	}
	r := openSite(t, f.dir)
	list, _ := r.mgr.List(ctx)
	if len(list) != 3 {
		t.Errorf("恢复后应是备份里的 3 个工作空间：%+v", list)
	}
	r.verify(f.external, "外部")
}

// 外部原路径非空时拒绝恢复，数据目录不被改动；指定 --external-to 后恢复到新位置，登记路径随之更新。
func TestRestoreExternalNonEmptyAndExternalTo(t *testing.T) {
	ctx := context.Background()
	f := makeFixture(t)
	if err := os.RemoveAll(f.dir); err != nil { // 数据目录没了，但外部目录还在（非空）
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(f.ext, "新写的.md"), []byte("别覆盖\n"), 0o644)

	_, err := RestoreArchive(ctx, f.dir, f.archive, RestoreOptions{})
	if !errors.Is(err, ErrExternalNotEmpty) {
		t.Fatalf("应返回 ErrExternalNotEmpty：%v", err)
	}
	if !strings.Contains(err.Error(), "--external-to") || !strings.Contains(err.Error(), f.ext) {
		t.Errorf("错误信息应提示 --external-to 和路径：%v", err)
	}
	for _, name := range []string{"app.db", "vault", "workspaces"} {
		if _, err := os.Stat(filepath.Join(f.dir, name)); !os.IsNotExist(err) {
			t.Errorf("拒绝恢复时不应改动数据目录，却有 %s：%v", name, err)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(f.ext, "新写的.md")); string(b) != "别覆盖\n" {
		t.Error("外部目录里的文件不应被动")
	}

	newRoot := filepath.Join(t.TempDir(), "restored")
	res, err := RestoreArchive(ctx, f.dir, f.archive, RestoreOptions{ExternalTo: newRoot})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(newRoot, f.external)
	for _, e := range res.Workspaces {
		if e.ID == f.external && !workspace.SamePath(e.VaultDir, want) {
			t.Errorf("结果里的位置 %s，应为 %s", e.VaultDir, want)
		}
	}
	if b, err := os.ReadFile(filepath.Join(want, ".obsidian", "app.json")); err != nil || string(b) != `{"theme":"dark"}` {
		t.Errorf("新位置里应有恢复的文件：%q %v", b, err)
	}
	s := openSite(t, f.dir)
	in, err := s.mgr.Info(ctx, f.external)
	if err != nil || !in.External || !workspace.SamePath(in.VaultDir, want) {
		t.Fatalf("登记的路径应更新为 %s：%+v %v", want, in, err)
	}
	s.verify(f.external, "外部")
	s.verify(workspace.DefaultID, "默认")
}

// 原路径是空目录时可以直接恢复进去；--external-to 不是绝对路径、备份里没有外部目录时拒绝。
func TestRestoreExternalIntoEmptyDirAndBadExternalTo(t *testing.T) {
	ctx := context.Background()
	f := makeFixture(t)
	os.RemoveAll(f.dir)
	if _, err := RestoreArchive(ctx, f.dir, f.archive, RestoreOptions{ExternalTo: "相对/路径"}); err == nil {
		t.Error("--external-to 必须是绝对路径")
	}
	os.RemoveAll(f.ext)
	os.MkdirAll(f.ext, 0o755) // 空目录
	if _, err := RestoreArchive(ctx, f.dir, f.archive, RestoreOptions{}); err != nil {
		t.Fatalf("空目录应可恢复进去：%v", err)
	}
	if _, err := os.Stat(filepath.Join(f.ext, "原有.md")); err != nil {
		t.Error(err)
	}

	// 没有外部空间的备份：--external-to 无意义
	root := t.TempDir()
	dir := filepath.Join(root, "d")
	s := openSite(t, dir)
	s.populate(workspace.DefaultID, "默认")
	arc := filepath.Join(root, "x.tar.gz")
	if err := Backup(ctx, s.d, dir, arc); err != nil {
		t.Fatal(err)
	}
	s.close()
	if _, err := RestoreArchive(ctx, filepath.Join(root, "d2"), arc, RestoreOptions{ExternalTo: filepath.Join(root, "x")}); err == nil || !strings.Contains(err.Error(), "--external-to") {
		t.Errorf("没有外部目录时 --external-to 应报错：%v", err)
	}
}

// 登记的外部目录消失（卷没挂载）时，完整备份失败而不是悄悄打出缺了笔记的备份。
func TestBackupFailsWhenExternalVaultMissing(t *testing.T) {
	ctx := context.Background()
	f := makeFixture(t)
	s := openSite(t, f.dir)
	defer s.close()
	os.RemoveAll(f.ext)
	err := Backup(ctx, s.d, f.dir, filepath.Join(t.TempDir(), "x.tar.gz"))
	if err == nil || !strings.Contains(err.Error(), "不存在或不可用") {
		t.Fatalf("应因外部目录不可用而失败：%v", err)
	}
	// 只备份其他空间仍可进行
	if err := Backup(ctx, s.d, f.dir, filepath.Join(t.TempDir(), "y.tar.gz"), BackupOptions{Workspace: f.builtin}); err != nil {
		t.Errorf("单空间备份不应受影响：%v", err)
	}
}

// 阶段 6 格式（format 1，没有工作空间信息）的备份恢复成功，只有默认空间；现有的其他工作空间登记被替换掉。
func TestRestoreStage6FormatBackup(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	src := filepath.Join(root, "src")
	s := openSite(t, src)
	s.populate(workspace.DefaultID, "默认")
	snap := filepath.Join(root, "snap.db")
	if err := db.Snapshot(ctx, s.d, snap); err != nil {
		t.Fatal(err)
	}
	s.close()
	dbBytes, err := os.ReadFile(snap)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{manifestName: `{"format":1,"version":"v0.6.0","db_version":6,"created_at":"2026-11-01T00:00:00Z"}`, dbName: string(dbBytes)}
	filepath.WalkDir(filepath.Join(src, "vault"), func(p string, e os.DirEntry, err error) error {
		if err == nil && !e.IsDir() {
			b, _ := os.ReadFile(p)
			rel, _ := filepath.Rel(src, p)
			files[filepath.ToSlash(rel)] = string(b)
		}
		return nil
	})
	filepath.WalkDir(filepath.Join(src, "trash"), func(p string, e os.DirEntry, err error) error {
		if err == nil && !e.IsDir() {
			b, _ := os.ReadFile(p)
			rel, _ := filepath.Rel(src, p)
			files[filepath.ToSlash(rel)] = string(b)
		}
		return nil
	})
	v1 := filepath.Join(root, "v1.tar.gz")
	writeTestArchive(t, v1, files)

	// 目标数据目录里已有另一个内置空间
	dst := filepath.Join(root, "dst")
	d := openSite(t, dst)
	extra := d.create("多余", "")
	d.close()
	res, err := RestoreArchive(ctx, dst, v1, RestoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Workspaces) != 1 || res.Workspaces[0].ID != workspace.DefaultID {
		t.Errorf("旧格式备份应只有默认空间：%+v", res.Workspaces)
	}
	if _, err := os.Stat(filepath.Join(res.Kept, "workspaces", extra)); err != nil {
		t.Errorf("现有的 workspaces/ 应移到 pre-restore：%v", err)
	}
	r := openSite(t, dst)
	list, err := r.mgr.List(ctx)
	if err != nil || len(list) != 1 || list[0].ID != workspace.DefaultID {
		t.Fatalf("恢复后只应有默认空间：%+v %v", list, err)
	}
	r.verify(workspace.DefaultID, "默认")
}

// --workspace <id> 只包含该空间（没有 app.db、secret.key、其他空间）；恢复这种备份时不影响其他空间和全局数据。
func TestSingleWorkspaceBackupAndRestore(t *testing.T) {
	ctx := context.Background()
	f := makeFixture(t)
	root := filepath.Dir(f.dir)

	// 恢复完整备份得到起点，再对内置空间做单空间备份
	os.RemoveAll(f.dir)
	os.RemoveAll(f.ext)
	if _, err := RestoreArchive(ctx, f.dir, f.archive, RestoreOptions{}); err != nil {
		t.Fatal(err)
	}
	s := openSite(t, f.dir)
	arc := filepath.Join(root, "one.tar.gz")
	if err := Backup(ctx, s.d, f.dir, arc, BackupOptions{Workspace: f.builtin}); err != nil {
		t.Fatal(err)
	}
	names := archiveNames(t, arc)
	for _, n := range names {
		if n == "app.db" || n == "secret.key" || strings.HasPrefix(n, "vault") || strings.HasPrefix(n, "trash") ||
			(strings.HasPrefix(n, "workspaces/"+f.external) || strings.HasPrefix(n, "workspaces/"+f.builtin+"x")) {
			t.Errorf("单空间备份不应包含 %s", n)
		}
	}
	if !hasName(names, "workspaces/"+f.builtin+"/index.db") || !hasName(names, "workspaces/"+f.builtin+"/vault/") {
		t.Errorf("单空间备份应包含该空间：%v", names)
	}
	m, _ := ReadManifest(arc)
	if m.ScopeOrAll() != ScopeWorkspace || len(m.Workspaces) != 1 || m.Workspaces[0].ID != f.builtin {
		t.Errorf("清单：%+v", m)
	}
	if err := Backup(ctx, s.d, f.dir, filepath.Join(root, "nope.tar.gz"), BackupOptions{Workspace: "nosuch"}); !errors.Is(err, ErrWorkspaceNotFound) {
		t.Errorf("不存在的工作空间：%v", err)
	}

	// 备份之后：内置空间被改乱，其他空间和全局数据也有新变化
	svc, _ := s.notesOf(f.builtin)
	n, _ := svc.ReadByPath(ctx, "日记/内置.md")
	if _, err := svc.Update(ctx, n.ID, n.Rev, "被改乱了\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(ctx, "备份之后.md", "x\n"); err != nil {
		t.Fatal(err)
	}
	dsvc, _ := s.notesOf(workspace.DefaultID)
	if _, err := dsvc.Create(ctx, "默认新.md", "默认空间备份之后的笔记\n"); err != nil {
		t.Fatal(err)
	}
	esvc, _ := s.notesOf(f.external)
	if _, err := esvc.Create(ctx, "外部新.md", "外部空间备份之后的笔记\n"); err != nil {
		t.Fatal(err)
	}
	if err := auth.New(s.d).SetPassword(ctx, "another-password"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.mgr.Rename(ctx, f.builtin, "改名了"); err != nil {
		t.Fatal(err)
	}
	s.close()

	res, err := RestoreArchive(ctx, f.dir, arc, RestoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Scope != ScopeWorkspace || res.Kept == "" {
		t.Errorf("结果：%+v", res)
	}
	if _, err := os.Stat(filepath.Join(res.Kept, "workspaces", f.builtin, "vault", "备份之后.md")); err != nil {
		t.Errorf("被替换的内容应保留在 pre-restore：%v", err)
	}
	r := openSite(t, f.dir)
	r.verify(f.builtin, "内置")
	if _, err := os.Stat(filepath.Join(r.paths(f.builtin).Vault, "备份之后.md")); !os.IsNotExist(err) {
		t.Errorf("内置空间应回到备份时：%v", err)
	}
	// 其他空间和全局数据不受影响
	if svc, _ := r.notesOf(workspace.DefaultID); svc != nil {
		if _, err := svc.ReadByPath(ctx, "默认新.md"); err != nil {
			t.Errorf("默认空间不应受影响：%v", err)
		}
	}
	if svc, _ := r.notesOf(f.external); svc != nil {
		if _, err := svc.ReadByPath(ctx, "外部新.md"); err != nil {
			t.Errorf("外部空间不应受影响：%v", err)
		}
	}
	if _, err := os.Stat(filepath.Join(f.ext, "外部新.md")); err != nil {
		t.Errorf("外部目录不应受影响：%v", err)
	}
	if err := auth.New(r.d).CheckPassword(ctx, "another-password"); err != nil {
		t.Errorf("全局数据（密码）不应回退：%v", err)
	}
	in, err := r.mgr.Info(ctx, f.builtin)
	if err != nil || in.Name != "改名了" {
		t.Errorf("已登记空间的名称沿用现在的登记：%+v %v", in, err)
	}
	list, _ := r.mgr.List(ctx)
	if len(list) != 3 {
		t.Errorf("登记的工作空间数应不变：%+v", list)
	}
}

// 单空间备份恢复到没有登记它的数据目录（空间已被删除）：重新登记，排在最后。
func TestSingleWorkspaceRestoreRegistersMissing(t *testing.T) {
	ctx := context.Background()
	f := makeFixture(t)
	os.RemoveAll(f.dir)
	os.RemoveAll(f.ext)
	if _, err := RestoreArchive(ctx, f.dir, f.archive, RestoreOptions{}); err != nil {
		t.Fatal(err)
	}
	s := openSite(t, f.dir)
	arc := filepath.Join(t.TempDir(), "one.tar.gz")
	if err := Backup(ctx, s.d, f.dir, arc, BackupOptions{Workspace: f.builtin}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.mgr.Remove(ctx, f.builtin); err != nil {
		t.Fatal(err)
	}
	s.close()

	if _, err := RestoreArchive(ctx, f.dir, arc, RestoreOptions{}); err != nil {
		t.Fatal(err)
	}
	r := openSite(t, f.dir)
	list, _ := r.mgr.List(ctx)
	if len(list) != 3 || list[len(list)-1].ID != f.builtin || list[len(list)-1].Name != "内置" {
		t.Fatalf("应重新登记在最后：%+v", list)
	}
	r.verify(f.builtin, "内置")

	// 没有数据库的数据目录不能恢复单空间备份
	if _, err := RestoreArchive(ctx, filepath.Join(t.TempDir(), "empty"), arc, RestoreOptions{}); err == nil {
		t.Error("没有数据库的数据目录不应接受单空间备份")
	}
}

// 单个外部空间的备份：沿用现在登记的路径，非空时拒绝，--external-to 恢复到新位置并更新登记。
func TestSingleExternalWorkspaceRestore(t *testing.T) {
	ctx := context.Background()
	f := makeFixture(t)
	os.RemoveAll(f.dir)
	os.RemoveAll(f.ext)
	if _, err := RestoreArchive(ctx, f.dir, f.archive, RestoreOptions{}); err != nil {
		t.Fatal(err)
	}
	s := openSite(t, f.dir)
	arc := filepath.Join(t.TempDir(), "ext.tar.gz")
	if err := Backup(ctx, s.d, f.dir, arc, BackupOptions{Workspace: f.external}); err != nil {
		t.Fatal(err)
	}
	s.close()

	// 外部目录还在且非空：拒绝
	if _, err := RestoreArchive(ctx, f.dir, arc, RestoreOptions{}); !errors.Is(err, ErrExternalNotEmpty) {
		t.Fatalf("应拒绝：%v", err)
	}
	// 清空后原地恢复
	os.RemoveAll(f.ext)
	if _, err := RestoreArchive(ctx, f.dir, arc, RestoreOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.ext, ".obsidian", "app.json")); err != nil {
		t.Error(err)
	}
	// 再恢复到新位置
	newRoot := filepath.Join(t.TempDir(), "elsewhere")
	if _, err := RestoreArchive(ctx, f.dir, arc, RestoreOptions{ExternalTo: newRoot}); err != nil {
		t.Fatal(err)
	}
	r := openSite(t, f.dir)
	in, err := r.mgr.Info(ctx, f.external)
	if err != nil || !workspace.SamePath(in.VaultDir, filepath.Join(newRoot, f.external)) {
		t.Fatalf("登记的路径：%+v %v", in, err)
	}
	r.verify(f.external, "外部")
}

// 单空间备份恢复默认工作空间：只替换笔记索引、历史、变更、回收站和对话，不动密码、token、助手配置、其他空间的登记。
func TestSingleDefaultWorkspaceRestore(t *testing.T) {
	ctx := context.Background()
	f := makeFixture(t)
	os.RemoveAll(f.dir)
	os.RemoveAll(f.ext)
	if _, err := RestoreArchive(ctx, f.dir, f.archive, RestoreOptions{}); err != nil {
		t.Fatal(err)
	}
	s := openSite(t, f.dir)
	arc := filepath.Join(t.TempDir(), "def.tar.gz")
	if err := Backup(ctx, s.d, f.dir, arc, BackupOptions{Workspace: workspace.DefaultID}); err != nil {
		t.Fatal(err)
	}
	names := archiveNames(t, arc)
	if !hasName(names, "app.db") || !hasName(names, "vault/") || hasName(names, "workspaces") || hasName(names, "secret.key") {
		t.Errorf("默认空间的单空间备份内容：%v", names)
	}
	before := s.count(workspace.DefaultID, "changes")
	dsvc, dchats := s.notesOf(workspace.DefaultID)
	dsvc.Create(ctx, "之后.md", "备份之后\n")
	c, _ := dchats.CreateChat(ctx, "")
	dchats.AddMessage(ctx, c.ID, agent.Message{Role: llm.RoleUser, Parts: []llm.Part{{Type: llm.PartText, Text: "之后的对话"}}})
	n, _ := dsvc.ReadByPath(ctx, "日记/默认.md")
	dsvc.Update(ctx, n.ID, n.Rev, "改乱了\n")
	if err := auth.New(s.d).SetPassword(ctx, "new-password-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.mgr.Rename(ctx, f.builtin, "改名"); err != nil {
		t.Fatal(err)
	}
	extra := s.create("之后新建", "")
	s.populate(extra, "新")
	s.close()

	res, err := RestoreArchive(ctx, f.dir, arc, RestoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(res.Kept, "app.db")); err != nil {
		t.Errorf("pre-restore 里应有现有数据库的快照：%v", err)
	}
	if _, err := os.Stat(filepath.Join(res.Kept, "vault", "之后.md")); err != nil {
		t.Errorf("被替换的笔记应保留：%v", err)
	}
	r := openSite(t, f.dir)
	r.verify(workspace.DefaultID, "默认")
	if _, err := os.Stat(filepath.Join(f.dir, "vault", "之后.md")); !os.IsNotExist(err) {
		t.Errorf("默认空间应回到备份时：%v", err)
	}
	if got := r.count(workspace.DefaultID, "changes"); got != before {
		t.Errorf("变更记录 %d 条，应为 %d", got, before)
	}
	if err := auth.New(r.d).CheckPassword(ctx, "new-password-1"); err != nil {
		t.Errorf("密码不应回退：%v", err)
	}
	list, _ := r.mgr.List(ctx)
	if len(list) != 4 {
		t.Errorf("其他空间的登记不应变：%+v", list)
	}
	r.verify(extra, "新")
	for _, in := range list {
		if in.ID == f.builtin && in.Name != "改名" {
			t.Errorf("登记的名称不应回退：%+v", in)
		}
	}
	// 重新打开后再对账不应破坏恢复的内容
	if svc, _ := r.notesOf(workspace.DefaultID); svc != nil {
		if _, err := svc.Reconcile(ctx); err != nil {
			t.Fatal(err)
		}
		r.verify(workspace.DefaultID, "默认")
	}
}

// app.db 里每张表都要分类：属于默认工作空间的（单空间恢复时替换），或全局的（不动）。新增迁移加表时这个测试会失败，提醒更新分类。
func TestDefaultIndexTablesCoverSchema(t *testing.T) {
	d, err := db.Open(context.Background(), filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	global := map[string]bool{"settings": true, "sessions": true, "api_tokens": true, "audit_log": true, "llm_providers": true,
		"llm_models": true, "agent_settings": true, "passkeys": true, "workspaces": true, "schema_migrations": true, "sqlite_sequence": true}
	scoped := map[string]bool{}
	for _, n := range defaultIndexTables {
		scoped[n] = true
	}
	rows, err := d.Query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var n string
		rows.Scan(&n)
		if strings.HasPrefix(n, "notes_fts_") { // FTS5 的影子表
			continue
		}
		if !scoped[n] && !global[n] {
			t.Errorf("表 %s 没有分类：加入 defaultIndexTables（属于默认工作空间）或本测试的 global 列表", n)
		}
		delete(scoped, n)
	}
	for n := range scoped {
		t.Errorf("defaultIndexTables 里的 %s 不是 app.db 的表", n)
	}
}

func TestSafeEntryWorkspaces(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"workspaces", true},
		{"workspaces/k3f9a2", true},
		{"workspaces/k3f9a2/index.db", true},
		{"workspaces/k3f9a2/vault", true},
		{"workspaces/k3f9a2/vault/日记/今天.md", true},
		{"workspaces/k3f9a2/trash/a.md", true},
		{"workspaces/../x", false},
		{"workspaces/k3f9a2/../../x", false},
		{"workspaces/k3f9a2/vault/../../../x", false},
		{"workspaces/.", false},
		{"workspaces//vault", false},
		{"workspaces/default", false}, // 默认空间在顶层
		{"workspaces/default/vault/a.md", false},
		{"workspaces/K3F9A2/vault/a.md", false}, // id 只允许小写字母和数字
		{"workspaces/k3f9a2/other/a.md", false},
		{"workspaces/k3f9a2/index.db/x", false},
		{"workspaces/k3f9a2/app.db", false},
		{"workspaces/" + strings.Repeat("a", 33) + "/vault", false},
		{"/workspaces/k3f9a2/vault", false},
		{"workspaces/k3f9a2/secret.key", false},
		{"secret.key/x", false},
		{"pre-restore-1/app.db", false},
	}
	if runtime.GOOS == "windows" {
		cases = append(cases, struct {
			name string
			ok   bool
		}{`workspaces/k3f9a2/vault/..\..\x`, false}, struct {
			name string
			ok   bool
		}{"workspaces/k3f9a2/vault/a:b", false})
	}
	for _, c := range cases {
		if got := safeEntry(c.name); got != c.ok {
			t.Errorf("safeEntry(%q) = %v，应为 %v", c.name, got, c.ok)
		}
	}
}

// 新目录结构下越界的条目都被拒绝，数据目录保持原样，越界文件不会被写出。
func TestRestoreRejectsEscapingWorkspaceEntries(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dir := filepath.Join(root, "data")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "app.db"), []byte("keep"), 0o600)
	manifest := `{"format":2,"db_version":1,"workspaces":[{"id":"default","name":"笔记"}]}`
	for _, name := range []string{
		"workspaces/../../escape.txt",
		"workspaces/abc/vault/../../../../escape.txt",
		"workspaces/default/vault/a.md",
		"workspaces/ABC/vault/a.md",
		"workspaces/abc/evil/a.md",
	} {
		arc := filepath.Join(root, "evil.tar.gz")
		writeTestArchive(t, arc, map[string]string{manifestName: manifest, name: "x"})
		if _, err := RestoreArchive(ctx, dir, arc, RestoreOptions{}); err == nil || !strings.Contains(err.Error(), "不允许的条目") {
			t.Errorf("%s 应被拒绝：%v", name, err)
		}
		os.Remove(arc)
	}
	if _, err := os.Stat(filepath.Join(root, "escape.txt")); !os.IsNotExist(err) {
		t.Error("越界条目不应被写出")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "app.db")); string(b) != "keep" {
		t.Error("恢复失败时不应改动数据目录")
	}
}

// 清单有问题的备份（工作空间 id 不合法、外部路径不是绝对路径、与数据库登记不一致、符号链接条目）都拒绝。
func TestRestoreRejectsBadManifests(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	src := openSite(t, filepath.Join(root, "src"))
	ext := filepath.Join(root, "ext")
	os.MkdirAll(ext, 0o755)
	id := src.create("外部", ext)
	snap := filepath.Join(root, "snap.db")
	if err := db.Snapshot(ctx, src.d, snap); err != nil {
		t.Fatal(err)
	}
	src.close()
	dbBytes, _ := os.ReadFile(snap)
	dir := filepath.Join(root, "dst")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "app.db"), []byte("keep"), 0o600)

	base := func(ws string) map[string]string {
		return map[string]string{manifestName: `{"format":2,"db_version":6,"workspaces":[` + ws + `]}`, dbName: string(dbBytes),
			"vault/a.md": "x", "workspaces/" + id + "/vault/a.md": "x"}
	}
	def := `{"id":"default","name":"笔记"}`
	cases := map[string]map[string]string{
		"非法 id":      base(def + `,{"id":"../x","name":"x"}`),
		"重复 id":      base(def + `,{"id":"default","name":"x"}`),
		"没有默认空间":     base(`{"id":"` + id + `","name":"外部"}`),
		"登记表里没有该空间":  base(def + `,{"id":"zzz","name":"x"}`),
		"路径与登记表不一致":  base(def + `,{"id":"` + id + `","name":"外部","external":true,"vault_dir":"` + strings.ReplaceAll(filepath.ToSlash(ext), `"`, "") + `/other"}`),
		"scope 不认识":  {manifestName: `{"format":2,"scope":"weird"}`},
		"单空间备份有两个空间": {manifestName: `{"format":2,"scope":"workspace","workspaces":[` + def + `,{"id":"abc","name":"x"}]}`},
	}
	for name, files := range cases {
		arc := filepath.Join(root, "bad.tar.gz")
		writeTestArchive(t, arc, files)
		if _, err := RestoreArchive(ctx, dir, arc, RestoreOptions{}); err == nil {
			t.Errorf("%s：应被拒绝", name)
		}
		os.Remove(arc)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "app.db")); string(b) != "keep" {
		t.Error("恢复失败时不应改动数据目录")
	}
}

// 外部目录的恢复目标不能落在数据目录里、不能和另一个外部目录互相嵌套。
func TestCheckDestRejectsOverlaps(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	os.MkdirAll(data, 0o755)
	e := WorkspaceEntry{ID: "a", Name: "甲", External: true}
	for name, dest := range map[string]string{
		"数据目录里":  filepath.Join(data, "x"),
		"就是数据目录": data,
		"包含数据目录": root,
		"相对路径":   "rel/dir",
		"根目录":    filepath.VolumeName(root) + string(filepath.Separator),
	} {
		if err := checkDest(data, e, dest, nil); err == nil {
			t.Errorf("%s：%s 应被拒绝", name, dest)
		}
	}
	other := filepath.Join(root, "other")
	for _, dest := range []string{other, filepath.Join(other, "sub"), root} {
		if err := checkDest(filepath.Join(root, "elsewhere-data"), e, dest, []string{other}); err == nil {
			t.Errorf("%s 与另一个外部目录相同或嵌套，应被拒绝", dest)
		}
	}
	if err := checkDest(data, e, filepath.Join(root, "fine"), []string{other}); err != nil {
		t.Errorf("正常位置应通过：%v", err)
	}
}
