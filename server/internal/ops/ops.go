// Package ops 提供运维操作：备份、恢复和数据目录锁。
//
// 备份是一个 tar.gz，布局（格式 2）：
//
//	lode-backup.json                清单：范围、每个工作空间（外部目录记原路径）
//	app.db                          全局库快照（同时是默认工作空间的索引）
//	secret.key                      主密钥（完整备份默认包含）
//	vault/  trash/                  默认工作空间
//	workspaces/<id>/index.db        其他工作空间的索引快照
//	workspaces/<id>/vault/          其他工作空间的笔记（外部目录的笔记也放在这里）
//	workspaces/<id>/trash/          其他工作空间的回收站
//
// 阶段 6 的备份（格式 1）没有 workspaces/ 和清单里的工作空间，按“只有默认工作空间”恢复。
// 服务运行中也可以备份；恢复必须在服务停止时进行，原有数据移到 pre-restore-<时间>/ 保留。
// 语义和限制见 docs/deploy.md。
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
	"runtime"
	"strings"
	"time"

	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/keyprotect"
	"github.com/rt-game-440/lode/server/internal/workspace"
)

const (
	manifestName = "lode-backup.json"
	dbName       = "app.db"
	indexName    = "index.db"
	lockName     = ".lock"
	secretName   = "secret.key" // 助手 API key 的主密钥，默认随备份一起打包
	wsDirName    = workspace.DirName
)

// 清单里的备份范围。
const (
	ScopeAll       = "all"       // 完整备份：全部工作空间 + 全局数据（默认）
	ScopeWorkspace = "workspace" // 只备份一个工作空间
)

// BackupOptions 是备份选项。
type BackupOptions struct {
	ExcludeSecret bool // 不打包 secret.key；恢复后已保存的 API key 需要重新填写（除非用同一个 LODE_SECRET_KEY）
	// Workspace 非空时只备份这一个工作空间（id）。这种备份不含 secret.key 和全局数据，
	// 恢复时只替换该工作空间，不影响其他空间。
	Workspace string
}

// 备份里默认工作空间的两个目录。
var dataDirs = []string{"vault", "trash"}

// ErrLocked 表示数据目录正被一个运行中的 lode 使用。
var ErrLocked = errors.New("数据目录正被运行中的 lode 使用")

// ErrWorkspaceNotFound 表示 --workspace 指定的工作空间没有登记。
var ErrWorkspaceNotFound = errors.New("没有这个工作空间")

// Version 是写进备份清单的 lode 版本，由 main 设置。
var Version = "dev"

// 当前写出的备份格式。恢复接受 1（阶段 6）和 2。
const manifestFormat = 2

// Manifest 是备份清单。
type Manifest struct {
	Format    int    `json:"format"`     // 备份格式版本：1 是阶段 6 的格式，2 带工作空间
	Version   string `json:"version"`    // 生成备份的 lode 版本
	DBVersion int    `json:"db_version"` // 数据库迁移版本
	CreatedAt string `json:"created_at"` // RFC 3339
	// Scope 是 all（缺省）或 workspace。
	Scope string `json:"scope,omitempty"`
	// Workspaces 是备份里的工作空间；格式 1 没有这一项，按只有默认工作空间处理。
	Workspaces []WorkspaceEntry `json:"workspaces,omitempty"`
}

// WorkspaceEntry 是清单里的一个工作空间。
type WorkspaceEntry struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Sort      int    `json:"sort"`
	CreatedAt int64  `json:"created_at"` // unix 毫秒
	External  bool   `json:"external,omitempty"`
	// VaultDir 只在外部目录时有值：备份时的原路径。
	VaultDir string `json:"vault_dir,omitempty"`
}

// Entries 返回备份里的工作空间；格式 1 的备份只有默认工作空间。
func (m Manifest) Entries() []WorkspaceEntry {
	if len(m.Workspaces) == 0 {
		return []WorkspaceEntry{{ID: workspace.DefaultID, Name: workspace.DefaultName}}
	}
	return m.Workspaces
}

// ScopeOrAll 返回备份范围，缺省是 all。
func (m Manifest) ScopeOrAll() string {
	if m.Scope == "" {
		return ScopeAll
	}
	return m.Scope
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
		if errors.Is(err, errLockBusy) {
			return nil, ErrLocked
		}
		// 文件系统不支持加锁（部分 NFS、SMB 挂载）：不阻止使用，由调用方提示风险
		return func() {}, fmt.Errorf("%w: %v", ErrLockUnsupported, err)
	}
	return func() { f.Close() }, nil
}

// ErrLockUnsupported 表示数据目录所在的文件系统不支持文件锁。Lock 返回它时同时返回一个空的解锁函数，
// 调用方可以提示后继续，只是失去了“防止两个进程同时使用”的保护。
var ErrLockUnsupported = errors.New("数据目录所在的文件系统不支持文件锁")

// errLockBusy 由各平台的 lockFile 在锁已被其他进程持有时返回。
var errLockBusy = errors.New("lock busy")

// listWorkspaces 读登记表。没有登记表（旧版本的库）或没有默认空间的登记时，补上默认工作空间。
func listWorkspaces(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}) ([]WorkspaceEntry, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, name, vault_dir, sort, created_at FROM workspaces ORDER BY sort, created_at, id`)
	if err != nil {
		if strings.Contains(err.Error(), "no such table") {
			return []WorkspaceEntry{{ID: workspace.DefaultID, Name: workspace.DefaultName}}, nil
		}
		return nil, err
	}
	defer rows.Close()
	var out []WorkspaceEntry
	hasDefault := false
	for rows.Next() {
		var e WorkspaceEntry
		var vaultDir string
		if err := rows.Scan(&e.ID, &e.Name, &vaultDir, &e.Sort, &e.CreatedAt); err != nil {
			return nil, err
		}
		if e.ID == workspace.DefaultID {
			hasDefault = true
		} else if vaultDir != "" {
			e.External, e.VaultDir = true, vaultDir
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !hasDefault {
		out = append([]WorkspaceEntry{{ID: workspace.DefaultID, Name: workspace.DefaultName}}, out...)
	}
	return out, nil
}

// Backup 把数据库快照和笔记文件打包到 out（tar.gz）。d 是已打开的数据库（app.db），服务运行中也可以执行。
// 默认备份全部工作空间；opts.Workspace 非空时只备份该空间。
func Backup(ctx context.Context, d *sql.DB, dataDir, out string, opts ...BackupOptions) error {
	var opt BackupOptions
	if len(opts) > 0 {
		opt = opts[0]
	}
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

	// 工作空间清单从快照里读，保证和打包的 app.db 一致
	snapDB, err := openRO(snap)
	if err != nil {
		return err
	}
	entries, err := listWorkspaces(ctx, snapDB)
	snapDB.Close()
	if err != nil {
		return err
	}
	scope := ScopeAll
	if opt.Workspace != "" {
		scope = ScopeWorkspace
		var one []WorkspaceEntry
		for _, e := range entries {
			if e.ID == opt.Workspace {
				one = append(one, e)
			}
		}
		if len(one) == 0 {
			return fmt.Errorf("%w: %q（lode workspace list 可以查看）", ErrWorkspaceNotFound, opt.Workspace)
		}
		entries = one
	}
	// 其他工作空间的索引快照
	indexSnaps := map[string]string{}
	for _, e := range entries {
		if e.ID == workspace.DefaultID {
			continue
		}
		p := workspace.PathsFor(dataDir, e.ID, e.VaultDir)
		if _, err := os.Stat(p.Index); err != nil {
			continue // 还没打开过：没有索引，恢复后重新对账
		}
		wd, err := db.Connect(ctx, p.Index)
		if err != nil {
			return fmt.Errorf("打开工作空间 %s 的索引: %w", e.ID, err)
		}
		dst := filepath.Join(tmpDir, "index-"+e.ID+".db")
		err = db.Snapshot(ctx, wd, dst)
		wd.Close()
		if err != nil {
			return fmt.Errorf("工作空间 %s 的索引快照: %w", e.ID, err)
		}
		indexSnaps[e.ID] = dst
	}

	part := filepath.Join(tmpDir, "backup.tar.gz")
	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	mf := Manifest{Format: manifestFormat, Version: Version, DBVersion: dbv, CreatedAt: time.Now().Format(time.RFC3339), Scope: scope, Workspaces: entries}
	m, _ := json.MarshalIndent(mf, "", "  ")
	if err := tw.WriteHeader(&tar.Header{Name: manifestName, Mode: 0o600, Size: int64(len(m)), ModTime: time.Now(), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err := tw.Write(m); err != nil {
		return err
	}
	for _, e := range entries {
		if e.ID == workspace.DefaultID {
			// 默认工作空间的索引在 app.db 里；完整备份带全局数据，单空间备份也带上（恢复时只取属于默认空间的表）
			if err := addFile(tw, snap, dbName); err != nil {
				return err
			}
			if scope == ScopeAll && !opt.ExcludeSecret {
				if err := addFileMode(tw, filepath.Join(dataDir, secretName), secretName, 0o600); err != nil && !errors.Is(err, fs.ErrNotExist) {
					return fmt.Errorf("打包 %s: %w", secretName, err)
				}
			}
			for _, sub := range dataDirs {
				if err := addTree(ctx, tw, filepath.Join(dataDir, sub), sub, false); err != nil {
					return fmt.Errorf("打包 %s: %w", sub, err)
				}
			}
			continue
		}
		p := workspace.PathsFor(dataDir, e.ID, e.VaultDir)
		pre := wsDirName + "/" + e.ID
		if err := writeDir(tw, wsDirName); err != nil {
			return err
		}
		if err := writeDir(tw, pre); err != nil {
			return err
		}
		if snap, ok := indexSnaps[e.ID]; ok {
			if err := addFile(tw, snap, pre+"/"+indexName); err != nil {
				return err
			}
		}
		if err := addTree(ctx, tw, p.Vault, pre+"/vault", e.External); err != nil {
			return fmt.Errorf("打包工作空间 %s 的笔记: %w", e.ID, err)
		}
		if err := addTree(ctx, tw, p.Trash, pre+"/trash", false); err != nil {
			return fmt.Errorf("打包工作空间 %s 的回收站: %w", e.ID, err)
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

func writeDir(tw *tar.Writer, name string) error {
	// 同一个目录条目重复写入无害，解包时 MkdirAll
	return tw.WriteHeader(&tar.Header{Name: name + "/", Mode: 0o755, Typeflag: tar.TypeDir, ModTime: time.Now()})
}

// addTree 把 src 目录下的目录和普通文件写进 tar（根为 prefix），跳过符号链接；遍历中被删除的文件忽略。
// src 不存在时写一个空目录条目（恢复时据此确认备份完整）；mustExist 为真（外部目录）时改为报错：
// 卷没挂载时打出一个空的备份比失败更危险。
func addTree(ctx context.Context, tw *tar.Writer, src, prefix string, mustExist bool) error {
	if _, err := os.Stat(src); errors.Is(err, fs.ErrNotExist) {
		if mustExist {
			return fmt.Errorf("笔记目录 %s 不存在或不可用", src)
		}
		return writeDir(tw, prefix)
	}
	if mustExist {
		if r, err := filepath.EvalSymlinks(src); err == nil {
			src = r
		}
	}
	return filepath.WalkDir(src, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		name := prefix
		if rel != "." {
			name += "/" + filepath.ToSlash(rel)
		}
		switch {
		case e.IsDir():
			return writeDir(tw, name)
		case e.Type().IsRegular():
			if err := addFile(tw, p, name); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
		return nil
	})
}

func addFile(tw *tar.Writer, src, name string) error { return addFileMode(tw, src, name, 0o644) }

func addFileMode(tw *tar.Writer, src, name string, mode int64) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: st.Size(), ModTime: st.ModTime(), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	// 文件在打包过程中被改写时只取 Size 字节，保证 tar 条目完整
	_, err = io.CopyN(tw, f, st.Size())
	return err
}

// ReadManifest 只读备份文件的清单（不解包），用来在恢复前告诉用户里面有什么。
func ReadManifest(archive string) (Manifest, error) {
	var m Manifest
	f, err := os.Open(archive)
	if err != nil {
		return m, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return m, errors.New("不是 Lode 备份文件（不是 gzip）")
	}
	tr := tar.NewReader(gz)
	h, err := tr.Next()
	if err != nil || h.Name != manifestName {
		return m, errors.New("不是 Lode 备份文件（缺少清单）")
	}
	return decodeManifest(tr)
}

func decodeManifest(r io.Reader) (Manifest, error) {
	var m Manifest
	if err := json.NewDecoder(io.LimitReader(r, 1<<20)).Decode(&m); err != nil || (m.Format != 1 && m.Format != 2) {
		return m, errors.New("不支持的备份格式")
	}
	if s := m.ScopeOrAll(); s != ScopeAll && s != ScopeWorkspace {
		return m, fmt.Errorf("不支持的备份范围 %q", m.Scope)
	}
	return m, nil
}

// extract 解出备份到 dst 并返回清单。第一个条目必须是清单；只接受 safeEntry 允许的普通文件和目录。
func extract(ctx context.Context, archive, dst string) (Manifest, error) {
	var m Manifest
	f, err := os.Open(archive)
	if err != nil {
		return m, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return m, errors.New("不是 Lode 备份文件（不是 gzip）")
	}
	tr := tar.NewReader(gz)
	first := true
	for {
		if err := ctx.Err(); err != nil {
			return m, err
		}
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return m, err
		}
		if first {
			first = false
			if h.Name != manifestName {
				return m, errors.New("不是 Lode 备份文件（缺少清单）")
			}
			if m, err = decodeManifest(tr); err != nil {
				return m, err
			}
			continue
		}
		name := strings.TrimSuffix(h.Name, "/")
		if !safeEntry(name) {
			return m, fmt.Errorf("备份里有不允许的条目: %q", h.Name)
		}
		target := filepath.Join(dst, filepath.FromSlash(name))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return m, err
			}
		case tar.TypeReg:
			if err := writeEntry(tr, target, h.ModTime); err != nil {
				return m, err
			}
			if name == secretName {
				os.Chmod(target, 0o600)
			}
		default:
			return m, fmt.Errorf("备份里有不支持的条目类型: %q", h.Name)
		}
	}
	if first {
		return m, errors.New("备份文件是空的")
	}
	return m, nil
}

// safeEntry 判断 tar 条目名能否安全解到临时目录里。允许的名字：
//
//	app.db、secret.key、vault/…、trash/…                      默认工作空间和全局数据
//	workspaces、workspaces/<id>、workspaces/<id>/index.db、
//	workspaces/<id>/vault/…、workspaces/<id>/trash/…           其他工作空间（<id> 必须是合法 id 且不是 default）
//
// 不能有 ..、绝对路径；Windows 上还不能含 \（会被当成分隔符）、:（盘符和备用数据流）和保留设备名。
func safeEntry(name string) bool {
	if !fs.ValidPath(name) || path.Clean(name) != name {
		return false
	}
	parts := strings.Split(name, "/")
	ok := false
	switch parts[0] {
	case dbName, secretName:
		ok = len(parts) == 1
	case "vault", "trash":
		ok = true
	case wsDirName:
		switch {
		case len(parts) == 1:
			ok = true
		case !workspace.ValidID(parts[1]) || parts[1] == workspace.DefaultID:
		case len(parts) == 2:
			ok = true
		case parts[2] == indexName:
			ok = len(parts) == 3
		case parts[2] == "vault" || parts[2] == "trash":
			ok = true
		}
	}
	if !ok {
		return false
	}
	if runtime.GOOS == "windows" && strings.ContainsAny(name, `\:`) {
		return false
	}
	return filepath.IsLocal(filepath.FromSlash(name))
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

// openRO 只读打开 SQLite 数据库文件。
func openRO(p string) (*sql.DB, error) {
	// URI 里 % ? # 有特殊含义，路径中出现时要转义
	esc := strings.NewReplacer("%", "%25", "?", "%3f", "#", "%23").Replace(filepath.ToSlash(p))
	return sql.Open("sqlite", "file:"+esc+"?mode=ro")
}

// protectedDB 判断数据库是否开启了“用通行密钥保护 API key”；读不出来（旧版本没有这项设置等）按未开启处理。
func protectedDB(ctx context.Context, p string) bool {
	d, err := openRO(p)
	if err != nil {
		return false
	}
	defer d.Close()
	on, _ := keyprotect.Enabled(ctx, d)
	return on
}

// checkDB 确认数据库能打开且完整。
func checkDB(ctx context.Context, p string) error {
	if _, err := os.Stat(p); err != nil {
		return errors.New("备份里没有数据库")
	}
	d, err := openRO(p)
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

// dbVersion 只读取数据库文件的迁移版本。
func dbVersion(ctx context.Context, p string) (int, error) {
	d, err := openRO(p)
	if err != nil {
		return 0, err
	}
	defer d.Close()
	return db.Version(ctx, d)
}
