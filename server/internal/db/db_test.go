package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOpenMigratesAndSupportsTrigramFTS(t *testing.T) {
	ctx := context.Background()
	d, err := Open(ctx, filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	v, err := Version(ctx, d)
	if err != nil || v != LatestVersion() {
		t.Fatalf("version = %d, %v; want %d", v, err, LatestVersion())
	}
	var mode string
	if err := d.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode = %q, %v", mode, err)
	}
	if _, err := d.Exec(`INSERT INTO notes_fts(rowid, title, body) VALUES (1, '测试', '我们正在实现中文全文搜索功能')`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := d.QueryRow(`SELECT count(*) FROM notes_fts WHERE notes_fts MATCH '"全文搜索"'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("trigram match = %d, %v", n, err)
	}
	// 再次迁移是幂等的
	if err := Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
}

// 已有数据库需要迁移时，先在 backups/ 下备份一份迁移前的数据库；新建或已是最新的数据库不备份。
func TestOpenBacksUpBeforeMigrating(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "app.db")
	// 模拟旧版本：只执行第一个迁移
	old, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	migs, _ := migrations()
	if _, err := old.Exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(migs[0].sql); err != nil {
		t.Fatal(err)
	}
	old.Exec(`INSERT INTO schema_migrations VALUES (?, 0)`, migs[0].version)
	old.Exec(`INSERT INTO settings(key, value) VALUES ('marker', 'v1')`)
	old.Close()

	d, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	files, _ := filepath.Glob(filepath.Join(dir, "backups", "*.db"))
	if len(files) != 1 {
		t.Fatalf("迁移前应备份一次，得到 %v", files)
	}
	b, err := sql.Open("sqlite", "file:"+filepath.ToSlash(files[0]))
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	var v int
	var marker string
	b.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&v)
	b.QueryRow(`SELECT value FROM settings WHERE key = 'marker'`).Scan(&marker)
	if v != migs[0].version || marker != "v1" {
		t.Errorf("备份应是迁移前的数据库：version=%d marker=%q", v, marker)
	}

	// 已是最新：再次打开不产生新备份
	d, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	if files, _ := filepath.Glob(filepath.Join(dir, "backups", "*.db")); len(files) != 1 {
		t.Errorf("没有待执行的迁移时不应备份：%v", files)
	}
	// 新建的数据库也不备份
	fresh := filepath.Join(t.TempDir(), "app.db")
	d, _ = Open(ctx, fresh)
	d.Close()
	if files, _ := filepath.Glob(filepath.Join(filepath.Dir(fresh), "backups", "*")); len(files) != 0 {
		t.Errorf("新数据库不应备份：%v", files)
	}
}
