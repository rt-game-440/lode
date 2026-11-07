// Package db 打开 SQLite 数据库并执行迁移。
package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // 纯 Go SQLite 驱动
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Connect 打开（必要时创建）数据库并设置连接参数，不执行迁移。
func Connect(ctx context.Context, path string) (*sql.DB, error) {
	q := url.Values{}
	for _, p := range []string{
		"journal_mode(WAL)",
		"busy_timeout(5000)",
		"foreign_keys(1)",
		"synchronous(NORMAL)",
		"cache_size(-2000)", // 每个连接约 2MB 页缓存
		"temp_store(MEMORY)",
	} {
		q.Add("_pragma", p)
	}
	dsn := "file:" + filepath.ToSlash(path) + "?" + q.Encode()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// 单用户应用，少量连接即可；空闲连接定期关闭以释放页缓存。
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(1)
	db.SetConnMaxIdleTime(time.Minute)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// Open 打开数据库并执行迁移；已有数据库需要迁移时先在 backups/ 下备份。
func Open(ctx context.Context, path string) (*sql.DB, error) {
	db, err := Connect(ctx, path)
	if err != nil {
		return nil, err
	}
	if err := backupBeforeMigrate(ctx, db, path); err != nil {
		db.Close()
		return nil, fmt.Errorf("迁移前备份数据库: %w", err)
	}
	if err := Migrate(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// keepMigrationBackups 是保留的迁移前备份数量，更早的删除。
const keepMigrationBackups = 5

// backupBeforeMigrate 在已有数据库有待执行的迁移时，把当前数据库备份到同目录的 backups/ 下。
// 新建的数据库（还没有迁移记录）不备份。
func backupBeforeMigrate(ctx context.Context, db *sql.DB, path string) error {
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).Scan(&n); err != nil || n == 0 {
		return err
	}
	cur, err := Version(ctx, db)
	if err != nil || cur == 0 || cur >= LatestVersion() {
		return err
	}
	dir := filepath.Join(filepath.Dir(path), "backups")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	out := filepath.Join(dir, fmt.Sprintf("app-v%d-%s.db", cur, time.Now().Format("20060102-150405")))
	if err := Snapshot(ctx, db, out); err != nil {
		return err
	}
	// 只保留最近的几份
	old, _ := filepath.Glob(filepath.Join(dir, "app-v*.db"))
	sort.Slice(old, func(i, j int) bool { return modTime(old[i]).Before(modTime(old[j])) })
	for len(old) > keepMigrationBackups {
		os.Remove(old[0])
		old = old[1:]
	}
	return nil
}

// Snapshot 用 VACUUM INTO 把数据库一致地复制到 out（服务运行中也可以执行）。out 不能已存在。
func Snapshot(ctx context.Context, db *sql.DB, out string) error {
	_, err := db.ExecContext(ctx, `VACUUM INTO ?`, out)
	return err
}

func modTime(p string) time.Time {
	st, err := os.Stat(p)
	if err != nil {
		return time.Time{}
	}
	return st.ModTime()
}

// Migrate 按文件名顺序执行未执行过的迁移。迁移文件名形如 0001_xxx.sql。
func Migrate(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		return err
	}
	current, err := Version(ctx, db)
	if err != nil {
		return err
	}
	migs, err := migrations()
	if err != nil {
		return err
	}
	for _, m := range migs {
		if m.version <= current {
			continue
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, m.sql); err != nil {
			tx.Rollback()
			return fmt.Errorf("迁移 %s 失败: %w", m.name, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)`, m.version, time.Now().UnixMilli()); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Version 返回当前已执行的最高迁移版本。
func Version(ctx context.Context, db *sql.DB) (int, error) {
	var v sql.NullInt64
	err := db.QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&v)
	if err != nil {
		return 0, err
	}
	return int(v.Int64), nil
}

// LatestVersion 返回内嵌迁移中的最高版本号。
func LatestVersion() int {
	migs, _ := migrations()
	if len(migs) == 0 {
		return 0
	}
	return migs[len(migs)-1].version
}

type migration struct {
	version int
	name    string
	sql     string
}

func migrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return nil, err
	}
	var out []migration
	for _, e := range entries {
		name := e.Name()
		num, _, ok := strings.Cut(name, "_")
		if !ok {
			continue
		}
		v, err := strconv.Atoi(num)
		if err != nil {
			return nil, fmt.Errorf("迁移文件名不合法: %s", name)
		}
		b, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return nil, err
		}
		out = append(out, migration{version: v, name: name, sql: string(b)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}
