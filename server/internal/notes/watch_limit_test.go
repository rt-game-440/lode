package notes

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// 监听句柄耗尽（Linux inotify ENOSPC / EMFILE）时：打一条警告并提示调整方法，Watch 不退出，对账结果仍正确。
func TestWatchLimitLogsWarningAndReconcileStillWorks(t *testing.T) {
	f := newFixture(t)
	var buf syncBuffer
	f.svc.log = slog.New(slog.NewTextHandler(&buf, nil))
	f.svc.addWatch = func(*fsnotify.Watcher, string) error {
		return fmt.Errorf("add: %w", syscall.ENOSPC)
	}
	f.writeDisk(t, "子目录/一.md", "句柄耗尽独特词")
	f.writeDisk(t, "二.md", "另一篇")

	ctx, cancel := context.WithCancel(f.ctx)
	done := make(chan error, 1)
	ready := make(chan struct{})
	go func() { done <- f.svc.Watch(ctx, 50*time.Millisecond, func() { close(ready) }) }()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("Watch 不应因句柄耗尽退出：%v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("Watch 没有就绪")
	}

	out := buf.String()
	if !strings.Contains(out, "max_user_watches") || strings.Count(out, "level=WARN") != 1 {
		t.Fatalf("应恰好打一条含 max_user_watches 提示的警告：\n%s", out)
	}
	select {
	case err := <-done:
		t.Fatalf("Watch 提前退出：%v", err)
	default:
	}
	if _, err := f.svc.Reconcile(f.ctx); err != nil {
		t.Fatal(err)
	}
	if got := searchPaths(t, f, "句柄耗尽独特词"); len(got) != 1 || got[0] != "子目录/一.md" {
		t.Fatalf("对账结果不正确：%v", got)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}
