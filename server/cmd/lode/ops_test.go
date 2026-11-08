package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/config"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/passkey"
	"github.com/rt-game-440/lode/server/internal/passkey/passkeytest"
)

// reset-password 默认保留已登记的通行密钥，加 --clear-passkeys 才一并删除。
func TestResetPasswordPasskeys(t *testing.T) {
	ctx := context.Background()
	cfg := config.Config{DataDir: t.TempDir()}
	d, err := db.Open(ctx, cfg.DBPath())
	if err != nil {
		t.Fatal(err)
	}
	if err := auth.New(d).Setup(ctx, "old-password-1"); err != nil {
		t.Fatal(err)
	}
	svc := passkey.New(d, nil)
	rp, _ := passkey.RPFromHost("localhost:8787", false)
	register := func() {
		a := passkeytest.New()
		cer, creation, err := svc.BeginRegistration(ctx, rp, "电脑")
		if err != nil {
			t.Fatal(err)
		}
		opts, _ := json.Marshal(creation)
		cred, err := a.Create(opts, rp.Origin)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := svc.FinishRegistration(ctx, cer, httptest.NewRequest("POST", "/", bytes.NewReader(cred))); err != nil {
			t.Fatal(err)
		}
	}
	register()
	register()
	d.Close()

	reset := func(args ...string) {
		t.Helper()
		r, w, _ := os.Pipe()
		_, _ = w.WriteString("new-password-2\n")
		w.Close()
		old := os.Stdin
		os.Stdin = r
		defer func() { os.Stdin = old; r.Close() }()
		if err := runResetPassword(cfg, args); err != nil {
			t.Fatal(err)
		}
	}
	count := func() int {
		d, err := db.Open(ctx, cfg.DBPath())
		if err != nil {
			t.Fatal(err)
		}
		defer d.Close()
		list, err := passkey.New(d, nil).List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return len(list)
	}

	reset()
	if n := count(); n != 2 {
		t.Fatalf("默认应保留通行密钥，剩 %d 个", n)
	}
	reset("--clear-passkeys")
	if n := count(); n != 0 {
		t.Fatalf("--clear-passkeys 应删除全部，剩 %d 个", n)
	}
	// 密码确实被重置
	d, _ = db.Open(ctx, cfg.DBPath())
	defer d.Close()
	if err := auth.New(d).CheckPassword(ctx, "new-password-2"); err != nil {
		t.Fatalf("新密码应可用: %v", err)
	}
}
