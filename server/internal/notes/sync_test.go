package notes

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

const threeParas = "第一段\n\n第二段\n\n第三段\n"

func TestStaleUpdateWithNonOverlappingChangesIsMerged(t *testing.T) {
	f := newFixture(t)
	n := f.create(t, "a.md", threeParas)
	if _, err := f.svc.Update(f.ctx, n.ID, 1, "第一段 A\n\n第二段\n\n第三段\n"); err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.Update(f.ctx, n.ID, 1, "第一段\n\n第二段\n\n第三段 B\n")
	if err != nil {
		t.Fatalf("不重叠的修改应自动合并，得到 %v", err)
	}
	want := "第一段 A\n\n第二段\n\n第三段 B\n"
	if !res.Merged || res.Rev != 3 || res.Content != want || f.disk(t, "a.md") != want {
		t.Fatalf("merged=%v rev=%d content=%q disk=%q", res.Merged, res.Rev, res.Content, f.disk(t, "a.md"))
	}
}

func TestStaleUpdateWithOverlappingChangesCreatesConflictCopy(t *testing.T) {
	f := newFixture(t)
	f.now = time.Date(2026, 11, 7, 16, 30, 5, 0, time.Local)
	n := f.create(t, "日记/a.md", "v1")
	if _, err := f.svc.Update(f.ctx, n.ID, 1, "v2"); err != nil {
		t.Fatal(err)
	}
	ctx := WithActor(f.ctx, Actor{DeviceID: "d2", DeviceName: "Pixel: 手机"})
	_, err := f.svc.Update(ctx, n.ID, 1, "来自旧版本的修改")
	var ce *ConflictError
	if !errors.As(err, &ce) || ce.CurrentRev != 2 {
		t.Fatalf("want ConflictError{2}, got %v", err)
	}
	if got := f.disk(t, "日记/a.md"); got != "v2" {
		t.Fatalf("冲突时服务器版本应保持不变，得到 %q", got)
	}
	wantPath := "日记/a.conflict-Pixel- 手机-20261107-163005.md"
	if ce.CopyPath != wantPath || ce.CopyID == "" {
		t.Fatalf("冲突副本 = %q (%q)，期望 %q", ce.CopyPath, ce.CopyID, wantPath)
	}
	if got := f.disk(t, wantPath); got != "来自旧版本的修改" {
		t.Fatalf("冲突副本内容 = %q", got)
	}
	if c, err := f.svc.Read(f.ctx, ce.CopyID); err != nil || c.Path != wantPath {
		t.Fatalf("冲突副本应进入索引：%+v %v", c, err)
	}
}

func TestStaleUpdateWithMissingBaseVersionCreatesConflictCopy(t *testing.T) {
	f := newFixture(t)
	n := f.create(t, "a.md", threeParas)
	if _, err := f.svc.Update(f.ctx, n.ID, 1, "第一段 A\n\n第二段\n\n第三段\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.db.Exec(`DELETE FROM versions WHERE note_id = ? AND rev = 1`, n.ID); err != nil {
		t.Fatal(err)
	}
	_, err := f.svc.Update(f.ctx, n.ID, 1, "第一段\n\n第二段\n\n第三段 B\n")
	var ce *ConflictError
	if !errors.As(err, &ce) || ce.CopyPath == "" {
		t.Fatalf("base 版本缺失时应按冲突处理，得到 %v", err)
	}
}

func TestStalePatchIsMergedAgainstBaseVersion(t *testing.T) {
	f := newFixture(t)
	n := f.create(t, "a.md", threeParas)
	if _, err := f.svc.Update(f.ctx, n.ID, 1, "第一段 A\n\n第二段\n\n第三段\n"); err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.Patch(f.ctx, n.ID, 1, []Edit{{Old: "第三段", New: "第三段 B"}})
	if err != nil {
		t.Fatal(err)
	}
	if want := "第一段 A\n\n第二段\n\n第三段 B\n"; !res.Merged || res.Content != want {
		t.Fatalf("得到 %q merged=%v", res.Content, res.Merged)
	}
}

func TestPruneHistoryKeepsRecentVersions(t *testing.T) {
	f := newFixture(t)
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	f.now = start
	busy := f.create(t, "busy.md", "0")
	for i := 1; i <= 60; i++ {
		if _, err := f.svc.Update(f.ctx, busy.ID, int64(i), string(rune('a'+i%26))+time.Duration(i).String()); err != nil {
			t.Fatal(err)
		}
	}
	old := f.create(t, "old.md", "1")
	if _, err := f.svc.Update(f.ctx, old.ID, 1, "2"); err != nil {
		t.Fatal(err)
	}
	f.now = start.Add(31 * 24 * time.Hour)
	fresh := f.create(t, "fresh.md", "x")

	if _, err := f.svc.PruneHistory(f.ctx); err != nil {
		t.Fatal(err)
	}
	revs := func(id string) (n, min int64) {
		f.svc.db.QueryRow(`SELECT COUNT(*), MIN(rev) FROM versions WHERE note_id = ?`, id).Scan(&n, &min)
		return
	}
	// 超过 30 天的版本只保留最新一版（合并时的 base 至少还有当前版本）
	if n, min := revs(busy.ID); n != 1 || min != 61 {
		t.Fatalf("busy 应只剩最新一版，得到 %d 版，最小 rev %d", n, min)
	}
	if n, min := revs(old.ID); n != 1 || min != 2 {
		t.Fatalf("old 应只剩最新一版，得到 %d 版，最小 rev %d", n, min)
	}
	if n, _ := revs(fresh.ID); n != 1 {
		t.Fatalf("fresh 不应被清理，得到 %d 版", n)
	}

	// 30 天内的版本最多保留最近 50 版
	for i := 61; i <= 120; i++ {
		if _, err := f.svc.Update(f.ctx, busy.ID, int64(i), "y"+time.Duration(i).String()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.svc.PruneHistory(f.ctx); err != nil {
		t.Fatal(err)
	}
	if n, min := revs(busy.ID); n != 50 || min != 72 {
		t.Fatalf("应保留最近 50 版（rev 72–121），得到 %d 版，最小 rev %d", n, min)
	}
}

func TestChangesSinceAndGoneAfterPrune(t *testing.T) {
	f := newFixture(t)
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	f.now = start
	a := f.create(t, "a.md", "1")
	f.create(t, "b.md", "1")
	cs, latest, err := f.svc.Changes(f.ctx, 1, 0)
	if err != nil || latest != 2 || len(cs) != 1 || cs[0].Path != "b.md" {
		t.Fatalf("changes since 1 = %+v latest=%d err=%v", cs, latest, err)
	}

	f.now = start.Add(31 * 24 * time.Hour)
	if _, err := f.svc.Update(f.ctx, a.ID, 1, "2"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.PruneHistory(f.ctx); err != nil {
		t.Fatal(err)
	}
	for _, since := range []int64{0, 1} {
		if _, _, err := f.svc.Changes(f.ctx, since, 0); !errors.Is(err, ErrGone) {
			t.Fatalf("since=%d 早于已清理范围，应返回 ErrGone，得到 %v", since, err)
		}
	}
	cs, latest, err = f.svc.Changes(f.ctx, 2, 0)
	if err != nil || latest != 3 || len(cs) != 1 || cs[0].Rev != 2 {
		t.Fatalf("since=2 仍应可用：%+v latest=%d err=%v", cs, latest, err)
	}
	if _, _, err := f.svc.Changes(f.ctx, 99, 0); !errors.Is(err, ErrGone) {
		t.Fatalf("since 超过最新序号（数据库被重建）应返回 ErrGone，得到 %v", err)
	}
}

func TestExternalChangesProduceChangeEvents(t *testing.T) {
	f := newFixture(t)
	types := func(since int64) []string {
		cs, _, err := f.svc.Changes(f.ctx, since, 0)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, c := range cs {
			out = append(out, fmt.Sprintf("%s %s r%d", c.Type, c.Path, c.Rev))
		}
		return out
	}
	f.writeDisk(t, "外部.md", "一")
	if _, err := f.svc.Reconcile(f.ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	f.writeDisk(t, "外部.md", "二")
	f.svc.Reconcile(f.ctx)
	os.Remove(filepath.Join(f.root, "外部.md"))
	f.svc.Reconcile(f.ctx)
	want := []string{"upsert 外部.md r1", "upsert 外部.md r2", "delete 外部.md r2"}
	if got := types(0); !slices.Equal(got, want) {
		t.Fatalf("外部新建、修改、删除都应产生变更事件（WS 推送和增量接口共用）：\n得到 %v\n期望 %v", got, want)
	}
}

func TestAppendAddsLineToLatestVersion(t *testing.T) {
	f := newFixture(t)
	n := f.create(t, "日记.md", "第一行")
	// 别处先改了一次：追加总是基于最新版本，不会冲突
	if _, err := f.svc.Update(f.ctx, n.ID, 1, "第一行（改）"); err != nil {
		t.Fatal(err)
	}
	got, err := f.svc.Append(f.ctx, n.ID, "追加的一行")
	if err != nil || got.Content != "第一行（改）\n追加的一行\n" || got.Rev != 3 {
		t.Fatalf("Append = %q rev %d, %v", got.Content, got.Rev, err)
	}
	got, err = f.svc.Append(f.ctx, n.ID, "再来一行\n")
	if err != nil || got.Content != "第一行（改）\n追加的一行\n再来一行\n" {
		t.Fatalf("已以换行结尾时不应多出空行：%q, %v", got.Content, err)
	}

	crlf := f.create(t, "crlf.md", "a\r\nb\r\n")
	got, err = f.svc.Append(f.ctx, crlf.ID, "c")
	if err != nil || got.Content != "a\r\nb\r\nc\r\n" {
		t.Fatalf("CRLF 笔记应沿用 CRLF：%q, %v", got.Content, err)
	}
	if _, err := f.svc.Append(f.ctx, "nope", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的笔记：%v", err)
	}
}
