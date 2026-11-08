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
	got, err := l.List(ctx, 10, "")
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
	got, err := l.List(ctx, 100, "")
	if err != nil || len(got) != 5 || got[0].Target != "h" || got[4].Target != "d" {
		t.Fatalf("应只保留最近 5 条：%+v, %v", got, err)
	}
}

func TestListFiltersByWorkspace(t *testing.T) {
	ctx := context.Background()
	l := newLog(t)
	for _, e := range []Entry{
		{TokenID: "t1", TokenName: "A", Tool: "read_note", Target: "1.md", OK: true}, // 不写空间：归默认
		{TokenID: "t2", TokenName: "B", Workspace: "ab12cd", Tool: "read_note", Target: "2.md", OK: true},
		{TokenID: "t2", TokenName: "B", Workspace: "ab12cd", Tool: "create_note", Target: "3.md", OK: true},
	} {
		if err := l.Record(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	targets := func(ws string) string {
		got, err := l.List(ctx, 10, ws)
		if err != nil {
			t.Fatal(err)
		}
		var s string
		for _, e := range got {
			s += e.Target + "@" + e.Workspace + " "
		}
		return s
	}
	if got := targets(""); got != "3.md@ab12cd 2.md@ab12cd 1.md@default " {
		t.Fatalf("不筛选：%q", got)
	}
	if got := targets("ab12cd"); got != "3.md@ab12cd 2.md@ab12cd " {
		t.Fatalf("筛选 ab12cd：%q", got)
	}
	if got := targets("default"); got != "1.md@default " {
		t.Fatalf("筛选 default：%q", got)
	}
	if got := targets("nope"); got != "" {
		t.Fatalf("筛选不存在的空间：%q", got)
	}
}
