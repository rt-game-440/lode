// Package ops 提供运维操作：备份、恢复和数据目录锁。
//
// 备份是一个 tar.gz：lode-backup.json（清单）、app.db（SQLite 在线快照）、vault/ 和 trash/。
// 服务运行中也可以备份；恢复必须在服务停止时进行，原有数据移到 pre-restore-<时间>/ 保留。
package ops

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/rt-game-440/lode/server/internal/db"
)

const (
	manifestName = "lode-backup.json"
	dbName       = "app.db"
	lockName     = ".lock"
)

// 备份里除数据库外的两个目录。
var dataDirs = []string{"vault", "trash"}

// ErrLocked 表示数据目录正被一个运行中的 lode 使用。
var ErrLocked = errors.New("数据目录正被运行中的 lode 使用")

// Version 是写进备份清单的 lode 版本，由 main 设置。
var Version = "dev"

// Manifest 是备份清单。
type Manifest struct {
	Format    int    `json:"format"`     // 备份格式版本，目前为 1
	Version   string `json:"version"`    // 生成备份的 lode 版本
	DBVersion int    `json:"db_version"` // 数据库迁移版本
	CreatedAt string `json:"created_at"` // RFC 3339
}

// Lock 锁定数据目录，防止两个进程同时使用；返回解锁函数。已被锁定时返回 ErrLocked。
// 用的是操作系统的文件锁，进程退出（包括崩溃）时自动释放。
func Lock(dataDir string) (func(), error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dataDir, lockName), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		f.Close()
		return nil, ErrLocked
	}
	return func() { f.Close() }, nil
}

// Backup 把数据库快照和笔记文件打包到 out（tar.gz）。d 是已打开的数据库，服务运行中也可以执行。
func Backup(ctx context.Context, d *sql.DB, dataDir, out string) error {
	out, err := filepath.Abs(out)
	if err != nil {
		return err
	}
	tmpDir, err := os.MkdirTemp(filepath.Dir(out), ".lode-backup-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)
	snap := filepath.Join(tmpDir, dbName)
	if err := db.Snapshot(ctx, d, snap); err != nil {
		return fmt.Errorf("数据库快照: %w", err)
	}
	dbv, err := db.Version(ctx, d)
	if err != nil {
		return err
	}
	part := filepath.Join(tmpDir, "backup.tar.gz")
	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	m, _ := json.MarshalIndent(Manifest{Format: 1, Version: Version, DBVersion: dbv, CreatedAt: time.Now().Format(time.RFC3339)}, "", "  ")
	if err := tw.WriteHeader(&tar.Header{Name: manifestName, Mode: 0o600, Size: int64(len(m)), ModTime: time.Now(), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err := tw.Write(m); err != nil {
		return err
	}
	if err := addFile(tw, snap, dbName); err != nil {
		return err
	}
	for _, sub := range dataDirs {
		if err := addDir(ctx, tw, dataDir, sub); err != nil {
			return fmt.Errorf("打包 %s: %w", sub, err)
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(part, out)
}

// addDir 把 dataDir/sub 下的目录和普通文件写进 tar，跳过符号链接；遍历中被删除的文件忽略。
func addDir(ctx context.Context, tw *tar.Writer, dataDir, sub string) error {
	return filepath.WalkDir(filepath.Join(dataDir, sub), func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(dataDir, p)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		switch {
		case e.IsDir():
			return tw.WriteHeader(&tar.Header{Name: name + "/", Mode: 0o755, Typeflag: tar.TypeDir, ModTime: time.Now()})
		case e.Type().IsRegular():
			if err := addFile(tw, p, name); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
		return nil
	})
}

func addFile(tw *tar.Writer, src, name string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: st.Size(), ModTime: st.ModTime(), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	// 文件在打包过程中被改写时只取 Size 字节，保证 tar 条目完整
	_, err = io.CopyN(tw, f, st.Size())
	return err
}

// Restore 用备份替换数据目录里的数据库和笔记文件，必须在服务停止时执行（否则返回 ErrLocked）。
// 原有数据移到 dataDir/pre-restore-<时间>/ 并返回该路径（没有原有数据时返回空串）。
// 备份文件无效时不改动数据目录。
func Restore(ctx context.Context, dataDir, archive string) (string, error) {
	unlock, err := Lock(dataDir)
	if err != nil {
		return "", err
	}
	defer unlock()

	staging, err := os.MkdirTemp(dataDir, ".restore-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)
	if err := extract(ctx, archive, staging); err != nil {
		return "", fmt.Errorf("读取备份: %w", err)
	}
	if err := checkDB(ctx, filepath.Join(staging, dbName)); err != nil {
		return "", fmt.Errorf("备份里的数据库无效: %w", err)
	}

	// 原有数据移走保留
	kept := filepath.Join(dataDir, "pre-restore-"+time.Now().Format("20060102-150405"))
	moved := false
	for _, name := range append([]string{dbName, dbName + "-wal", dbName + "-shm"}, dataDirs...) {
		src := filepath.Join(dataDir, name)
		if _, err := os.Lstat(src); err != nil {
			continue
		}
		if !moved {
			if err := os.MkdirAll(kept, 0o700); err != nil {
				return "", err
			}
			moved = true
		}
		if err := os.Rename(src, filepath.Join(kept, name)); err != nil {
			return kept, fmt.Errorf("移走原有的 %s: %w（已移走的在 %s）", name, err, kept)
		}
	}
	for _, name := range append([]string{dbName}, dataDirs...) {
		src := filepath.Join(staging, name)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		if err := os.Rename(src, filepath.Join(dataDir, name)); err != nil {
			return kept, fmt.Errorf("放入 %s: %w（原有数据在 %s）", name, err, kept)
		}
	}
	if !moved {
		kept = ""
	}
	return kept, nil
}

// extract 解出备份到 dst。第一个条目必须是清单；只接受 app.db、vault/、trash/ 下的普通文件和目录。
func extract(ctx context.Context, archive, dst string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return errors.New("不是 Lode 备份文件（不是 gzip）")
	}
	tr := tar.NewReader(gz)
	first := true
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if first {
			first = false
			if h.Name != manifestName {
				return errors.New("不是 Lode 备份文件（缺少清单）")
			}
			var m Manifest
			if err := json.NewDecoder(io.LimitReader(tr, 1<<16)).Decode(&m); err != nil || m.Format != 1 {
				return errors.New("不支持的备份格式")
			}
			continue
		}
		name := strings.TrimSuffix(h.Name, "/")
		top, _, _ := strings.Cut(name, "/")
		if !fs.ValidPath(name) || path.Clean(name) != name || (name != dbName && top != "vault" && top != "trash") {
			return fmt.Errorf("备份里有不允许的条目: %q", h.Name)
		}
		target := filepath.Join(dst, filepath.FromSlash(name))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := writeEntry(tr, target, h.ModTime); err != nil {
				return err
			}
		default:
			return fmt.Errorf("备份里有不支持的条目类型: %q", h.Name)
		}
	}
	if first {
		return errors.New("备份文件是空的")
	}
	return nil
}

func writeEntry(r io.Reader, target string, mtime time.Time) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, r); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chtimes(target, mtime, mtime)
}

// checkDB 确认数据库能打开且完整。
func checkDB(ctx context.Context, p string) error {
	if _, err := os.Stat(p); err != nil {
		return errors.New("备份里没有数据库")
	}
	d, err := sql.Open("sqlite", "file:"+filepath.ToSlash(p)+"?mode=ro")
	if err != nil {
		return err
	}
	defer d.Close()
	var res string
	if err := d.QueryRowContext(ctx, `PRAGMA quick_check`).Scan(&res); err != nil {
		return err
	}
	if res != "ok" {
		return errors.New(res)
	}
	return nil
}
