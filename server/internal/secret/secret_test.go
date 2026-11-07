package secret

import (
	"errors"
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
	for in, want := range map[string]string{"sk-abcdef1234": "1234", "abc": "abc", "": "", "密钥一二三四五": "二三四五"} {
		if got := Last4(in); got != want {
			t.Errorf("Last4(%q) = %q，期望 %q", in, got, want)
		}
	}
}
