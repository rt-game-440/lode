package db

import (
	"context"
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
