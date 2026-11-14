package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/rt-game-440/lode/server/internal/notes"
)

// #72：工作空间之间移动和复制（内置 ↔ 外部目录、目标不可用、两边的变更流）。

func notePaths(t *testing.T, w *Workspace) []string {
	t.Helper()
	list, err := w.Notes.List(context.Background(), "", true)
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

func readFile(t *testing.T, dir, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("读取 %s: %v", rel, err)
	}
	return string(b)
}

func mustCreate(t *testing.T, w *Workspace, p, content string) notes.NoteContent {
	t.Helper()
	n, err := w.Notes.Create(context.Background(), p, content)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func writeAttachment(t *testing.T, w *Workspace, rel, content string) {
	t.Helper()
	abs := filepath.Join(w.Notes.Vault().Root(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 内置 → 内置、内置 → 外部、外部 → 内置，各做一次复制和移动；附件随行，移动后源条目在回收站可恢复。
func TestTransferBetweenBuiltInAndExternal(t *testing.T) {
	ctx := context.Background()
	m, _, _ := newManager(t)
	ext := t.TempDir()
	inInfo, err := m.Create(ctx, CreateOptions{Name: "内置"})
	if err != nil {
		t.Fatal(err)
	}
	extInfo, err := m.Create(ctx, CreateOptions{Name: "外部", VaultDir: ext})
	if err != nil {
		t.Fatal(err)
	}
	def := m.Default()
	in, err := m.Get(ctx, inInfo.ID)
	if err != nil {
		t.Fatal(err)
	}
	ex, err := m.Get(ctx, extInfo.ID)
	if err != nil {
		t.Fatal(err)
	}

	steps := []struct {
		name     string
		src, dst *Workspace
	}{
		{"内置到内置", def, in},
		{"内置到外部", in, ex},
		{"外部到内置", ex, def},
	}
	for _, st := range steps {
		t.Run(st.name, func(t *testing.T) {
			writeAttachment(t, st.src, "attachments/"+st.name+".png", "图-"+st.name)
			body := "# " + st.name + "\n\n![[" + st.name + ".png]]\n"
			cp := mustCreate(t, st.src, st.name+"-复制.md", body)
			mv := mustCreate(t, st.src, st.name+"/移动.md", "移动\n![](attachments/"+st.name+".png)\n")

			res, err := m.Transfer(ctx, st.src, st.dst.ID, notes.TransferOptions{Items: []notes.TransferItem{{Kind: "note", ID: cp.ID}}})
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Notes) != 1 || res.Notes[0].Path != st.name+"-复制.md" || len(res.Attachments) != 1 {
				t.Fatalf("复制结果 = %+v", res)
			}
			dstRoot := st.dst.Notes.Vault().Root()
			if readFile(t, dstRoot, st.name+"-复制.md") != body || readFile(t, dstRoot, "attachments/"+st.name+".png") != "图-"+st.name {
				t.Fatal("复制的笔记或附件不对")
			}
			if _, err := st.src.Notes.Get(ctx, cp.ID); err != nil {
				t.Fatalf("复制后源笔记应还在：%v", err)
			}

			res, err = m.Transfer(ctx, st.src, st.dst.ID, notes.TransferOptions{Items: []notes.TransferItem{{Kind: "folder", Path: st.name}}, Move: true})
			if err != nil {
				t.Fatal(err)
			}
			if res.Trashed != 1 || len(res.Notes) != 1 || res.Notes[0].Path != st.name+"/移动.md" {
				t.Fatalf("移动结果 = %+v", res)
			}
			if len(res.Attachments) != 0 {
				t.Fatalf("同样内容的附件已在目标里，应复用：%+v", res.Attachments)
			}
			if !slices.Contains(notePaths(t, st.dst), st.name+"/移动.md") || slices.Contains(notePaths(t, st.src), st.name+"/移动.md") {
				t.Fatal("移动后两边的笔记不对")
			}
			// 源空间的附件不删除（可能被其他笔记引用）
			if readFile(t, st.src.Notes.Vault().Root(), "attachments/"+st.name+".png") != "图-"+st.name {
				t.Fatal("移动不应删除源空间的附件")
			}
			if _, err := st.src.Notes.Restore(ctx, mv.ID); err != nil {
				t.Fatalf("回收站里应能恢复：%v", err)
			}
			if readFile(t, st.src.Notes.Vault().Root(), st.name+"/移动.md") != "移动\n![](attachments/"+st.name+".png)\n" {
				t.Fatal("恢复的内容不对")
			}
		})
	}
	// 外部目录里没有留下暂存目录
	entries, _ := os.ReadDir(ext)
	for _, e := range entries {
		if e.Name()[0] == '.' {
			t.Fatalf("外部目录里留下了 %s", e.Name())
		}
	}
}

// 目标是外部目录且不可用（打开前或打开后被移走）：返回 ErrVaultUnavailable（包在 TargetError 里），源不变。
// 目标不存在：TargetError 包着 ErrNotFound；目标就是来源：ErrInvalid。
func TestTransferTargetUnavailable(t *testing.T) {
	ctx := context.Background()
	m, _, _ := newManager(t)
	def := m.Default()
	n := mustCreate(t, def, "笔记.md", "内容\n")

	mk := func(name string) (Info, string) {
		dir := filepath.Join(t.TempDir(), name)
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		info, err := m.Create(ctx, CreateOptions{Name: name, VaultDir: dir})
		if err != nil {
			t.Fatal(err)
		}
		return info, dir
	}
	notOpened, dir1 := mk("没打开")
	opened, dir2 := mk("已打开")
	if _, err := m.Get(ctx, opened.ID); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{dir1, dir2} {
		if err := os.RemoveAll(d); err != nil {
			t.Fatal(err)
		}
	}
	items := []notes.TransferItem{{Kind: "note", ID: n.ID}}
	for _, id := range []string{notOpened.ID, opened.ID} {
		_, err := m.Transfer(ctx, def, id, notes.TransferOptions{Items: items, Move: true})
		var te *TargetError
		if !errors.As(err, &te) || te.ID != id || !errors.Is(err, ErrVaultUnavailable) {
			t.Fatalf("Transfer 到 %s = %v，期望目标不可用", id, err)
		}
		if _, err := os.Stat(filepath.Join(dir1)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("不应重新创建外部目录")
		}
	}
	if !slices.Equal(notePaths(t, def), []string{"笔记.md"}) {
		t.Fatal("源不应改动")
	}
	_, err := m.Transfer(ctx, def, "nope00", notes.TransferOptions{Items: items})
	var te *TargetError
	if !errors.As(err, &te) || !errors.Is(err, ErrNotFound) {
		t.Fatalf("目标不存在 = %v", err)
	}
	if _, err := m.Transfer(ctx, def, DefaultID, notes.TransferOptions{Items: items}); !errors.Is(err, notes.ErrInvalid) {
		t.Fatalf("目标与来源相同 = %v", err)
	}
}

// 两个空间都在监听（Start 之后）：移动后目标只推送 upsert、源只推送 delete，各自一条一篇，
// 文件监听随后的对账不会再产生重复的事件。
func TestTransferChangeStreams(t *testing.T) {
	rec := record(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m, _, _ := newManager(t)
	info, err := m.Create(ctx, CreateOptions{Name: "B"})
	if err != nil {
		t.Fatal(err)
	}
	m.Start(ctx)
	rec.wait(t, "default:ready")
	def := m.Default()
	b, err := m.Get(ctx, info.ID)
	if err != nil {
		t.Fatal(err)
	}
	rec.wait(t, info.ID+":ready")
	mustCreate(t, def, "夹/一.md", "一\n")
	mustCreate(t, def, "夹/二.md", "二\n")
	writeAttachment(t, def, "夹/图.png", "图")
	time.Sleep(100 * time.Millisecond) // 让上面写入的监听事件先处理完

	subA, stopA := def.Notes.Subscribe(32)
	defer stopA()
	subB, stopB := b.Notes.Subscribe(32)
	defer stopB()
	if _, err := m.Transfer(ctx, def, b.ID, notes.TransferOptions{Items: []notes.TransferItem{{Kind: "folder", Path: "夹"}}, Move: true}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond) // 超过监听去抖时间，等对账跑完
	collect := func(ch <-chan notes.Change) []string {
		var out []string
		for {
			select {
			case c := <-ch:
				out = append(out, c.Type+":"+c.Path)
			default:
				slices.Sort(out)
				return out
			}
		}
	}
	if got := collect(subA); !slices.Equal(got, []string{"delete:夹/一.md", "delete:夹/二.md"}) {
		t.Fatalf("源变更 = %v", got)
	}
	if got := collect(subB); !slices.Equal(got, []string{"upsert:夹/一.md", "upsert:夹/二.md"}) {
		t.Fatalf("目标变更 = %v", got)
	}
	if !slices.Equal(notePaths(t, b), []string{"夹/一.md", "夹/二.md"}) || len(notePaths(t, def)) != 0 {
		t.Fatal("移动后两边的索引不对")
	}
	if readFile(t, b.Notes.Vault().Root(), "夹/图.png") != "图" {
		t.Fatal("文件夹里的图片应随行")
	}
}
