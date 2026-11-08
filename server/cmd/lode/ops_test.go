package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/config"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/ops"
	"github.com/rt-game-440/lode/server/internal/passkey"
	"github.com/rt-game-440/lode/server/internal/passkey/passkeytest"
)

// reset-password 默认保留已登记的通行密钥，加 --clear-passkeys 才一并删除。
func TestResetPasswordPasskeys(t *testing.T) {
	ctx := context.Background()
	cfg := config.Config{DataDir: t.TempDir()}
	d, err := db.Open(ctx, cfg.DBPath())
	if err != nil {
		t.Fatal(err)
	}
	if err := auth.New(d).Setup(ctx, "old-password-1"); err != nil {
		t.Fatal(err)
	}
	svc := passkey.New(d, nil)
	rp, _ := passkey.RPFromHost("localhost:8787", false)
	register := func() {
		a := passkeytest.New()
		cer, creation, err := svc.BeginRegistration(ctx, rp, "电脑")
		if err != nil {
			t.Fatal(err)
		}
		opts, _ := json.Marshal(creation)
		cred, err := a.Create(opts, rp.Origin)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := svc.FinishRegistration(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred))); err != nil {
			t.Fatal(err)
		}
	}
	register()
	register()
	d.Close()

	reset := func(args ...string) {
		t.Helper()
		r, w, _ := os.Pipe()
		_, _ = w.WriteString("new-password-2\n")
		w.Close()
		old := os.Stdin
		os.Stdin = r
		defer func() { os.Stdin = old; r.Close() }()
		if err := runResetPassword(cfg, args); err != nil {
			t.Fatal(err)
		}
	}
	count := func() int {
		d, err := db.Open(ctx, cfg.DBPath())
		if err != nil {
			t.Fatal(err)
		}
		defer d.Close()
		list, err := passkey.New(d, nil).List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return len(list)
	}

	reset()
	if n := count(); n != 2 {
		t.Fatalf("默认应保留通行密钥，剩 %d 个", n)
	}
	reset("--clear-passkeys")
	if n := count(); n != 0 {
		t.Fatalf("--clear-passkeys 应删除全部，剩 %d 个", n)
	}
	// 密码确实被重置
	d, _ = db.Open(ctx, cfg.DBPath())
	defer d.Close()
	if err := auth.New(d).CheckPassword(ctx, "new-password-2"); err != nil {
		t.Fatalf("新密码应可用: %v", err)
	}
}

// takeValue 支持 --name 值 和 --name=值，缺值时报错。
func TestTakeValue(t *testing.T) {
	v, rest, err := takeValue([]string{"a", "--workspace", "k3", "b"}, "--workspace")
	if err != nil || v != "k3" || len(rest) != 2 || rest[0] != "a" || rest[1] != "b" {
		t.Errorf("%q %v %v", v, rest, err)
	}
	if v, rest, err = takeValue([]string{"--workspace=k4", "x"}, "--workspace"); err != nil || v != "k4" || len(rest) != 1 {
		t.Errorf("%q %v %v", v, rest, err)
	}
	if v, _, err = takeValue([]string{"x"}, "--workspace"); err != nil || v != "" {
		t.Errorf("没有参数时应为空：%q %v", v, err)
	}
	for _, a := range [][]string{{"--workspace"}, {"--workspace="}} {
		if _, _, err := takeValue(a, "--workspace"); err == nil {
			t.Errorf("%v 应报错", a)
		}
	}
}

// 命令行：backup --workspace 只备份一个空间；restore 外部目录非空时拒绝并提示 --external-to，指定后恢复到新位置。
func TestBackupRestoreCommandFlags(t *testing.T) {
	cfg := newCLIConfig(t)
	root := t.TempDir()
	ext := filepath.Join(root, "obsidian")
	os.MkdirAll(ext, 0o755)
	os.WriteFile(filepath.Join(ext, "库里的.md"), []byte("hello\n"), 0o644)
	if _, err := wsCmd(t, cfg, "add", "外部", "--dir", ext); err != nil {
		t.Fatal(err)
	}
	list := wsList(t, cfg)
	var id string
	for _, w := range list {
		if w.External {
			id = w.ID
		}
	}
	if id == "" {
		t.Fatalf("没有外部空间：%+v", list)
	}

	all := filepath.Join(root, "all.tar.gz")
	one := filepath.Join(root, "one.tar.gz")
	if err := runBackup(cfg, []string{all}); err != nil {
		t.Fatal(err)
	}
	if err := runBackup(cfg, []string{one, "--workspace", id}); err != nil {
		t.Fatal(err)
	}
	if err := runBackup(cfg, []string{filepath.Join(root, "bad.tar.gz"), "--workspace", "nosuch"}); err == nil {
		t.Error("不存在的工作空间应报错")
	}
	if err := runBackup(cfg, []string{filepath.Join(root, "bad2.tar.gz"), "--workspace"}); err == nil {
		t.Error("--workspace 缺值应报错")
	}
	m, err := ops.ReadManifest(one)
	if err != nil || m.ScopeOrAll() != ops.ScopeWorkspace || len(m.Workspaces) != 1 || m.Workspaces[0].ID != id {
		t.Fatalf("清单：%+v %v", m, err)
	}

	// 外部目录还在且非空
	err = runRestore(cfg, []string{all, "-y"}, nil)
	if !errors.Is(err, ops.ErrExternalNotEmpty) || !strings.Contains(err.Error(), "--external-to") {
		t.Fatalf("应拒绝并提示 --external-to：%v", err)
	}
	newDir := filepath.Join(root, "moved")
	if err := runRestore(cfg, []string{"--external-to", newDir, all, "-y"}, nil); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(newDir, id, "库里的.md")); err != nil || string(b) != "hello\n" {
		t.Errorf("新位置：%q %v", b, err)
	}
	for _, w := range wsList(t, cfg) {
		if w.ID == id && !strings.HasPrefix(w.VaultDir, newDir) {
			t.Errorf("登记的路径应更新：%+v", w)
		}
	}
	// 单空间备份：恢复到现在登记的新位置（先清空）
	os.RemoveAll(filepath.Join(newDir, id))
	if err := runRestore(cfg, []string{one, "-y"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(newDir, id, "库里的.md")); err != nil {
		t.Error(err)
	}
}
