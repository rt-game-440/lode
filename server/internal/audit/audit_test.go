package audit

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/rt-game-440/lode/server/internal/db"
)

func newLog(t *testing.T) *Log {
	t.Helper()
	d, err := db.Open(context.Background(), filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return New(d)
}

func TestRecordAndListNewestFirst(t *testing.T) {
	ctx := context.Background()
	l := newLog(t)
	at := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return at }
	if err := l.Record(ctx, Entry{TokenID: "t1", TokenName: "Claude", Tool: "read_note", Target: "a.md", OK: true, DurationMs: 3}); err != nil {
		t.Fatal(err)
	}
	if err := l.Record(ctx, Entry{TokenID: "t1", TokenName: "Claude", Tool: "delete_note", Target: "b.md", Error: "笔记不存在"}); err != nil {
		t.Fatal(err)
	}
	got, err := l.List(ctx, 10)
	if err != nil || len(got) != 2 {
		t.Fatalf("List = %+v, %v", got, err)
	}
	if got[0].Tool != "delete_note" || got[0].OK || got[0].Error != "笔记不存在" || got[0].At != at.UnixMilli() {
		t.Fatalf("最新一条应排在最前：%+v", got[0])
	}
	if got[1].Tool != "read_note" || !got[1].OK || got[1].Target != "a.md" || got[1].DurationMs != 3 {
		t.Fatalf("第二条：%+v", got[1])
	}
}

func TestRecordKeepsOnlyLatestEntries(t *testing.T) {
	ctx := context.Background()
	l := newLog(t)
	l.keep = 5
	for i := range 8 {
		if err := l.Record(ctx, Entry{TokenID: "t", TokenName: "n", Tool: "search_notes", Target: string(rune('a' + i)), OK: true}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := l.List(ctx, 100)
	if err != nil || len(got) != 5 || got[0].Target != "h" || got[4].Target != "d" {
		t.Fatalf("应只保留最近 5 条：%+v, %v", got, err)
	}
}
