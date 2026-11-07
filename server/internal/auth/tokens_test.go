package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestAPITokenLifecycle(t *testing.T) {
	ctx := context.Background()
	a := newAuth(t)
	now := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return now }

	tok, secret, err := a.CreateToken(ctx, " Claude Code ", ScopeRead)
	if err != nil {
		t.Fatal(err)
	}
	if tok.Name != "Claude Code" || tok.Scope != ScopeRead || tok.CreatedAt != now.UnixMilli() || tok.LastUsedAt != 0 {
		t.Fatalf("token = %+v", tok)
	}
	if !strings.HasPrefix(secret, TokenPrefix) || len(secret) < len(TokenPrefix)+43 {
		t.Fatalf("明文 token 应以 %s 开头且含 32 字节随机数，得到长度 %d", TokenPrefix, len(secret))
	}

	// 库里只有哈希
	var stored string
	if err := a.db.QueryRowContext(ctx, `SELECT token_hash FROM api_tokens WHERE id = ?`, tok.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == secret || strings.Contains(stored, secret) || len(stored) != 64 {
		t.Fatalf("应只存 SHA-256 哈希")
	}

	now = now.Add(time.Minute)
	got, err := a.VerifyToken(ctx, secret)
	if err != nil || got.ID != tok.ID || got.Scope != ScopeRead || got.Name != "Claude Code" {
		t.Fatalf("VerifyToken = %+v, %v", got, err)
	}
	list, err := a.ListTokens(ctx)
	if err != nil || len(list) != 1 || list[0].LastUsedAt != now.UnixMilli() {
		t.Fatalf("使用后应记录最后使用时间：%+v %v", list, err)
	}

	for _, bad := range []string{"", "lode_xxx", secret + "x", strings.TrimPrefix(secret, TokenPrefix)} {
		if _, err := a.VerifyToken(ctx, bad); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("错误的 token %q 应返回 ErrInvalidToken，得到 %v", bad, err)
		}
	}

	if err := a.RevokeToken(ctx, tok.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := a.VerifyToken(ctx, secret); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("吊销后应失效：%v", err)
	}
	if err := a.RevokeToken(ctx, tok.ID); !errors.Is(err, ErrTokenNotFound) {
		t.Fatalf("重复吊销应返回 ErrTokenNotFound：%v", err)
	}
}

func TestCreateTokenValidatesInput(t *testing.T) {
	ctx := context.Background()
	a := newAuth(t)
	if _, _, err := a.CreateToken(ctx, "  ", ScopeWrite); !errors.Is(err, ErrInvalidTokenInput) {
		t.Fatalf("空名称应拒绝：%v", err)
	}
	if _, _, err := a.CreateToken(ctx, "x", "admin"); !errors.Is(err, ErrInvalidTokenInput) {
		t.Fatalf("未知权限应拒绝：%v", err)
	}
	if _, _, err := a.CreateToken(ctx, strings.Repeat("长", 100), ScopeWrite); !errors.Is(err, ErrInvalidTokenInput) {
		t.Fatalf("过长名称应拒绝：%v", err)
	}
}
