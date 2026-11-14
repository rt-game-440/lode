package notes

import (
	"crypto/sha256"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// #72：在工作空间之间移动和复制。这里用两个独立的 Service（各自的库、vault、回收站）代表两个工作空间。

func (f *fixture) write(t *testing.T, rel, content string) {
	t.Helper()
	abs := filepath.Join(f.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// tree 返回 vault 里每个文件的相对路径和内容哈希（目录以 "/" 结尾）。
func (f *fixture) tree(t *testing.T) map[string][32]byte {
	t.Helper()
	out := map[string][32]byte{}
	err := filepath.WalkDir(f.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(f.root, p)
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			out[rel+"/"] = [32]byte{}
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out[rel] = sha256.Sum256(b)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func treeKeys(m map[string][32]byte) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func (f *fixture) notePaths(t *testing.T) []string {
	t.Helper()
	list, err := f.svc.List(f.ctx, "", true)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, n := range list {
		out = append(out, n.Path)
	}
	slices.Sort(out)
	return out
}

func (f *fixture) latestSeq(t *testing.T) int64 {
	t.Helper()
	s, err := f.svc.LatestSeq(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// 复制一篇带图片的笔记：图片随行、链接可用，源空间不变，目标空间产生 upsert 变更。
func TestTransferCopyNoteWithAttachments(t *testing.T) {
	a, b := newFixture(t), newFixture(t)
	a.write(t, "attachments/图.png", "PNG-1")
	a.write(t, "资料/局部.jpg", "JPG")
	a.write(t, "docs/说明 书.pdf", "PDF")
	body := "# 带图\n\n![[图.png]] ![[局部.jpg|200]]\n![说明](docs/说明%20书.pdf) ![外链](https://example.com/x.png)\n[[别的笔记]]\n"
	n := a.create(t, "资料/带图.md", body)
	beforeA := a.tree(t)
	seqA := a.latestSeq(t)

	res, err := Transfer(b.ctx, a.svc, b.svc, TransferOptions{Items: []TransferItem{{Kind: "note", ID: n.ID}}, Dir: "收件箱"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Notes) != 1 || res.Notes[0].Path != "收件箱/带图.md" || res.Notes[0].FromID != n.ID || res.Notes[0].ID == "" || res.Notes[0].ID == n.ID {
		t.Fatalf("Notes = %+v", res.Notes)
	}
	if len(res.Renamed) != 0 || res.Trashed != 0 {
		t.Fatalf("不应改名或进回收站：%+v", res)
	}
	// 链接没有改写：同目录的图片放到新目录，attachments/ 和根起的路径原样保留
	if got := b.disk(t, "收件箱/带图.md"); got != body {
		t.Fatalf("正文 = %q", got)
	}
	for rel, want := range map[string]string{"attachments/图.png": "PNG-1", "收件箱/局部.jpg": "JPG", "docs/说明 书.pdf": "PDF"} {
		if got := b.disk(t, rel); got != want {
			t.Fatalf("%s = %q，期望 %q", rel, got, want)
		}
	}
	if len(res.Attachments) != 3 {
		t.Fatalf("Attachments = %+v", res.Attachments)
	}
	got, err := b.svc.Read(b.ctx, res.Notes[0].ID)
	if err != nil || got.Content != body || got.Rev != 1 {
		t.Fatalf("目标笔记 = %+v %v", got, err)
	}
	if !slices.Equal(b.notePaths(t), []string{"收件箱/带图.md"}) {
		t.Fatalf("目标笔记 = %v", b.notePaths(t))
	}
	// 源空间原样
	if !sameTree(a.tree(t), beforeA) || a.latestSeq(t) != seqA {
		t.Fatal("复制不应改动源空间")
	}
	if _, err := os.ReadDir(filepath.Join(b.root)); err != nil {
		t.Fatal(err)
	}
	for _, k := range treeKeys(b.tree(t)) {
		if strings.HasPrefix(k, ".lode") {
			t.Fatalf("暂存目录没有清理：%s", k)
		}
	}
}

func sameTree(a, b map[string][32]byte) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if w, ok := b[k]; !ok || w != v {
			return false
		}
	}
	return true
}

// 目标位置已有同名笔记、文件夹和内容不同的附件：自动改名，附件链接改成新路径，结果里列出改名项。
// 内容相同的附件直接复用。
func TestTransferRenamesOnConflict(t *testing.T) {
	a, b := newFixture(t), newFixture(t)
	a.write(t, "attachments/图.png", "源图")
	a.write(t, "attachments/同.png", "一样")
	n := a.create(t, "笔记.md", "![[图.png]] ![[同.png]] ![x](attachments/图.png)\n")
	a.create(t, "项目/计划.md", "计划\n")
	a.write(t, "项目/封面.png", "封面")

	b.create(t, "笔记.md", "目标已有\n")
	b.create(t, "项目/旧.md", "旧\n")
	b.write(t, "attachments/图.png", "目标的图")
	b.write(t, "attachments/同.png", "一样")

	res, err := Transfer(b.ctx, a.svc, b.svc, TransferOptions{Items: []TransferItem{{Kind: "note", ID: n.ID}, {Kind: "folder", Path: "项目"}}})
	if err != nil {
		t.Fatal(err)
	}
	wantRenamed := []TransferRename{
		{Kind: "note", From: "笔记.md", To: "笔记 1.md"},
		{Kind: "folder", From: "项目", To: "项目 1"},
		{Kind: "attachment", From: "attachments/图.png", To: "attachments/图-1.png"},
	}
	if !slices.Equal(res.Renamed, wantRenamed) {
		t.Fatalf("Renamed = %+v", res.Renamed)
	}
	if got := b.disk(t, "笔记 1.md"); got != "![[attachments/图-1.png]] ![[同.png]] ![x](attachments/图-1.png)\n" {
		t.Fatalf("改写后的正文 = %q", got)
	}
	if b.disk(t, "attachments/图-1.png") != "源图" || b.disk(t, "attachments/图.png") != "目标的图" || b.disk(t, "attachments/同.png") != "一样" {
		t.Fatal("附件内容不对")
	}
	if b.disk(t, "项目 1/计划.md") != "计划\n" || b.disk(t, "项目 1/封面.png") != "封面" || b.disk(t, "笔记.md") != "目标已有\n" {
		t.Fatal("文件夹或已有笔记不对")
	}
	if !slices.Equal(b.notePaths(t), []string{"笔记 1.md", "笔记.md", "项目 1/计划.md", "项目/旧.md"}) {
		t.Fatalf("目标笔记 = %v", b.notePaths(t))
	}
}

// 移动文件夹和笔记：源条目进回收站可以恢复；统计源空间里会失效的链接；文件夹里的图片随行，源文件夹清掉。
func TestTransferMoveTrashesSourceAndCountsBrokenLinks(t *testing.T) {
	a, b := newFixture(t), newFixture(t)
	a.create(t, "项目/计划.md", "计划 [[总结]]\n")
	sum := a.create(t, "项目/子/总结.md", "总结\n")
	a.write(t, "项目/子/图.png", "图")
	a.create(t, "首页.md", "[[计划]] 和 [[总结]] 还有 [[计划|别名]]\n")
	solo := a.create(t, "单篇.md", "单篇\n")
	a.create(t, "引用单篇.md", "[[单篇]]\n")

	dry, err := Transfer(b.ctx, a.svc, b.svc, TransferOptions{Items: []TransferItem{{Kind: "folder", Path: "项目"}, {Kind: "note", ID: solo.ID}}, Move: true, DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if dry.BrokenLinks != 4 || dry.Notes[0].ID != "" {
		t.Fatalf("dry run = %+v", dry)
	}
	if len(b.notePaths(t)) != 0 || len(a.notePaths(t)) != 5 {
		t.Fatal("dry run 不应改动任何东西")
	}

	subA, cancelA := a.svc.Subscribe(16)
	defer cancelA()
	subB, cancelB := b.svc.Subscribe(16)
	defer cancelB()

	res, err := Transfer(b.ctx, a.svc, b.svc, TransferOptions{Items: []TransferItem{{Kind: "folder", Path: "项目"}, {Kind: "note", ID: solo.ID}, {Kind: "note", ID: sum.ID}}, Dir: "归档", Move: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.Trashed != 3 || res.BrokenLinks != 4 || len(res.Items) != 2 {
		t.Fatalf("结果 = %+v", res)
	}
	if !slices.Equal(b.notePaths(t), []string{"归档/单篇.md", "归档/项目/子/总结.md", "归档/项目/计划.md"}) {
		t.Fatalf("目标笔记 = %v", b.notePaths(t))
	}
	if b.disk(t, "归档/项目/子/图.png") != "图" {
		t.Fatal("文件夹里的图片应随行")
	}
	if !slices.Equal(a.notePaths(t), []string{"引用单篇.md", "首页.md"}) {
		t.Fatalf("源笔记 = %v", a.notePaths(t))
	}
	if a.exists("项目") {
		t.Fatal("源文件夹应已移走")
	}
	// 链接不跨空间改写
	if a.disk(t, "首页.md") != "[[计划]] 和 [[总结]] 还有 [[计划|别名]]\n" {
		t.Fatal("源空间的链接不应被改写")
	}
	// 回收站里可以恢复
	trash, err := a.svc.ListTrash(a.ctx)
	if err != nil || len(trash) != 3 {
		t.Fatalf("回收站 = %+v %v", trash, err)
	}
	if _, err := a.svc.Restore(a.ctx, solo.ID); err != nil {
		t.Fatal(err)
	}
	if a.disk(t, "单篇.md") != "单篇\n" {
		t.Fatal("恢复后内容不对")
	}

	// 变更流：目标 3 条 upsert，源 3 条 delete（之后恢复又有 1 条 upsert）
	evB := drain(subB)
	evA := drain(subA)
	if len(evB) != 3 || evB[0].Type != "upsert" || evB[2].Type != "upsert" {
		t.Fatalf("目标变更 = %+v", evB)
	}
	var del []string
	for _, c := range evA {
		if c.Type == "delete" {
			del = append(del, c.Path)
		}
	}
	slices.Sort(del)
	if !slices.Equal(del, []string{"单篇.md", "项目/子/总结.md", "项目/计划.md"}) {
		t.Fatalf("源变更 = %+v", evA)
	}
	ch, _, err := b.svc.Changes(b.ctx, 0, 100)
	if err != nil || len(ch) != 3 {
		t.Fatalf("目标 /changes = %+v %v", ch, err)
	}
}

func drain(ch <-chan Change) []Change {
	var out []Change
	deadline := time.After(time.Second)
	for {
		select {
		case c := <-ch:
			out = append(out, c)
		case <-deadline:
			return out
		default:
			if len(out) > 0 {
				select {
				case c := <-ch:
					out = append(out, c)
					continue
				case <-time.After(50 * time.Millisecond):
					return out
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

// 中途失败：目标空间不留任何文件和索引，源空间不变（移动时已进回收站的源笔记恢复原位）。
func TestTransferFailureLeavesNothingBehind(t *testing.T) {
	for _, tc := range []struct {
		stage string
		at    int
		move  bool
	}{
		{"staged", 1, false},
		{"unit", 2, false}, // 第一个条目已放进去之后
		{"indexed", 1, true},
		{"trashed", 1, true}, // 源笔记都已进回收站之后
	} {
		t.Run(tc.stage, func(t *testing.T) {
			a, b := newFixture(t), newFixture(t)
			a.write(t, "attachments/图.png", "图")
			n := a.create(t, "笔记.md", "![[图.png]]\n")
			a.create(t, "夹/里面.md", "里面\n")
			b.create(t, "已有.md", "已有\n")
			beforeA, beforeB := a.tree(t), b.tree(t)
			seqB := b.latestSeq(t)
			calls := 0
			transferHook = func(stage string) error {
				if stage == tc.stage {
					calls++
					if calls == tc.at {
						return errors.New("注入的失败")
					}
				}
				return nil
			}
			defer func() { transferHook = nil }()
			_, err := Transfer(b.ctx, a.svc, b.svc, TransferOptions{
				Items: []TransferItem{{Kind: "note", ID: n.ID}, {Kind: "folder", Path: "夹"}}, Dir: "新/深", Move: tc.move,
			})
			if err == nil || !strings.Contains(err.Error(), "注入的失败") {
				t.Fatalf("应返回注入的失败，得到 %v", err)
			}
			if got := b.tree(t); !sameTree(got, beforeB) {
				t.Fatalf("目标空间留下了文件：%v → %v", treeKeys(beforeB), treeKeys(got))
			}
			if !slices.Equal(b.notePaths(t), []string{"已有.md"}) || b.latestSeq(t) != seqB {
				t.Fatalf("目标索引被改动：%v", b.notePaths(t))
			}
			if got := a.tree(t); !sameTree(got, beforeA) {
				t.Fatalf("源空间被改动：%v → %v", treeKeys(beforeA), treeKeys(got))
			}
			if !slices.Equal(a.notePaths(t), []string{"夹/里面.md", "笔记.md"}) {
				t.Fatalf("源笔记 = %v", a.notePaths(t))
			}
			if tr, _ := a.svc.ListTrash(a.ctx); len(tr) != 0 {
				t.Fatalf("回收站应为空：%+v", tr)
			}
		})
	}
}

func TestTransferRejectsBadInput(t *testing.T) {
	a, b := newFixture(t), newFixture(t)
	n := a.create(t, "a.md", "a\n")
	b.write(t, "文件", "x")
	cases := []struct {
		opts TransferOptions
		want error
	}{
		{TransferOptions{}, ErrInvalid},
		{TransferOptions{Items: []TransferItem{{Kind: "note", ID: "nope"}}}, ErrNotFound},
		{TransferOptions{Items: []TransferItem{{Kind: "folder", Path: "没有"}}}, ErrNotFound},
		{TransferOptions{Items: []TransferItem{{Kind: "x", ID: n.ID}}}, ErrInvalid},
		{TransferOptions{Items: []TransferItem{{Kind: "note", ID: n.ID}}, Dir: "../外面"}, ErrInvalidPath},
		{TransferOptions{Items: []TransferItem{{Kind: "note", ID: n.ID}}, Dir: "文件"}, ErrInvalid},
	}
	for i, c := range cases {
		if _, err := Transfer(a.ctx, a.svc, b.svc, c.opts); !errors.Is(err, c.want) {
			t.Errorf("#%d: %v，期望 %v", i, err, c.want)
		}
	}
	if _, err := Transfer(a.ctx, a.svc, a.svc, TransferOptions{Items: []TransferItem{{Kind: "note", ID: n.ID}}}); !errors.Is(err, ErrInvalid) {
		t.Errorf("同一个空间：%v", err)
	}
}
