package workspace

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
	"unicode/utf8"
)

// 外部目录工作空间：把一个已有的文件夹（例如 Obsidian 库）作为 vault，见 docs/workspaces.md 第 3、5、9 节。
// 外部目录里只放笔记文件；索引、回收站、锁都在 data/workspaces/<id>/，不往用户目录里写任何东西。

// ErrVaultUnavailable 表示外部目录的工作空间打开时发现笔记目录不存在（被删除、卷未挂载等）。
// 不会重新创建它：在一个没挂载的路径上建空目录再对账，会把索引里的笔记全部当作被删除。
var ErrVaultUnavailable = errors.New("workspace vault unavailable")

// 外部目录校验失败的原因，API 的错误码是 "vault_dir_" + 原因。
const (
	ReasonInvalid       = "invalid"           // 路径含控制字符或不是合法的 UTF-8
	ReasonNotAbsolute   = "not_absolute"      // 不是绝对路径
	ReasonNotFound      = "not_found"         // 路径不存在
	ReasonNotDirectory  = "not_directory"     // 路径是文件而不是目录
	ReasonUnreadable    = "unreadable"        // 目录读不了（没有权限等）
	ReasonRoot          = "root"              // 盘符根目录或文件系统根目录
	ReasonHome          = "home"              // 用户主目录本身
	ReasonDataDir       = "data_dir"          // 就是 Lode 的数据目录
	ReasonInsideDataDir = "inside_data_dir"   // 在 Lode 的数据目录里面
	ReasonContainsData  = "contains_data_dir" // 数据目录在它里面
	ReasonSameVault     = "same_vault"        // 已经是另一个工作空间的笔记目录
	ReasonNestedVault   = "nested_vault"      // 与另一个工作空间的笔记目录互相嵌套
)

// VaultDirError 是外部目录校验失败。它也满足 errors.Is(err, ErrInvalid)，Reason 是上面的常量之一，
// 错误信息可以直接给用户看。
type VaultDirError struct {
	Reason string
	Msg    string
}

func (e *VaultDirError) Error() string { return ErrInvalid.Error() + ": " + e.Msg }

// Is 让 errors.Is(err, ErrInvalid) 成立。
func (e *VaultDirError) Is(target error) bool { return target == ErrInvalid }

func vaultDirErr(reason, format string, a ...any) error {
	return &VaultDirError{Reason: reason, Msg: fmt.Sprintf(format, a...)}
}

// CheckVaultDir 校验并规范化要接入的外部目录，返回写进登记表的路径（已解析符号链接的绝对路径）。
// 规则：必须是已存在、可读的绝对路径目录；不能是盘符根目录或用户主目录本身；不能与数据目录或任何已有的
// 工作空间笔记目录相同，也不能互相嵌套。不会创建或写入任何东西。
func (m *Manager) CheckVaultDir(ctx context.Context, dir string) (string, error) {
	if m.global == nil {
		return "", ErrNoRegistry
	}
	m.adminMu.Lock()
	defer m.adminMu.Unlock()
	return m.checkVaultDirLocked(ctx, dir)
}

// checkVaultDirLocked 是 CheckVaultDir，调用方持有 adminMu。
func (m *Manager) checkVaultDirLocked(ctx context.Context, dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	if !utf8.ValidString(dir) || strings.IndexFunc(dir, unicode.IsControl) >= 0 {
		return "", vaultDirErr(ReasonInvalid, "路径含有非法字符")
	}
	if !filepath.IsAbs(dir) {
		return "", vaultDirErr(ReasonNotAbsolute, "必须填写绝对路径：%s", dir)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(dir))
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "", vaultDirErr(ReasonNotFound, "文件夹不存在：%s", dir)
	case err != nil:
		return "", vaultDirErr(ReasonUnreadable, "无法读取文件夹 %s：%v", dir, err)
	}
	info, err := os.Stat(resolved)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "", vaultDirErr(ReasonNotFound, "文件夹不存在：%s", dir)
	case err != nil:
		return "", vaultDirErr(ReasonUnreadable, "无法读取文件夹 %s：%v", dir, err)
	case !info.IsDir():
		return "", vaultDirErr(ReasonNotDirectory, "%s 不是文件夹", dir)
	}
	if f, err := os.Open(resolved); err != nil {
		return "", vaultDirErr(ReasonUnreadable, "无法读取文件夹 %s：%v", dir, err)
	} else {
		_, rerr := f.Readdirnames(1)
		f.Close()
		if rerr != nil && !errors.Is(rerr, io.EOF) {
			return "", vaultDirErr(ReasonUnreadable, "无法读取文件夹 %s：%v", dir, rerr)
		}
	}

	if filepath.Dir(resolved) == resolved {
		return "", vaultDirErr(ReasonRoot, "不能使用磁盘根目录 %s，请选择里面的某个文件夹", dir)
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if h, err := filepath.EvalSymlinks(home); err == nil && samePath(resolved, h) {
			return "", vaultDirErr(ReasonHome, "不能直接使用用户主目录，请选择里面的某个文件夹")
		}
	}

	data, err := filepath.Abs(m.dataDir)
	if err != nil {
		return "", err
	}
	if d, err := filepath.EvalSymlinks(data); err == nil {
		data = d
	}
	switch {
	case samePath(resolved, data):
		return "", vaultDirErr(ReasonDataDir, "不能使用 Lode 的数据目录")
	case within(data, resolved):
		return "", vaultDirErr(ReasonInsideDataDir, "不能使用 Lode 数据目录里面的文件夹")
	case within(resolved, data):
		return "", vaultDirErr(ReasonContainsData, "Lode 的数据目录在这个文件夹里面，请选择不包含数据目录的文件夹")
	}

	// 内置工作空间和默认工作空间的 vault 都在数据目录里，上面已经排除；这里只比外部目录
	rows, err := m.global.QueryContext(ctx, `SELECT name, vault_dir FROM workspaces WHERE vault_dir <> ''`)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var name, other string
		if err := rows.Scan(&name, &other); err != nil {
			return "", err
		}
		if o, err := filepath.EvalSymlinks(other); err == nil {
			other = o
		}
		switch {
		case samePath(resolved, other):
			return "", vaultDirErr(ReasonSameVault, "这个文件夹已经是工作空间「%s」的笔记目录", name)
		case within(other, resolved):
			return "", vaultDirErr(ReasonNestedVault, "这个文件夹在工作空间「%s」的笔记目录里面", name)
		case within(resolved, other):
			return "", vaultDirErr(ReasonNestedVault, "工作空间「%s」的笔记目录在这个文件夹里面", name)
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return resolved, nil
}

// foldCase 在文件系统通常不区分大小写的系统上比较路径时统一大小写。
func foldCase(p string) string {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.ToLower(p)
	}
	return p
}

// samePath 判断两个（已解析的绝对）路径是不是同一个目录。
func samePath(a, b string) bool {
	if foldCase(filepath.Clean(a)) == foldCase(filepath.Clean(b)) {
		return true
	}
	ia, err1 := os.Stat(a)
	ib, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(ia, ib)
}

// within 判断 child 是否严格位于 parent 里面（两者相同不算）。
func within(parent, child string) bool {
	rel, err := filepath.Rel(foldCase(filepath.Clean(parent)), foldCase(filepath.Clean(child)))
	if err != nil || rel == "." {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// checkVaultPresent 打开外部目录工作空间前确认笔记目录还在，不存在时返回 ErrVaultUnavailable（不创建）。
func checkVaultPresent(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("%w: 笔记目录 %s 不可用：%v", ErrVaultUnavailable, dir, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%w: %s 不是文件夹", ErrVaultUnavailable, dir)
	}
	return nil
}

// SamePath 判断两个（已解析的绝对）路径是不是同一个目录，供备份恢复等包校验外部目录的位置。
func SamePath(a, b string) bool { return samePath(a, b) }

// Within 判断 child 是否严格位于 parent 里面（两者相同不算）。
func Within(parent, child string) bool { return within(parent, child) }
