package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// #59：改名、排序、删除。

func insertToken(t *testing.T, m *Manager, id, ws string) {
	t.Helper()
	_, err := m.global.Exec(`INSERT INTO api_tokens(id, name, scope, token_hash, created_at, workspace_id) VALUES (?, ?, 'read', ?, 1, ?)`,
		id, id, "hash-"+id, ws)
	if err != nil {
		t.Fatal(err)
	}
}

func tokenCount(t *testing.T, m *Manager) int {
	t.Helper()
	var n int
	if err := m.global.QueryRow(`SELECT count(*) FROM api_tokens`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRemoveDefaultIsRefused(t *testing.T) {
	m, dataDir, _ := newManager(t)
	if _, err := m.Remove(context.Background(), DefaultID); !errors.Is(err, ErrProtected) {
		t.Fatalf("删除默认工作空间应返回 ErrProtected，得到 %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "vault")); err != nil {
		t.Fatalf("默认工作空间的 vault 应原样保留：%v", err)
	}
	if l, _ := m.List(context.Background()); len(l) != 1 || l[0].ID != DefaultID {
		t.Fatalf("登记表 = %+v", l)
	}
	for _, id := range []string{"nope", "../x", ""} {
		if _, err := m.Remove(context.Background(), id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Remove(%q) = %v，期望 ErrNotFound", id, err)
		}
	}
}

// 验收：删除内置空间后目录出现在 trash-workspaces/ 下，登记表里没有它，相关后台任务已停止。
func TestRemoveBuiltInMovesToTrashAndStopsTasks(t *testing.T) {
	rec := record(t)
	ctx := context.Background()
	m, dataDir, _ := newManager(t)
	m.Start(ctx)
	rec.wait(t, "default:ready")
	keep, err := m.Create(ctx, CreateOptions{Name: "保留"})
	if err != nil {
		t.Fatal(err)
	}
	in, err := m.Create(ctx, CreateOptions{Name: "待删"})
	if err != nil {
		t.Fatal(err)
	}
	vdir := PathsFor(dataDir, in.ID, "").Vault
	if err := os.WriteFile(filepath.Join(vdir, "笔记.md"), []byte("# 笔记\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	w, err := m.Get(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Get(ctx, keep.ID); err != nil {
		t.Fatal(err)
	}
	rec.wait(t, in.ID+":ready")
	insertToken(t, m, "t-del-1", in.ID)
	insertToken(t, m, "t-del-2", in.ID)
	insertToken(t, m, "t-keep", keep.ID)
	insertToken(t, m, "t-default", DefaultID)

	now := time.Date(2026, 11, 9, 8, 30, 5, 0, time.Local)
	m.now = func() time.Time { return now }
	res, err := m.Remove(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantTrash := TrashDirName + "/" + in.ID + "-20261109-083005"
	if res.Trash != wantTrash || res.RevokedTokens != 2 {
		t.Fatalf("结果 = %+v，期望 trash=%s 作废 2 个 token", res, wantTrash)
	}

	// 目录移走了，内容完整
	if _, err := os.Stat(PathsFor(dataDir, in.ID, "").Root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("原目录应已不存在：%v", err)
	}
	if b, err := os.ReadFile(filepath.Join(dataDir, filepath.FromSlash(wantTrash), "vault", "笔记.md")); err != nil || string(b) != "# 笔记\n" {
		t.Fatalf("回收目录里应有笔记：%q %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, filepath.FromSlash(wantTrash), "index.db")); err != nil {
		t.Fatalf("回收目录里应有索引库：%v", err)
	}
	// 登记表没有它，别的工作空间不受影响
	l, err := m.List(ctx)
	if err != nil || len(l) != 2 || l[0].ID != DefaultID || l[1].ID != keep.ID {
		t.Fatalf("登记表 = %+v %v", l, err)
	}
	if _, err := m.Get(ctx, in.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("删除后 Get 应返回 ErrNotFound，得到 %v", err)
	}
	if m.IsOpen(in.ID) || !m.IsOpen(keep.ID) {
		t.Fatalf("打开状态：待删 %v 保留 %v", m.IsOpen(in.ID), m.IsOpen(keep.ID))
	}
	for _, o := range m.Opened() {
		if o.ID == in.ID {
			t.Fatal("Opened 不应再包含已删除的工作空间")
		}
	}
	// 后台任务（监听、对账、清理）都已停止，库已关闭
	ev := rec.snapshot()
	if n := count(ev, in.ID+":stopped"); n != 3 {
		t.Fatalf("应有 3 个后台任务停止，得到 %d：%v", n, ev)
	}
	select {
	case <-w.Gone():
	default:
		t.Fatal("Gone 应已关闭")
	}
	if _, err := w.Notes.NoteCount(ctx); err == nil {
		t.Fatal("索引库应已关闭")
	}
	// token：绑定它的作废，其余保留
	if n := tokenCount(t, m); n != 2 {
		t.Fatalf("剩余 token = %d，期望 2", n)
	}
	// 同名回收目录要避让
	if got, err := m.moveToTrash(in.ID, filepath.Join(dataDir, "不存在")); err != nil || got != wantTrash+"-2" {
		t.Fatalf("同名回收目录应加后缀：%q %v", got, err)
	}
	if _, err := m.Remove(ctx, in.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("重复删除 = %v", err)
	}
}

func TestRemoveNeverOpenedAndNotStarted(t *testing.T) {
	ctx := context.Background()
	m, dataDir, _ := newManager(t)
	in, _ := m.Create(ctx, CreateOptions{Name: "没打开过"})
	res, err := m.Remove(ctx, in.ID)
	if err != nil || !strings.HasPrefix(res.Trash, TrashDirName+"/"+in.ID+"-") {
		t.Fatalf("Remove = %+v %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, filepath.FromSlash(res.Trash), "vault")); err != nil {
		t.Fatal(err)
	}
	// 已打开但还没 Start
	in2, _ := m.Create(ctx, CreateOptions{Name: "打开未启动"})
	if _, err := m.Get(ctx, in2.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Remove(ctx, in2.ID); err != nil {
		t.Fatal(err)
	}
	if m.IsOpen(in2.ID) {
		t.Fatal("应已关闭")
	}
}

// 外部目录（#60）的删除只处理 data/workspaces/<id>/，外部的笔记文件不动。这里验证现有结构不会碰外部目录。
func TestRemoveLeavesExternalVaultAlone(t *testing.T) {
	ctx := context.Background()
	m, dataDir, _ := newManager(t)
	ext := t.TempDir()
	if err := os.WriteFile(filepath.Join(ext, "我的.md"), []byte("# 我的\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := m.global.Exec(`INSERT INTO workspaces(id, name, vault_dir, sort, created_at) VALUES ('ext1', '外部', ?, 5, 1)`, ext); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Get(ctx, "ext1"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Remove(ctx, "ext1"); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(ext, "我的.md")); err != nil || string(b) != "# 我的\n" {
		t.Fatalf("外部目录的笔记应原样保留：%q %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, DirName, "ext1")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("data/workspaces/ext1 应已移走：%v", err)
	}
}

func TestRenameAndReorder(t *testing.T) {
	ctx := context.Background()
	m, _, _ := newManager(t)
	a, _ := m.Create(ctx, CreateOptions{Name: "甲"})
	b, _ := m.Create(ctx, CreateOptions{Name: "乙"})
	c, _ := m.Create(ctx, CreateOptions{Name: "丙"})
	order := func() string {
		l, err := m.List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for i, in := range l {
			if in.Sort != i {
				t.Fatalf("sort 应等于位置：%+v", l)
			}
			names = append(names, in.Name)
		}
		return strings.Join(names, ",")
	}
	if got := order(); got != "笔记,甲,乙,丙" {
		t.Fatal(got)
	}

	// 改名：默认工作空间也可以；校验同新建
	if in, err := m.Rename(ctx, DefaultID, "  主库 "); err != nil || in.Name != "主库" {
		t.Fatalf("Rename = %+v %v", in, err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("长", 65), "a\x00b"} {
		if _, err := m.Rename(ctx, a.ID, bad); !errors.Is(err, ErrInvalid) {
			t.Fatalf("Rename(%q) = %v，期望 ErrInvalid", bad, err)
		}
	}
	if _, err := m.Rename(ctx, "nope", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("改不存在的 = %v", err)
	}

	// 排序：sort 是目标位置
	if in, err := m.Reorder(ctx, c.ID, 1); err != nil || in.Sort != 1 {
		t.Fatalf("Reorder = %+v %v", in, err)
	}
	if got := order(); got != "主库,丙,甲,乙" {
		t.Fatal(got)
	}
	if _, err := m.Reorder(ctx, a.ID, 99); err != nil { // 超出范围放到最后
		t.Fatal(err)
	}
	if got := order(); got != "主库,丙,乙,甲" {
		t.Fatal(got)
	}
	if _, err := m.Reorder(ctx, b.ID, 0); err != nil { // 可以排到默认工作空间前面
		t.Fatal(err)
	}
	if got := order(); got != "乙,主库,丙,甲" {
		t.Fatal(got)
	}
	if _, err := m.Reorder(ctx, "nope", 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("排不存在的 = %v", err)
	}
	// 新建的排在最后
	d, _ := m.Create(ctx, CreateOptions{Name: "丁"})
	if d.Sort != 4 {
		t.Fatalf("新建的 sort = %d", d.Sort)
	}
}

func TestInfoAndExists(t *testing.T) {
	ctx := context.Background()
	m, _, _ := newManager(t)
	in, _ := m.Create(ctx, CreateOptions{Name: "工作"})
	got, err := m.Info(ctx, in.ID)
	if err != nil || got.Name != "工作" || got.Path != "workspaces/"+in.ID+"/vault" {
		t.Fatalf("Info = %+v %v", got, err)
	}
	if d, _ := m.Info(ctx, DefaultID); d.Path != "vault" {
		t.Fatalf("默认工作空间路径 = %q", d.Path)
	}
	if _, err := m.Info(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	for id, want := range map[string]bool{DefaultID: true, in.ID: true, "nope": false} {
		if ok, err := m.Exists(ctx, id); err != nil || ok != want {
			t.Fatalf("Exists(%s) = %v %v", id, ok, err)
		}
	}
}

// 删除和并发的 Get 同时发生时，不会留下打开的工作空间。
func TestRemoveRacesWithGet(t *testing.T) {
	ctx := context.Background()
	m, _, _ := newManager(t)
	m.Start(ctx)
	for range 5 {
		in, _ := m.Create(ctx, CreateOptions{Name: "竞争"})
		done := make(chan struct{})
		go func() {
			defer close(done)
			for range 20 {
				_, _ = m.Get(ctx, in.ID)
			}
		}()
		if _, err := m.Remove(ctx, in.ID); err != nil {
			t.Fatal(err)
		}
		<-done
		if m.IsOpen(in.ID) {
			t.Fatal("删除后不应有打开的实例")
		}
	}
}
