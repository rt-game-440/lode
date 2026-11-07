package vault

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// vault 内指向 vault 外的符号链接目录不能被用来写到 vault 之外。
func TestSymlinkedDirOutsideVaultIsRejected(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	v, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		// Windows 没有开发者模式时不能建符号链接，改用目录联接（效果相同，无需管理员权限）
		if runtime.GOOS != "windows" || exec.Command("cmd", "/c", "mklink", "/J", link, outside).Run() != nil {
			t.Skipf("当前系统无法创建符号链接：%v", err)
		}
	}
	if _, err := v.CreateFile("link/x.md", []byte("x")); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("CreateFile 应返回 ErrInvalidPath，得到 %v", err)
	}
	if _, err := v.WriteFile("link/y.md", []byte("y")); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("WriteFile 应返回 ErrInvalidPath，得到 %v", err)
	}
	if err := v.Mkdir("link/sub"); !errors.Is(err, ErrInvalidPath) {
		t.Errorf("Mkdir 应返回 ErrInvalidPath，得到 %v", err)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Errorf("vault 外不应出现文件：%v", entries)
	}
	// 普通子目录不受影响
	if _, err := v.CreateFile("a/b.md", []byte("ok")); err != nil {
		t.Errorf("普通路径写入失败：%v", err)
	}
}
