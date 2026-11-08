package ops

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
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
	if _, err := e.agent.UpdateSettings(ctx, agent.Settings{AutoApprove: true}); err != nil {
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
	if st, err := r.agent.Settings(ctx); err != nil || !st.AutoApprove {
		t.Errorf("助手设置：%+v %v", st, err)
	}
	cfg, err := r.agent.Config(ctx, ps[0].ID)
	if err != nil || cfg.APIKey != key {
		t.Errorf("供应商的 key 应能用同一主密钥解开：%v", err)
	}
}

// 未设置 LODE_SECRET_KEY 时由 secret.key 提供主密钥：备份 → 删除数据目录 → 恢复后，已保存的 key 仍可解密。
func TestBackupRestoreIncludesSecretKeyFile(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "data")
	e := open(t, dir)
	box, _, err := secret.Load("", dir)
	if err != nil {
		t.Fatal(err)
	}
	e.agent = agent.NewStore(e.db, box)
	key := "sk-backup-test-0000-1111"
	if _, err := e.agent.CreateProvider(ctx, agent.ProviderInput{Name: "测试", Kind: llm.KindOpenAI, APIKey: &key}); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "b.tar.gz")
	if err := Backup(ctx, e.db, dir, archive); err != nil {
		t.Fatal(err)
	}
	noSecret := filepath.Join(t.TempDir(), "n.tar.gz")
	if err := Backup(ctx, e.db, dir, noSecret, BackupOptions{ExcludeSecret: true}); err != nil {
		t.Fatal(err)
	}
	e.db.Close()
	os.RemoveAll(dir)

	if _, err := Restore(ctx, dir, archive); err != nil {
		t.Fatal(err)
	}
	box2, src, err := secret.Load("", dir)
	if err != nil || src != secret.SourceFile {
		t.Fatalf("恢复后应读到 secret.key：%v %v", src, err)
	}
	r := open(t, dir)
	defer r.db.Close()
	r.agent = agent.NewStore(r.db, box2)
	ps, _ := r.agent.Providers(ctx)
	if len(ps) != 1 {
		t.Fatal(ps)
	}
	if cfg, err := r.agent.Config(ctx, ps[0].ID); err != nil || cfg.APIKey != key {
		t.Errorf("恢复后 key 应可用：%v", err)
	}

	// 不含密钥的备份里没有 secret.key；恢复时不动现有的 secret.key
	old, _ := os.ReadFile(filepath.Join(dir, "secret.key"))
	r.db.Close()
	if _, err := Restore(ctx, dir, noSecret); err != nil {
		t.Fatal(err)
	}
	if now, _ := os.ReadFile(filepath.Join(dir, "secret.key")); string(now) != string(old) || len(old) == 0 {
		t.Error("不含密钥的备份不应改动现有 secret.key")
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

func TestSafeEntry(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"app.db", true},
		{"vault", true},
		{"vault/日记/今天.md", true},
		{"trash/a.md", true},
		{"../x", false},
		{"vault/../../x", false},
		{"/vault/x", false},
		{"other/x", false},
		{"app.db/x", false},
	}
	if runtime.GOOS == "windows" {
		cases = append(cases,
			struct {
				name string
				ok   bool
			}{`vault/..\..\x`, false},
			struct {
				name string
				ok   bool
			}{"vault/a:b", false},
			struct {
				name string
				ok   bool
			}{"vault/CON", false},
		)
	}
	for _, c := range cases {
		if got := safeEntry(c.name); got != c.ok {
			t.Errorf("safeEntry(%q) = %v，应为 %v", c.name, got, c.ok)
		}
	}
}

// 来自更新版本的备份、缺少 vault/ 的备份都拒绝，数据目录保持原样。
func TestRestoreRejectsNewerOrIncompleteBackup(t *testing.T) {
	ctx := context.Background()
	src := filepath.Join(t.TempDir(), "src")
	e := open(t, src)
	e.db.Close()
	dbBytes, err := os.ReadFile(filepath.Join(src, dbName))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, dbName), []byte("keep"), 0o600)

	newer := filepath.Join(t.TempDir(), "newer.tar.gz")
	writeTestArchive(t, newer, map[string]string{manifestName: `{"format":1,"version":"v9","db_version":9999}`, dbName: string(dbBytes), "vault/a.md": "x"})
	if _, err := Restore(ctx, dir, newer); err == nil || !strings.Contains(err.Error(), "更新的 Lode") {
		t.Errorf("应拒绝来自更新版本的备份：%v", err)
	}
	noVault := filepath.Join(t.TempDir(), "novault.tar.gz")
	writeTestArchive(t, noVault, map[string]string{manifestName: `{"format":1,"db_version":1}`, dbName: string(dbBytes)})
	if _, err := Restore(ctx, dir, noVault); err == nil || !strings.Contains(err.Error(), "vault") {
		t.Errorf("应拒绝没有 vault/ 的备份：%v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, dbName)); string(b) != "keep" {
		t.Error("恢复失败时不应改动数据目录")
	}
}

// 备份时 vault/ 还不存在（从未启动过），备份里也有空的 vault/，可以正常恢复。
func TestBackupOfEmptyDataDirRestores(t *testing.T) {
	ctx := context.Background()
	src := filepath.Join(t.TempDir(), "src")
	e := open(t, src)
	os.RemoveAll(filepath.Join(src, "vault"))
	archive := filepath.Join(t.TempDir(), "empty.tar.gz")
	if err := Backup(ctx, e.db, src, archive); err != nil {
		t.Fatal(err)
	}
	e.db.Close()
	if _, err := Restore(ctx, filepath.Join(t.TempDir(), "dst"), archive); err != nil {
		t.Fatal(err)
	}
}
