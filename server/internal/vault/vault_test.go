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

// 回收站在数据目录，外部 vault 可能在另一块磁盘上：重命名失败（跨设备）时退回到复制 + 删除。
func TestMoveFallsBackToCopyAcrossDevices(t *testing.T) {
	root, trash := t.TempDir(), t.TempDir()
	v, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	for p, c := range map[string]string{"a/b.md": "正文", "d/sub/c.md": "c", "d/e.md": "e"} {
		if _, err := v.CreateFile(p, []byte(c)); err != nil {
			t.Fatal(err)
		}
	}
	old := rename
	rename = func(string, string) error { return errors.New("invalid cross-device link") }
	defer func() { rename = old }()

	dst := filepath.Join(trash, "x", "b.md")
	if err := v.MoveOut("a/b.md", dst); err != nil {
		t.Fatalf("MoveOut: %v", err)
	}
	if b, err := os.ReadFile(dst); err != nil || string(b) != "正文" {
		t.Fatalf("回收站里的文件 = %q %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(root, "a", "b.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("原文件应已删除：%v", err)
	}
	// 恢复
	if err := v.MoveIn(dst, "a/b.md"); err != nil {
		t.Fatalf("MoveIn: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(root, "a", "b.md")); err != nil || string(b) != "正文" {
		t.Fatalf("恢复后的文件 = %q %v", b, err)
	}

	// 整个目录
	dir := filepath.Join(trash, "folders", "1-d")
	if err := MoveDirOut(filepath.Join(root, "d"), dir); err != nil {
		t.Fatalf("MoveDirOut: %v", err)
	}
	for _, f := range []string{"sub/c.md", "e.md"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(f))); err != nil {
			t.Errorf("目录副本缺 %s：%v", f, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "d")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("原目录应已删除：%v", err)
	}
}
