package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/vault"
)

// recorder 记录 testHook 事件。
type recorder struct {
	mu     sync.Mutex
	events []string
	ch     chan string
}

func record(t *testing.T) *recorder {
	rec := &recorder{ch: make(chan string, 64)}
	testHook = func(id, ev string) {
		rec.mu.Lock()
		rec.events = append(rec.events, id+":"+ev)
		rec.mu.Unlock()
		rec.ch <- id + ":" + ev
	}
	t.Cleanup(func() { testHook = nil })
	return rec
}

func (r *recorder) wait(t *testing.T, want string) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case ev := <-r.ch:
			if ev == want {
				return
			}
		case <-deadline:
			t.Fatalf("等待 %s 超时，已有事件 %v", want, r.snapshot())
		}
	}
}

func (r *recorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

func newDefault(t *testing.T) (*notes.Service, string, func() error) {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	vdir := filepath.Join(dir, "vault")
	if err := os.MkdirAll(vdir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 启动前就存在的笔记，要靠启动对账进入索引
	if err := os.WriteFile(filepath.Join(vdir, "before.md"), []byte("# 启动前\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	v, err := vault.New(vdir)
	if err != nil {
		t.Fatal(err)
	}
	return notes.New(notes.Options{DB: d, Vault: v, TrashDir: filepath.Join(dir, "trash")}), vdir, d.Close
}

func TestGetOnlyKnowsDefault(t *testing.T) {
	svc, _, closeDB := newDefault(t)
	defer closeDB()
	m := New(Options{Default: svc})
	defer m.Close()
	w, err := m.Get(context.Background(), DefaultID)
	if err != nil || w != m.Default() || w.Notes != svc || w.Tools == nil || w.ID != DefaultID {
		t.Fatalf("Get(default) = %+v, %v", w, err)
	}
	for _, id := range []string{"", "nope", "DEFAULT", "../default"} {
		if _, err := m.Get(context.Background(), id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Get(%q) 应返回 ErrNotFound，得到 %v", id, err)
		}
	}
	if got := m.Opened(); len(got) != 1 || got[0] != w {
		t.Fatalf("Opened = %v", got)
	}
	ctx := WithContext(context.Background(), w)
	if FromContext(ctx) != w || FromContext(context.Background()) != nil {
		t.Fatal("WithContext / FromContext 不一致")
	}
}

// 启动顺序：先建立监听，再全量对账；退出时 Close 等后台任务全部结束才返回，之后才能关闭数据库。
func TestStartWatchesBeforeReconcileAndCloseWaits(t *testing.T) {
	rec := record(t)
	svc, vdir, closeDB := newDefault(t)
	m := New(Options{Default: svc, Debounce: 20 * time.Millisecond})
	m.Start(context.Background())
	rec.wait(t, "default:ready")
	ev := rec.snapshot()
	iw, ir := index(ev, "default:watching"), index(ev, "default:reconcile")
	if iw < 0 || ir < 0 || iw > ir {
		t.Fatalf("应先 watching 再 reconcile，事件 %v", ev)
	}
	ctx := context.Background()
	if _, err := svc.ReadByPath(ctx, "before.md"); err != nil {
		t.Fatalf("启动对账后应能读到启动前的笔记: %v", err)
	}
	// 监听生效：启动后外部新建的文件也进入索引
	if err := os.WriteFile(filepath.Join(vdir, "after.md"), []byte("# 之后\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := svc.ReadByPath(ctx, "after.md"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("监听没有把外部新建的笔记加入索引")
		}
		time.Sleep(20 * time.Millisecond)
	}

	m.Close()
	// 三个后台任务（监听、对账、历史清理）都已退出：Close 返回前已记录 3 次 stopped
	if n := count(rec.snapshot(), "default:stopped"); n != 3 {
		t.Fatalf("Close 返回时应有 3 个后台任务退出，得到 %d：%v", n, rec.snapshot())
	}
	if err := closeDB(); err != nil {
		t.Fatal(err)
	}
	m.Close() // 可以重复调用
}

func TestCloseBeforeStartAndCancelledContext(t *testing.T) {
	rec := record(t)
	svc, _, closeDB := newDefault(t)
	defer closeDB()
	m := New(Options{Default: svc})
	m.Close()
	m.Start(context.Background()) // Close 之后不再启动
	if ev := rec.snapshot(); len(ev) != 0 {
		t.Fatalf("Close 之后 Start 不应启动后台任务：%v", ev)
	}

	m2 := New(Options{Default: svc})
	ctx, cancel := context.WithCancel(context.Background())
	m2.Start(ctx)
	cancel()
	m2.Close()
	if n := count(rec.snapshot(), "default:stopped"); n != 3 {
		t.Fatalf("ctx 取消后后台任务应全部退出，stopped = %d", n)
	}
}

func index(ev []string, want string) int {
	for i, e := range ev {
		if e == want {
			return i
		}
	}
	return -1
}

func count(ev []string, want string) int {
	n := 0
	for _, e := range ev {
		if e == want {
			n++
		}
	}
	return n
}
