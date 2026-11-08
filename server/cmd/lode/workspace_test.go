package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/rt-game-440/lode/server/internal/config"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/ops"
	"github.com/rt-game-440/lode/server/internal/vault"
	"github.com/rt-game-440/lode/server/internal/workspace"
)

// #60：lode workspace 子命令。

func newCLIConfig(t *testing.T) config.Config {
	t.Helper()
	cfg := config.Config{DataDir: t.TempDir()}
	d, err := db.Open(context.Background(), cfg.DBPath())
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	return cfg
}

func wsCmd(t *testing.T, cfg config.Config, args ...string) (string, error) {
	t.Helper()
	var buf bytes.Buffer
	err := runWorkspace(cfg, args, &buf)
	return buf.String(), err
}

type listed struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	External  bool   `json:"external"`
	VaultDir  string `json:"vault_dir"`
	Path      string `json:"path"`
	Sort      int    `json:"sort"`
	NoteCount int    `json:"note_count"`
}

func wsList(t *testing.T, cfg config.Config) []listed {
	t.Helper()
	out, err := wsCmd(t, cfg, "list", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Workspaces []listed `json:"workspaces"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("list --json 输出不是 JSON：%v\n%s", err, out)
	}
	return v.Workspaces
}

func hashes(t *testing.T, dir string) map[string][32]byte {
	t.Helper()
	out := map[string][32]byte{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		out[rel] = sha256.Sum256(b)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// 验收：各子命令的结果和接口（workspace.Manager，/api/workspaces 用的是同一个）一致。
func TestWorkspaceCommandMatchesAPI(t *testing.T) {
	cfg := newCLIConfig(t)
	ctx := context.Background()

	// 初始只有默认工作空间
	l := wsList(t, cfg)
	if len(l) != 1 || l[0].ID != "default" || l[0].External || l[0].VaultDir != "" {
		t.Fatalf("初始列表 = %+v", l)
	}

	// add：内置位置
	out, err := wsCmd(t, cfg, "add", "读书")
	if err != nil || !strings.Contains(out, "读书") {
		t.Fatalf("add = %q %v", out, err)
	}
	// add --dir：外部目录
	ext := t.TempDir()
	if err := os.WriteFile(filepath.Join(ext, "旧笔记.md"), []byte("# 旧笔记\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err = wsCmd(t, cfg, "add", "Obsidian 库", "--dir", ext)
	if err != nil || !strings.Contains(out, "已有文件夹") {
		t.Fatalf("add --dir = %q %v", out, err)
	}
	l = wsList(t, cfg)
	if len(l) != 3 || l[1].Name != "读书" || l[1].External || l[1].VaultDir != "" || l[1].Path != "workspaces/"+l[1].ID+"/vault" {
		t.Fatalf("add 后列表 = %+v", l)
	}
	resolved, _ := filepath.EvalSymlinks(ext)
	if !l[2].External || l[2].VaultDir != resolved || l[2].Name != "Obsidian 库" || l[2].Sort != 2 {
		t.Fatalf("外部空间 = %+v", l[2])
	}
	// 与 Manager.List（接口的数据来源）逐项一致
	d, err := db.Open(ctx, cfg.DBPath())
	if err != nil {
		t.Fatal(err)
	}
	v, err := vault.New(cfg.VaultDir())
	if err != nil {
		t.Fatal(err)
	}
	m := workspace.New(workspace.Options{Default: notes.New(notes.Options{DB: d, Vault: v, TrashDir: cfg.TrashDir()}), DB: d, DataDir: cfg.DataDir})
	want, err := m.List(ctx)
	m.Close()
	d.Close()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := wsCmd(t, cfg, "list", "--json")
	var got struct {
		Workspaces []workspace.Info `json:"workspaces"`
	}
	if err := json.Unmarshal([]byte(raw), &got); err != nil || !reflect.DeepEqual(got.Workspaces, want) {
		t.Fatalf("list --json 应与接口使用的 Manager.List 一致：%+v 对 %+v (%v)", got.Workspaces, want, err)
	}

	// 文本列表里有 id、名称、路径
	txt, err := wsCmd(t, cfg, "list")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{l[1].ID, l[2].ID, "Obsidian 库", resolved} {
		if !strings.Contains(txt, want) {
			t.Errorf("list 输出缺 %q：\n%s", want, txt)
		}
	}

	// 路径校验与接口一致，错误信息能区分原因
	for dirArg, want := range map[string]string{
		"相对路径":                              "绝对路径",
		filepath.Join(ext, "不存在"):           "不存在",
		cfg.DataDir:                         "数据目录",
		filepath.Join(cfg.DataDir, "vault"): "数据目录",
		ext:                                 "已经是工作空间",
		filepath.Dir(ext):                   "里面",
	} {
		_, err := wsCmd(t, cfg, "add", "坏的", "--dir="+dirArg)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("add --dir=%q：期望错误含 %q，得到 %v", dirArg, want, err)
		}
	}
	if len(wsList(t, cfg)) != 3 {
		t.Fatal("被拒绝的 add 不应登记")
	}
	if _, err := wsCmd(t, cfg, "add", "  "); err == nil || strings.Contains(err.Error(), "invalid workspace") {
		t.Fatalf("空名称 = %v，应给出中文信息", err)
	}

	// rename（默认空间也可以改名）
	if _, err := wsCmd(t, cfg, "rename", l[1].ID, "  书架 "); err != nil {
		t.Fatal(err)
	}
	if _, err := wsCmd(t, cfg, "rename", "default", "主库"); err != nil {
		t.Fatal(err)
	}
	if _, err := wsCmd(t, cfg, "rename", "nope", "x"); err == nil || !strings.Contains(err.Error(), "没有 id") {
		t.Fatalf("改不存在的 = %v", err)
	}
	if _, err := wsCmd(t, cfg, "rename", l[1].ID, ""); err == nil {
		t.Fatal("空名称应拒绝")
	}
	l = wsList(t, cfg)
	if l[0].Name != "主库" || l[1].Name != "书架" {
		t.Fatalf("改名后 = %+v", l)
	}

	// remove：默认空间受保护；外部空间只删索引，外部文件一个都不动
	if _, err := wsCmd(t, cfg, "remove", "default"); err == nil || !strings.Contains(err.Error(), "默认工作空间不能删除") {
		t.Fatalf("删除默认 = %v", err)
	}
	if _, err := wsCmd(t, cfg, "remove", "nope"); err == nil {
		t.Fatal("删除不存在的应报错")
	}
	before := hashes(t, ext)
	out, err = wsCmd(t, cfg, "remove", l[2].ID)
	if err != nil || !strings.Contains(out, "没有动") {
		t.Fatalf("remove 外部 = %q %v", out, err)
	}
	if !sameHashes(before, hashes(t, ext)) || len(before) != 1 {
		t.Fatal("外部目录的文件被改动")
	}
	out, err = wsCmd(t, cfg, "remove", l[1].ID)
	if err != nil || !strings.Contains(out, "trash-workspaces/") {
		t.Fatalf("remove 内置 = %q %v", out, err)
	}
	if l = wsList(t, cfg); len(l) != 1 || l[0].ID != "default" {
		t.Fatalf("删除后 = %+v", l)
	}
	ents, _ := os.ReadDir(filepath.Join(cfg.DataDir, workspace.TrashDirName))
	if len(ents) != 2 {
		t.Fatalf("trash-workspaces 里应有两个被删空间的目录：%v", ents)
	}
}

func sameHashes(a, b map[string][32]byte) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

// 验收：服务运行中（数据目录被锁）执行任何子命令都报错退出，且不改动任何东西。
func TestWorkspaceCommandRefusesWhileRunning(t *testing.T) {
	cfg := newCLIConfig(t)
	unlock, err := ops.Lock(cfg.DataDir) // 模拟运行中的 lode serve
	if err != nil {
		t.Skipf("无法加锁：%v", err)
	}
	for _, args := range [][]string{{"list"}, {"add", "甲"}, {"add", "乙", "--dir", t.TempDir()}, {"rename", "default", "x"}, {"remove", "abc"}} {
		_, err := wsCmd(t, cfg, args...)
		if err == nil || !strings.Contains(err.Error(), "服务正在运行") {
			t.Errorf("lode workspace %v：服务运行中应报错，得到 %v", args, err)
		}
	}
	unlock()
	// 服务停止后可以执行，且之前的尝试没有留下任何登记
	if l := wsList(t, cfg); len(l) != 1 {
		t.Fatalf("列表 = %+v", l)
	}
}

func TestWorkspaceCommandUsageErrors(t *testing.T) {
	cfg := newCLIConfig(t)
	for _, args := range [][]string{
		nil, {"nope"}, {"add"}, {"add", "a", "b"}, {"add", "a", "--dir"}, {"add", "a", "--wat"},
		{"rename", "x"}, {"remove"}, {"remove", "a", "b"}, {"list", "x"},
	} {
		if _, err := wsCmd(t, cfg, args...); err == nil {
			t.Errorf("lode workspace %v 应报用法错误", args)
		}
	}
	// 数据目录里没有数据库：报错，不新建
	empty := config.Config{DataDir: t.TempDir()}
	if _, err := wsCmd(t, empty, "list"); err == nil || !strings.Contains(err.Error(), "没有数据库") {
		t.Fatalf("没有数据库 = %v", err)
	}
	if _, err := os.Stat(empty.DBPath()); err == nil {
		t.Fatal("不应新建数据库")
	}
}
