package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/vault"
)

// #57：登记表、按需打开、关停。

// releasedVersion 是 v0.1.0 发布时的数据库迁移版本（迁移 0006 之前）。
const releasedVersion = 5

// newManager 在临时数据目录里建好 app.db、默认工作空间和带登记表的 Manager。
func newManager(t *testing.T) (m *Manager, dataDir string, global *sql.DB) {
	t.Helper()
	dataDir = t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dataDir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	v, err := vault.New(filepath.Join(dataDir, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	svc := notes.New(notes.Options{DB: d, Vault: v, TrashDir: filepath.Join(dataDir, "trash")})
	m = New(Options{Default: svc, DB: d, DataDir: dataDir, Debounce: 20 * time.Millisecond})
	t.Cleanup(m.Close) // 先于关闭 app.db 执行
	return m, dataDir, d
}

// schema 返回数据库的完整结构：sqlite_master 的每一项，以及每张表的列定义。
func schema(t *testing.T, path string) []string {
	t.Helper()
	d, err := db.Connect(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	rows, err := d.Query(`SELECT type, name, tbl_name, coalesce(sql, '') FROM sqlite_master ORDER BY type, name`)
	if err != nil {
		t.Fatal(err)
	}
	var out, tables []string
	for rows.Next() {
		var typ, name, tbl, sqlText string
		if err := rows.Scan(&typ, &name, &tbl, &sqlText); err != nil {
			t.Fatal(err)
		}
		out = append(out, fmt.Sprintf("%s %s on %s: %s", typ, name, tbl, sqlText))
		if typ == "table" {
			tables = append(tables, name)
		}
	}
	rows.Close()
	for _, tbl := range tables {
		cols, err := d.Query(`SELECT cid, name, type, "notnull", coalesce(dflt_value, ''), pk FROM pragma_table_info(?)`, tbl)
		if err != nil {
			t.Fatal(err)
		}
		for cols.Next() {
			var cid, notnull, pk int
			var name, typ, dflt string
			if err := cols.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
				t.Fatal(err)
			}
			out = append(out, fmt.Sprintf("column %s.%d %s %s notnull=%d default=%s pk=%d", tbl, cid, name, typ, notnull, dflt, pk))
		}
		cols.Close()
	}
	var versions []string
	vr, err := d.Query(`SELECT version FROM schema_migrations ORDER BY version`)
	if err != nil {
		t.Fatal(err)
	}
	for vr.Next() {
		var v int
		vr.Scan(&v)
		versions = append(versions, fmt.Sprint(v))
	}
	vr.Close()
	return append(out, "migrations "+strings.Join(versions, ","))
}

// 验收：拿当前发布版本（迁移 5）的 app.db 升级后，结构和新建的工作空间索引库同构；
// 已有 token、审计日志属于默认工作空间，默认工作空间自动登记。
func TestUpgradedAppDBMatchesNewWorkspaceIndex(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	appPath := filepath.Join(dataDir, "app.db")

	// 当前发布版本的 app.db，带一些全局数据
	old, err := db.Connect(ctx, appPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.MigrateTo(ctx, old, releasedVersion); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO settings(key, value) VALUES ('password_hash', 'x')`,
		`INSERT INTO api_tokens(id, name, scope, token_hash, created_at) VALUES ('t1', 'mcp', 'read', 'h1', 1)`,
		`INSERT INTO audit_log(at, token_id, token_name, tool, ok) VALUES (1, 't1', 'mcp', 'search', 1)`,
	} {
		if _, err := old.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	old.Close()

	app, err := db.Open(ctx, appPath)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	if v, _ := db.Version(ctx, app); v != db.LatestVersion() || v <= releasedVersion {
		t.Fatalf("升级后版本 = %d，最新 %d", v, db.LatestVersion())
	}
	var tokWS, auditWS, name string
	app.QueryRow(`SELECT workspace_id FROM api_tokens WHERE id = 't1'`).Scan(&tokWS)
	app.QueryRow(`SELECT workspace_id FROM audit_log`).Scan(&auditWS)
	app.QueryRow(`SELECT name FROM workspaces WHERE id = 'default'`).Scan(&name)
	if tokWS != DefaultID || auditWS != DefaultID || name != DefaultName {
		t.Fatalf("升级后 token 工作空间 = %q，审计 = %q，默认工作空间名称 = %q", tokWS, auditWS, name)
	}
	if b, _ := filepath.Glob(filepath.Join(dataDir, "backups", "app-v5-*.db")); len(b) != 1 {
		t.Fatalf("升级前应备份 app.db：%v", b)
	}

	v, _ := vault.New(filepath.Join(dataDir, "vault"))
	m := New(Options{Default: notes.New(notes.Options{DB: app, Vault: v, TrashDir: filepath.Join(dataDir, "trash")}), DB: app, DataDir: dataDir})
	defer m.Close()
	in, err := m.Create(ctx, CreateOptions{Name: "工作"})
	if err != nil {
		t.Fatal(err)
	}
	got, want := schema(t, PathsFor(dataDir, in.ID, "").Index), schema(t, appPath)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("新工作空间的 index.db 和升级后的 app.db 结构不同：\nindex.db:\n%s\n\napp.db:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestCreateAndList(t *testing.T) {
	ctx := context.Background()
	m, dataDir, _ := newManager(t)
	for _, bad := range []string{"", "   ", strings.Repeat("长", MaxNameLen+1), "a\nb"} {
		if _, err := m.Create(ctx, CreateOptions{Name: bad}); !errors.Is(err, ErrInvalid) {
			t.Errorf("Create(%q) 应返回 ErrInvalid，得到 %v", bad, err)
		}
	}
	a, err := m.Create(ctx, CreateOptions{Name: "  工作  "})
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.Create(ctx, CreateOptions{Name: "读书"})
	if err != nil {
		t.Fatal(err)
	}
	if a.Name != "工作" || a.ID == b.ID || len(a.ID) != idLen || !ValidID(a.ID) || a.ID == DefaultID || b.Sort <= a.Sort || a.Sort <= 0 {
		t.Fatalf("新建结果 a = %+v, b = %+v", a, b)
	}
	p := PathsFor(dataDir, a.ID, "")
	if p.Root != filepath.Join(dataDir, "workspaces", a.ID) {
		t.Fatalf("工作空间目录 = %s", p.Root)
	}
	for _, f := range []string{p.Index, p.Vault, p.Trash} {
		if _, err := os.Stat(f); err != nil {
			t.Fatalf("新建后应有 %s：%v", f, err)
		}
	}
	list, err := m.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[0].ID != DefaultID || list[0].Name != DefaultName || list[1].ID != a.ID || list[2].ID != b.ID {
		t.Fatalf("List = %+v", list)
	}
	if list[1].External || list[1].VaultDir != "" || list[1].NoteCount != 0 {
		t.Fatalf("内置工作空间不应暴露路径：%+v", list[1])
	}
	if m.IsOpen(a.ID) || m.IsOpen(b.ID) || len(m.Opened()) != 1 {
		t.Fatal("新建和列出都不应打开工作空间")
	}
	// 未登记的 id、格式不对的 id 都是 ErrNotFound
	for _, id := range []string{"zzzzzz", "", "A1", "../x", "a/b"} {
		if _, err := m.Get(ctx, id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Get(%q) = %v", id, err)
		}
	}

	// 没有登记表的 Manager（旧写法）不能新建，只列出默认工作空间
	m2 := New(Options{Default: m.Default().Notes})
	if _, err := m2.Create(ctx, CreateOptions{Name: "x"}); !errors.Is(err, ErrNoRegistry) {
		t.Fatalf("没有登记表时 Create = %v", err)
	}
	if l, err := m2.List(ctx); err != nil || len(l) != 1 || l[0].ID != DefaultID {
		t.Fatalf("没有登记表时 List = %+v, %v", l, err)
	}
}

// 验收：新空间直到第一次被访问才打开；直接往它的 vault 放文件后，第一次访问时能对账出来。
func TestOpensOnFirstAccessAndReconciles(t *testing.T) {
	rec := record(t)
	ctx := context.Background()
	m, dataDir, _ := newManager(t)
	m.Start(ctx)
	rec.wait(t, "default:ready")

	in, err := m.Create(ctx, CreateOptions{Name: "工作"})
	if err != nil {
		t.Fatal(err)
	}
	vdir := PathsFor(dataDir, in.ID, "").Vault
	if err := os.MkdirAll(filepath.Join(vdir, "子目录"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"外部.md": "# 外部放进来的\n\n[[子目录/另一篇]]\n", "子目录/另一篇.md": "# 另一篇\n"} {
		if err := os.WriteFile(filepath.Join(vdir, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(100 * time.Millisecond) // 给可能存在的监听留出时间：没打开就不应有任何动静
	if m.IsOpen(in.ID) {
		t.Fatal("还没访问就打开了")
	}
	for _, ev := range rec.snapshot() {
		if strings.HasPrefix(ev, in.ID+":") {
			t.Fatalf("还没访问就有后台任务：%v", rec.snapshot())
		}
	}

	// 并发的第一次访问只打开一次
	var wg sync.WaitGroup
	got := make([]*Workspace, 8)
	for i := range got {
		wg.Go(func() {
			w, err := m.Get(ctx, in.ID)
			if err != nil {
				t.Error(err)
			}
			got[i] = w
		})
	}
	wg.Wait()
	for _, w := range got {
		if w == nil || w != got[0] {
			t.Fatal("并发 Get 应得到同一个工作空间")
		}
	}
	rec.wait(t, in.ID+":ready")
	ev := rec.snapshot()
	if n := count(ev, in.ID+":opened"); n != 1 {
		t.Fatalf("应只打开一次，opened = %d：%v", n, ev)
	}
	if iw, ir := index(ev, in.ID+":watching"), index(ev, in.ID+":reconcile"); iw < 0 || ir < 0 || iw > ir {
		t.Fatalf("应先 watching 再 reconcile：%v", ev)
	}
	w := got[0]
	if w.ID != in.ID || w.Notes == m.Default().Notes || w.Tools == nil {
		t.Fatalf("工作空间 = %+v", w)
	}
	for _, p := range []string{"外部.md", "子目录/另一篇.md"} {
		if _, err := w.Notes.ReadByPath(ctx, p); err != nil {
			t.Fatalf("第一次访问时应对账出 %s：%v", p, err)
		}
		if _, err := m.Default().Notes.ReadByPath(ctx, p); err == nil {
			t.Fatalf("默认工作空间不应看到 %s", p)
		}
	}
	if n, _ := w.Notes.NoteCount(ctx); n != 2 {
		t.Fatalf("笔记数 = %d", n)
	}
	// 打开后监听生效
	if err := os.WriteFile(filepath.Join(vdir, "之后.md"), []byte("# 之后\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { _, err := w.Notes.ReadByPath(ctx, "之后.md"); return err == nil })
	if l, _ := m.List(ctx); l[1].NoteCount != 3 {
		t.Fatalf("List 的笔记数 = %+v", l)
	}
	if w2, _ := m.Get(ctx, in.ID); w2 != w {
		t.Fatal("打开后应保持同一个实例")
	}
}

// Start 之前访问的工作空间先打开，后台任务等 Start 再启动。
func TestOpenBeforeStart(t *testing.T) {
	rec := record(t)
	ctx := context.Background()
	m, dataDir, _ := newManager(t)
	in, _ := m.Create(ctx, CreateOptions{Name: "x"})
	os.WriteFile(filepath.Join(PathsFor(dataDir, in.ID, "").Vault, "a.md"), []byte("# a\n"), 0o644)
	w, err := m.Get(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ev := rec.snapshot(); len(ev) != 1 || ev[0] != in.ID+":opened" {
		t.Fatalf("Start 之前不应启动后台任务：%v", ev)
	}
	m.Start(ctx)
	rec.wait(t, in.ID+":ready")
	if _, err := w.Notes.ReadByPath(ctx, "a.md"); err != nil {
		t.Fatal(err)
	}
}

// 验收：进程退出时所有已打开空间的监听和对账都已停止，不泄漏 goroutine；索引库已关闭。
func TestCloseStopsEveryOpenedWorkspace(t *testing.T) {
	rec := record(t)
	ctx := context.Background()
	dataDir := t.TempDir()
	app, err := db.Open(ctx, filepath.Join(dataDir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	v, _ := vault.New(filepath.Join(dataDir, "vault"))
	svc := notes.New(notes.Options{DB: app, Vault: v, TrashDir: filepath.Join(dataDir, "trash")})
	runtime.GC()
	baseline := runtime.NumGoroutine()

	m := New(Options{Default: svc, DB: app, DataDir: dataDir, Debounce: 20 * time.Millisecond})
	m.Start(ctx)
	rec.wait(t, "default:ready")
	var ids []string
	for _, name := range []string{"甲", "乙", "丙"} {
		in, err := m.Create(ctx, CreateOptions{Name: name})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, in.ID)
	}
	// 打开前两个，第三个不访问
	var opened []*Workspace
	for _, id := range ids[:2] {
		w, err := m.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		opened = append(opened, w)
		rec.wait(t, id+":ready")
	}
	if got := m.Opened(); len(got) != 3 {
		t.Fatalf("已打开 = %d", len(got))
	}
	if runtime.NumGoroutine() <= baseline {
		t.Fatal("打开后应有后台 goroutine（否则这个测试测不出泄漏）")
	}

	m.Close()
	ev := rec.snapshot()
	for _, id := range []string{DefaultID, ids[0], ids[1]} {
		if n := count(ev, id+":stopped"); n != 3 {
			t.Fatalf("%s 的 3 个后台任务应都已退出，stopped = %d：%v", id, n, ev)
		}
	}
	for _, e := range ev {
		if strings.HasPrefix(e, ids[2]+":") {
			t.Fatalf("没访问过的工作空间不应有后台任务：%v", ev)
		}
	}
	// 索引库已经关闭
	for _, w := range opened {
		if _, err := w.Notes.NoteCount(ctx); err == nil || !strings.Contains(err.Error(), "closed") {
			t.Fatalf("Close 后 %s 的索引库应已关闭：%v", w.ID, err)
		}
	}
	// 关闭后不再打开新的工作空间
	if _, err := m.Get(ctx, ids[2]); !errors.Is(err, ErrClosed) {
		t.Fatalf("Close 后 Get 未打开的工作空间 = %v", err)
	}
	m.Close() // 可以重复调用
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	// goroutine 回到打开之前的数量
	deadline := time.Now().Add(5 * time.Second)
	for runtime.NumGoroutine() > baseline {
		if time.Now().After(deadline) {
			buf := make([]byte, 1<<20)
			n := runtime.Stack(buf, true)
			t.Fatalf("goroutine 泄漏：之前 %d，现在 %d\n%s", baseline, runtime.NumGoroutine(), buf[:n])
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("等待超时")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
