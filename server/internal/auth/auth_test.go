package auth

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/rt-game-440/lode/server/internal/db"
)

func newAuth(t *testing.T) *Auth {
	t.Helper()
	d, err := db.Open(context.Background(), filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return New(d)
}

func TestSetupLoginAndSessions(t *testing.T) {
	ctx := context.Background()
	a := newAuth(t)
	if ok, _ := a.Initialized(ctx); ok {
		t.Fatal("新库不应已初始化")
	}
	if err := a.Setup(ctx, "short"); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("短密码应拒绝: %v", err)
	}
	if err := a.Setup(ctx, "正确的密码123"); err != nil {
		t.Fatal(err)
	}
	if err := a.Setup(ctx, "另一个密码12345"); !errors.Is(err, ErrAlreadyInitialized) {
		t.Fatalf("重复设置应拒绝: %v", err)
	}
	if err := a.CheckPassword(ctx, "错误的密码"); !errors.Is(err, ErrBadPassword) {
		t.Fatalf("错误密码: %v", err)
	}
	if err := a.CheckPassword(ctx, "正确的密码123"); err != nil {
		t.Fatalf("正确密码: %v", err)
	}
	tok, _, err := a.CreateSession(ctx, "test")
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := a.ValidateSession(ctx, tok); !ok {
		t.Fatal("会话应有效")
	}
	if ok, _ := a.ValidateSession(ctx, tok+"x"); ok {
		t.Fatal("篡改的会话应无效")
	}
	_ = a.DeleteSession(ctx, tok)
	if ok, _ := a.ValidateSession(ctx, tok); ok {
		t.Fatal("注销后会话应无效")
	}
}

func TestLimiterLocksAfterFiveFailuresForOneMinute(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewLimiter(5, time.Minute, time.Minute)
	l.now = func() time.Time { return now }
	for i := 0; i < 4; i++ {
		if locked := l.Fail("ip"); locked {
			t.Fatalf("第 %d 次失败不应锁定", i+1)
		}
	}
	if ok, _ := l.Allow("ip"); !ok {
		t.Fatal("4 次失败后仍可尝试")
	}
	if !l.Fail("ip") {
		t.Fatal("第 5 次失败应锁定")
	}
	if ok, wait := l.Allow("ip"); ok || wait != time.Minute {
		t.Fatalf("应锁定 1 分钟: ok=%v wait=%v", ok, wait)
	}
	if ok, _ := l.Allow("other"); !ok {
		t.Fatal("其他客户端不受影响")
	}
	now = now.Add(61 * time.Second)
	if ok, _ := l.Allow("ip"); !ok {
		t.Fatal("1 分钟后应解锁")
	}
}
