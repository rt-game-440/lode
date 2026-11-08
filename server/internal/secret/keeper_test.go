package secret

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func prf(b byte) []byte { return bytes.Repeat([]byte{b}, PRFLen) }

func TestWrapUnwrap(t *testing.T) {
	master := NewMaster()
	w, err := Wrap(prf(1), "cred-a", master)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(w, master) {
		t.Fatal("包裹结果里不应有主密钥原文")
	}
	if got, err := Unwrap(prf(1), "cred-a", w); err != nil || got != master {
		t.Fatalf("Unwrap = %q %v", got, err)
	}
	for name, c := range map[string]struct {
		prf  []byte
		cred string
		w    string
	}{
		"别的 PRF 输出": {prf(2), "cred-a", w},
		"挪到别的凭据":    {prf(1), "cred-b", w},
		"篡改过":       {prf(1), "cred-a", w[:len(w)-2] + "AA"},
		"PRF 输出太短":  {prf(1)[:16], "cred-a", w},
		"不是包裹格式":    {prf(1), "cred-a", "v1:abc"},
	} {
		if _, err := Unwrap(c.prf, c.cred, c.w); !errors.Is(err, ErrUnwrap) {
			t.Errorf("%s：应返回 ErrUnwrap，得到 %v", name, err)
		}
	}
	if _, err := Wrap(prf(1)[:31], "cred-a", master); err == nil {
		t.Error("PRF 输出不足 32 字节应拒绝")
	}
}

func TestKeeperModes(t *testing.T) {
	// 环境变量优先，即使数据库里标记了保护
	dir := t.TempDir()
	k, src, err := OpenKeeper("env-master", dir, true)
	if err != nil || src != SourceEnv || k.Mode() != ModeEnv || k.Locked() {
		t.Fatalf("env：%v %v %v", src, k.Mode(), err)
	}
	if _, err := os.Stat(filepath.Join(dir, FileName)); !errors.Is(err, os.ErrNotExist) {
		t.Error("使用环境变量时不应生成 secret.key")
	}

	// 未保护：生成 secret.key，与 Load 读到的是同一个主密钥
	k, src, err = OpenKeeper("", dir, false)
	if err != nil || src != SourceNew || k.Mode() != ModeFile {
		t.Fatalf("file：%v %v", src, err)
	}
	c, err := k.Seal("sk-1", "p")
	if err != nil {
		t.Fatal(err)
	}
	box, _, _ := Load("", dir)
	if p, err := box.Open(c, "p"); err != nil || p != "sk-1" {
		t.Fatalf("Keeper 与 secret.key 不一致：%q %v", p, err)
	}

	// 已保护：锁定，删除残留的 secret.key
	k, src, err = OpenKeeper("", dir, true)
	if err != nil || src != SourcePasskeyStale || k.Mode() != ModePasskey || !k.Locked() {
		t.Fatalf("passkey：%v %v %v", src, k.Locked(), err)
	}
	if _, err := os.Stat(filepath.Join(dir, FileName)); !errors.Is(err, os.ErrNotExist) {
		t.Error("保护模式下应删除残留的 secret.key")
	}
	if !k.Enabled() {
		t.Error("锁定时仍算可以保存 key（解锁后可用）")
	}
	if _, err := k.Seal("x", "p"); !errors.Is(err, ErrLocked) {
		t.Errorf("锁定时 Seal 应返回 ErrLocked，得到 %v", err)
	}
	if _, err := k.Open(c, "p"); !errors.Is(err, ErrLocked) {
		t.Errorf("锁定时 Open 应返回 ErrLocked，得到 %v", err)
	}
	if _, src, _ := OpenKeeper("", dir, true); src != SourcePasskey {
		t.Errorf("没有残留文件时来源应为 passkey，得到 %v", src)
	}

	// 解锁后可用；fn 出错时状态不变
	master := NewMaster()
	if err := k.Update(func(Mode, string) (Mode, string, error) { return ModePasskey, master, nil }); err != nil {
		t.Fatal(err)
	}
	if k.Locked() {
		t.Fatal("解锁后不应锁定")
	}
	c2, err := k.Seal("sk-2", "p")
	if err != nil {
		t.Fatal(err)
	}
	if p, err := New(master).Open(c2, "p"); err != nil || p != "sk-2" {
		t.Fatalf("应使用解开的主密钥：%q %v", p, err)
	}
	boom := errors.New("boom")
	if err := k.Update(func(Mode, string) (Mode, string, error) { return ModeFile, "", boom }); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if k.Mode() != ModePasskey || k.Locked() {
		t.Error("fn 出错时状态应保持不变")
	}
}

func TestKeeperFile(t *testing.T) {
	dir := t.TempDir()
	k, _, err := OpenKeeper("", dir, true)
	if err != nil {
		t.Fatal(err)
	}
	master := NewMaster()
	if err := k.WriteFile(master); err != nil {
		t.Fatal(err)
	}
	if err := k.WriteFile(master); err != nil { // 覆盖已有文件
		t.Fatal(err)
	}
	box, src, err := Load("", dir)
	if err != nil || src != SourceFile {
		t.Fatalf("写入的 secret.key 应能被 Load 读到：%v %v", src, err)
	}
	c, _ := New(master).Seal("sk", "p")
	if p, err := box.Open(c, "p"); err != nil || p != "sk" {
		t.Fatalf("内容不一致：%v", err)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".secret-*")); len(left) != 0 {
		t.Errorf("不应留下临时文件：%v", left)
	}
	if err := k.RemoveFile(); err != nil {
		t.Fatal(err)
	}
	if err := k.RemoveFile(); err != nil {
		t.Errorf("文件不存在时删除不算错误：%v", err)
	}
}
