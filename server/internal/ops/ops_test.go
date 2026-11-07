package ops

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/rt-game-440/lode/server/internal/agent"
	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/llm"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/secret"
	"github.com/rt-game-440/lode/server/internal/vault"
)

type env struct {
	dir   string
	db    *sql.DB
	notes *notes.Service
	auth  *auth.Auth
	agent *agent.Store
}

func open(t *testing.T, dir string) *env {
	t.Helper()
	os.MkdirAll(dir, 0o755)
	d, err := db.Open(context.Background(), filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	v, err := vault.New(filepath.Join(dir, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	return &env{dir: dir, db: d,
		notes: notes.New(notes.Options{DB: d, Vault: v, TrashDir: filepath.Join(dir, "trash")}),
		auth:  auth.New(d),
		agent: agent.NewStore(d, secret.New("backup-test-master-key"))}
}

// 备份（服务运行中）→ 删除数据目录 → 恢复后，笔记、附件、设置、供应商配置、API token 都完整。
func TestBackupRestoreRoundTrip(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "data")
	e := open(t, dir)
	if _, err := e.notes.Create(ctx, "日记/今天.md", "# 今天\n\n备份测试 [[其他]]\n"); err != nil {
		t.Fatal(err)
	}
	png := []byte("\x89PNG\r\n\x1a\nfake-image")
	att, err := e.notes.SaveAttachment(ctx, "图.png", bytes.NewReader(png), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.auth.Setup(ctx, "correct-horse"); err != nil {
		t.Fatal(err)
	}
	_, token, err := e.auth.CreateToken(ctx, "脚本", "write")
	if err != nil {
		t.Fatal(err)
	}
	key := "sk-backup-test-0000-1111"
	if _, err := e.agent.CreateProvider(ctx, agent.ProviderInput{Name: "测试", Kind: llm.KindOpenAI, APIKey: &key}); err != nil {
		t.Fatal(err)
	}

	archive := filepath.Join(t.TempDir(), "lode-backup.tar.gz")
	if err := Backup(ctx, e.db, dir, archive); err != nil { // 数据库仍然打开着
		t.Fatal(err)
	}
	e.db.Close()
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}

	if _, err := Restore(ctx, dir, archive); err != nil {
		t.Fatal(err)
	}
	r := open(t, dir)
	defer r.db.Close()
	n, err := r.notes.ReadByPath(ctx, "日记/今天.md")
	if err != nil || n.Content != "# 今天\n\n备份测试 [[其他]]\n" {
		t.Errorf("笔记：%+v %v", n, err)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "vault", filepath.FromSlash(att))); err != nil || !bytes.Equal(b, png) {
		t.Errorf("附件 %s：%v", att, err)
	}
	if err := r.auth.CheckPassword(ctx, "correct-horse"); err != nil {
		t.Errorf("登录密码：%v", err)
	}
	if _, err := r.auth.VerifyToken(ctx, token); err != nil {
		t.Errorf("API token：%v", err)
	}
	ps, err := r.agent.Providers(ctx)
	if err != nil || len(ps) != 1 {
		t.Fatalf("供应商：%v %v", ps, err)
	}
	cfg, err := r.agent.Config(ctx, ps[0].ID)
	if err != nil || cfg.APIKey != key {
		t.Errorf("供应商的 key 应能用同一主密钥解开：%v", err)
	}
}

// 恢复时原有数据移到 pre-restore-* 目录保留；服务正在运行（持有锁）时拒绝恢复。
func TestRestoreKeepsOldDataAndRefusesWhileRunning(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "data")
	e := open(t, dir)
	e.notes.Create(ctx, "旧.md", "旧内容\n")
	archive := filepath.Join(t.TempDir(), "b.tar.gz")
	if err := Backup(ctx, e.db, dir, archive); err != nil {
		t.Fatal(err)
	}
	e.notes.Create(ctx, "备份之后.md", "新内容\n")
	e.db.Close()

	unlock, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(ctx, dir, archive); !errors.Is(err, ErrLocked) {
		t.Errorf("服务运行中恢复应返回 ErrLocked，得到 %v", err)
	}
	if _, err := Lock(dir); !errors.Is(err, ErrLocked) {
		t.Errorf("同一数据目录不能被锁两次：%v", err)
	}
	unlock()

	kept, err := Restore(ctx, dir, archive)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(kept, "vault", "备份之后.md")); err != nil {
		t.Errorf("原有数据应保留在 %s：%v", kept, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "vault", "备份之后.md")); !os.IsNotExist(err) {
		t.Errorf("恢复后不应有备份之后才创建的笔记：%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "vault", "旧.md")); err != nil {
		t.Errorf("恢复后应有备份里的笔记：%v", err)
	}
}

// 不是 Lode 备份的文件、路径越界的条目都拒绝，数据目录保持原样。
func TestRestoreRejectsBadArchive(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	bad := filepath.Join(t.TempDir(), "bad.tar.gz")
	os.WriteFile(bad, []byte("not a tarball"), 0o600)
	os.WriteFile(filepath.Join(dir, "app.db"), []byte("keep"), 0o600)
	if _, err := Restore(ctx, dir, bad); err == nil {
		t.Fatal("应拒绝无效的备份文件")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "app.db")); string(b) != "keep" {
		t.Error("恢复失败时不应改动数据目录")
	}
	evil := filepath.Join(t.TempDir(), "evil.tar.gz")
	writeTestArchive(t, evil, map[string]string{manifestName: `{"format":1}`, "../escape.txt": "x"})
	if _, err := Restore(ctx, dir, evil); err == nil {
		t.Fatal("应拒绝路径越界的条目")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "escape.txt")); !os.IsNotExist(err) {
		t.Error("越界条目不应被写出")
	}
}
