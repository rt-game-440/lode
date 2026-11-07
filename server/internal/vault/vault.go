// Package vault 负责 vault 目录中的文件读写：路径校验（防目录穿越）、原子写入和遍历。
//
// 所有对外路径都是相对 vault 根目录、用 "/" 分隔的路径，例如 "日记/2026-11-07.md"。
package vault

import (
	"crypto/rand"
	"encoding/hex"
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
	"unicode/utf8"
)

// ErrInvalidPath 表示路径不合法（越出 vault、绝对路径、隐藏目录等）。
var ErrInvalidPath = errors.New("invalid path")

// Vault 表示磁盘上的 vault 根目录。
type Vault struct {
	root string
}

// New 创建 vault，根目录不存在时自动创建。
func New(root string) (*Vault, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	return &Vault{root: abs}, nil
}

// Resolve 返回 rel 的绝对路径，并确认路径上已存在的各段都不是符号链接或 Windows 目录联接。
// 与 Walk 一致：vault 内不跟随链接，防止经链接读写到 vault 之外。
func (v *Vault) Resolve(rel string) (string, error) {
	p := v.root
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" {
			continue
		}
		p = filepath.Join(p, seg)
		info, err := os.Lstat(p)
		if err != nil {
			break // 不存在的部分稍后会被创建
		}
		if info.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			return "", fmt.Errorf("%w: 路径经过符号链接", ErrInvalidPath)
		}
	}
	return v.Abs(rel), nil
}

// Root 返回 vault 根目录的绝对路径。
func (v *Vault) Root() string { return v.root }

// Clean 校验并规范化相对路径。允许空串表示根目录（allowRoot 为 true 时）。
// 拒绝：绝对路径、盘符、".." 越界、以 "." 开头的段（隐藏文件与 .obsidian 等）、控制字符。
func Clean(p string, allowRoot bool) (string, error) {
	p = strings.TrimSpace(strings.ReplaceAll(p, "\\", "/"))
	if p == "" || p == "/" || p == "." {
		if allowRoot {
			return "", nil
		}
		return "", fmt.Errorf("%w: 路径为空", ErrInvalidPath)
	}
	if !utf8.ValidString(p) {
		return "", fmt.Errorf("%w: 不是合法的 UTF-8", ErrInvalidPath)
	}
	if strings.HasPrefix(p, "/") || strings.Contains(p, ":") {
		return "", fmt.Errorf("%w: 不允许绝对路径或盘符", ErrInvalidPath)
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(`<>"|?*`, r) {
			return "", fmt.Errorf("%w: 含有非法字符", ErrInvalidPath)
		}
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return "", fmt.Errorf("%w: 不允许 ..", ErrInvalidPath)
		}
	}
	c := path.Clean(p)
	if c == "." {
		if allowRoot {
			return "", nil
		}
		return "", fmt.Errorf("%w: 路径为空", ErrInvalidPath)
	}
	for _, seg := range strings.Split(c, "/") {
		if strings.HasPrefix(seg, ".") {
			return "", fmt.Errorf("%w: 不允许以 . 开头的文件或目录", ErrInvalidPath)
		}
		if strings.TrimRight(seg, " ") != seg {
			return "", fmt.Errorf("%w: 文件名不能以空格结尾", ErrInvalidPath)
		}
	}
	if !filepath.IsLocal(filepath.FromSlash(c)) {
		return "", fmt.Errorf("%w: 路径越出 vault", ErrInvalidPath)
	}
	return c, nil
}

// CleanNotePath 校验笔记路径，必须以 .md 结尾。
func CleanNotePath(p string) (string, error) {
	c, err := Clean(p, false)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(path.Ext(c), ".md") || len(path.Base(c)) <= 3 {
		return "", fmt.Errorf("%w: 笔记路径必须以 .md 结尾", ErrInvalidPath)
	}
	return c, nil
}

// Abs 把已校验的相对路径转为绝对路径。
func (v *Vault) Abs(rel string) string {
	if rel == "" {
		return v.root
	}
	return filepath.Join(v.root, filepath.FromSlash(rel))
}

// Rel 把 vault 内的绝对路径转为相对路径；不在 vault 内时返回 false。
func (v *Vault) Rel(abs string) (string, bool) {
	r, err := filepath.Rel(v.root, abs)
	if err != nil || !filepath.IsLocal(r) && r != "." {
		return "", false
	}
	if r == "." {
		return "", true
	}
	return filepath.ToSlash(r), true
}

// ReadFile 读取文件内容。
func (v *Vault) ReadFile(rel string) ([]byte, error) {
	abs, err := v.Resolve(rel)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(abs)
}

// Stat 返回文件信息。
func (v *Vault) Stat(rel string) (fs.FileInfo, error) {
	return os.Stat(v.Abs(rel))
}

// Exists 判断路径是否存在（不区分文件或目录）。
func (v *Vault) Exists(rel string) bool {
	_, err := os.Lstat(v.Abs(rel))
	return err == nil
}

// WriteFile 原子写入：先写同目录的临时文件并 fsync，再 rename 覆盖目标。
func (v *Vault) WriteFile(rel string, data []byte) (fs.FileInfo, error) {
	abs, err := v.Resolve(rel)
	if err != nil {
		return nil, err
	}
	return AtomicWrite(abs, data)
}

// CreateFile 原子创建新文件，目标已存在时返回 fs.ErrExist。
func (v *Vault) CreateFile(rel string, data []byte) (fs.FileInfo, error) {
	abs, err := v.Resolve(rel)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	// 先用 O_EXCL 占位，保证并发与大小写不敏感文件系统下也不会覆盖已有文件。
	f, err := os.OpenFile(abs, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, err
	}
	f.Close()
	info, err := AtomicWrite(abs, data)
	if err != nil {
		os.Remove(abs)
		return nil, err
	}
	return info, nil
}

// AtomicWrite 以"临时文件 + rename"的方式写入任意绝对路径。
func AtomicWrite(abs string, data []byte) (fs.FileInfo, error) {
	dir := filepath.Dir(abs)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	tmp := filepath.Join(dir, ".lode-tmp-"+randHex(6))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, err
	}
	_, werr := f.Write(data)
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		os.Remove(tmp)
		return nil, werr
	}
	if err := renameRetry(tmp, abs); err != nil {
		os.Remove(tmp)
		return nil, err
	}
	return os.Stat(abs)
}

// Rename 在 vault 内移动文件或目录，目标已存在时返回 fs.ErrExist。
// 仅大小写不同的改名（例如 a.md → A.md）是允许的。
func (v *Vault) Rename(from, to string) error {
	src, err := v.Resolve(from)
	if err != nil {
		return err
	}
	dst, err := v.Resolve(to)
	if err != nil {
		return err
	}
	if !strings.EqualFold(from, to) {
		if _, err := os.Lstat(dst); err == nil {
			return fs.ErrExist
		}
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return renameRetry(src, dst)
}

// MoveOut 把 vault 内的文件移到 vault 外的绝对路径（用于回收站）。
func (v *Vault) MoveOut(rel, dstAbs string) error {
	if err := os.MkdirAll(filepath.Dir(dstAbs), 0o755); err != nil {
		return err
	}
	src, err := v.Resolve(rel)
	if err != nil {
		return err
	}
	return moveFile(src, dstAbs)
}

// MoveIn 把 vault 外的文件移到 vault 内（用于从回收站恢复）。目标已存在时返回 fs.ErrExist。
func (v *Vault) MoveIn(srcAbs, rel string) error {
	dst, err := v.Resolve(rel)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(dst); err == nil {
		return fs.ErrExist
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return moveFile(srcAbs, dst)
}

// Mkdir 创建目录（含父目录）。
func (v *Vault) Mkdir(rel string) error {
	abs, err := v.Resolve(rel)
	if err != nil {
		return err
	}
	return os.MkdirAll(abs, 0o755)
}

// Remove 删除文件或空目录。
func (v *Vault) Remove(rel string) error {
	abs, err := v.Resolve(rel)
	if err != nil {
		return err
	}
	return os.Remove(abs)
}

// IsIgnored 判断相对路径中是否有以 "." 开头的段（隐藏文件、.obsidian、临时文件等）。
func IsIgnored(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

// IsNote 判断相对路径是否是笔记文件。
func IsNote(rel string) bool {
	return strings.EqualFold(path.Ext(rel), ".md") && !IsIgnored(rel)
}

// Entry 是遍历结果中的一项。
type Entry struct {
	Path  string // 相对路径
	IsDir bool
	Size  int64
	Mtime int64 // unix 纳秒
}

// Walk 遍历 rel 下（含 rel 自身）所有非隐藏的目录和 .md 文件。
func (v *Vault) Walk(rel string, fn func(Entry) error) error {
	start := v.Abs(rel)
	return filepath.WalkDir(start, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == start {
				return err
			}
			return nil // 遍历中途消失的文件忽略
		}
		r, ok := v.Rel(p)
		if !ok {
			return nil
		}
		if r != "" && IsIgnored(r) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil // 不跟随符号链接，防止越出 vault
		}
		if d.IsDir() {
			return fn(Entry{Path: r, IsDir: true})
		}
		if !IsNote(r) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		return fn(Entry{Path: r, Size: info.Size(), Mtime: info.ModTime().UnixNano()})
	})
}

func moveFile(src, dst string) error {
	if err := renameRetry(src, dst); err == nil {
		return nil
	}
	// 跨设备时退回到复制 + 删除
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	in.Close()
	return os.Remove(src)
}

// renameRetry 在 Windows 上遇到文件被短暂占用（杀毒、索引服务）时重试几次。
func renameRetry(src, dst string) error {
	var err error
	for i := 0; i < 5; i++ {
		if err = os.Rename(src, dst); err == nil {
			return nil
		}
		if runtime.GOOS != "windows" {
			return err
		}
		time.Sleep(time.Duration(20*(i+1)) * time.Millisecond)
	}
	return err
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
