package secret

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSealOpen(t *testing.T) {
	b := New("master-key-1")
	if !b.Enabled() {
		t.Fatal("设置了主密钥应可用")
	}
	c1, err := b.Seal("sk-plain-123", "prov-1")
	if err != nil {
		t.Fatal(err)
	}
	c2, _ := b.Seal("sk-plain-123", "prov-1")
	if c1 == c2 {
		t.Error("每次加密的随机数应不同")
	}
	if strings.Contains(c1, "sk-plain") {
		t.Error("密文里不应有明文")
	}
	if p, err := b.Open(c1, "prov-1"); err != nil || p != "sk-plain-123" {
		t.Fatalf("解密：%q %v", p, err)
	}
	if _, err := b.Open(c1, "prov-2"); err == nil {
		t.Error("换了关联数据（别的供应商）不应能解密")
	}
	if _, err := New("other").Open(c1, "prov-1"); err == nil {
		t.Error("换了主密钥不应能解密")
	}
	if _, err := b.Open(c1[:len(c1)-2]+"AA", "prov-1"); err == nil {
		t.Error("篡改过的密文不应能解密")
	}
}

func TestNoKey(t *testing.T) {
	b := New("  ")
	if b.Enabled() {
		t.Fatal("空主密钥应不可用")
	}
	if _, err := b.Seal("x", ""); !errors.Is(err, ErrNoKey) {
		t.Errorf("Seal：%v", err)
	}
	if _, err := b.Open("v1:xx", ""); !errors.Is(err, ErrNoKey) {
		t.Errorf("Open：%v", err)
	}
}

func TestLast4(t *testing.T) {
	for in, want := range map[string]string{
		"sk-abcdef1234": "1234",
		"密钥一二三四五六七八九十":  "七八九十",
		// 太短的 key 末 4 位就是大半个 key，不显示
		"abc": "", "": "", "sk-short1": "", "密钥一二三四五": "",
	} {
		if got := Last4(in); got != want {
			t.Errorf("Last4(%q) = %q，期望 %q", in, got, want)
		}
	}
}

func TestLoadGeneratesAndReusesFile(t *testing.T) {
	dir := t.TempDir()
	b1, src, err := Load("", dir)
	if err != nil || src != SourceNew || !b1.Enabled() {
		t.Fatalf("首次应自动生成：%v %v", src, err)
	}
	if _, err := os.Stat(filepath.Join(dir, FileName)); err != nil {
		t.Fatal(err)
	}
	sealed, err := b1.Seal("sk-test-1234567890", "p1")
	if err != nil {
		t.Fatal(err)
	}
	b2, src, err := Load("  ", dir) // 只含空白视为未设置
	if err != nil || src != SourceFile {
		t.Fatalf("再次加载应复用文件：%v %v", src, err)
	}
	if got, err := b2.Open(sealed, "p1"); err != nil || got != "sk-test-1234567890" {
		t.Fatalf("重启后应能解密：%q %v", got, err)
	}
}

func TestLoadEnvTakesPrecedence(t *testing.T) {
	dir := t.TempDir()
	b, src, err := Load("my-env-key", dir)
	if err != nil || src != SourceEnv {
		t.Fatal(src, err)
	}
	if _, err := os.Stat(filepath.Join(dir, FileName)); !errors.Is(err, os.ErrNotExist) {
		t.Error("设置了环境变量时不应生成文件")
	}
	sealed, _ := b.Seal("x", "a")
	// 文件已存在时仍以环境变量为准
	if _, _, err := Load("", dir); err != nil {
		t.Fatal(err)
	}
	b3, src, _ := Load("my-env-key", dir)
	if src != SourceEnv {
		t.Error(src)
	}
	if got, err := b3.Open(sealed, "a"); err != nil || got != "x" {
		t.Errorf("环境变量优先：%v", err)
	}
}

func TestLoadRejectsEmptyFile(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, FileName), []byte("\n"), 0o600)
	if _, _, err := Load("", dir); err == nil {
		t.Error("空的 secret.key 应报错而不是静默生成新密钥")
	}
}
