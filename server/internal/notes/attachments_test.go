package notes

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func (f *fixture) exists(p string) bool {
	_, err := os.Stat(filepath.Join(f.root, filepath.FromSlash(p)))
	return err == nil
}

func (f *fixture) upload(t *testing.T, name, content string) string {
	t.Helper()
	rel, err := f.svc.SaveAttachment(f.ctx, name, strings.NewReader(content), 1<<20)
	if err != nil {
		t.Fatalf("上传 %s: %v", name, err)
	}
	return rel
}

// 上传被拒绝（超限、不允许的类型）时不应留下空的 attachments/ 文件夹。
func TestFailedUploadDoesNotCreateAttachmentsFolder(t *testing.T) {
	f := newFixture(t)
	if _, err := f.svc.SaveAttachment(f.ctx, "big.png", strings.NewReader("0123456789"), 4); !errors.Is(err, ErrInvalid) {
		t.Fatalf("超限应返回 ErrInvalid，实际 %v", err)
	}
	if f.exists(AttachmentDir) {
		t.Fatal("超限的上传不应创建 attachments/")
	}
	if _, err := f.svc.SaveAttachment(f.ctx, "x.md", strings.NewReader("x"), 10); !errors.Is(err, ErrInvalid) {
		t.Fatalf(".md 应被拒绝，实际 %v", err)
	}
	if f.exists(AttachmentDir) {
		t.Fatal("被拒绝的上传不应创建 attachments/")
	}
	// 读取上传内容时出错同样不应留下文件夹
	if _, err := f.svc.SaveAttachment(f.ctx, "broken.png", &failingReader{}, 100); err == nil {
		t.Fatal("读取失败应返回错误")
	}
	if f.exists(AttachmentDir) {
		t.Fatal("中途失败的上传不应创建 attachments/")
	}
	if entries, _ := os.ReadDir(f.root); len(entries) != 0 {
		t.Fatalf("失败的上传不应在 vault 里留下临时文件：%v", entries)
	}
}

type failingReader struct{ n int }

func (r *failingReader) Read(p []byte) (int, error) {
	if r.n > 0 {
		return 0, errors.New("连接中断")
	}
	r.n++
	return copy(p, "abc"), nil
}

// 用户删除 attachments/ 之后，对账、再次对账、重启后的全量对账都不会把它建回来；
// 只有再次上传才会创建。
func TestDeletedAttachmentsFolderIsNotRecreated(t *testing.T) {
	f := newFixture(t)
	f.create(t, "笔记.md", "![[attachments/a.png]]")
	f.upload(t, "a.png", "png")
	if _, err := f.svc.Reconcile(f.ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.DeleteFolder(f.ctx, AttachmentDir); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := f.svc.Reconcile(f.ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Reconcile(f.ctx, AttachmentDir, "attachments/a.png"); err != nil {
			t.Fatal(err)
		}
	}
	if f.exists(AttachmentDir) {
		t.Fatal("删除后磁盘上不应出现 attachments/")
	}
	// 引用它的笔记被改写、移动、进出回收站，都不会重建
	n, err := f.svc.Get(f.ctx, mustID(t, f, "笔记.md"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Update(f.ctx, n.ID, n.Rev, "![[attachments/a.png]] 改过"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Delete(f.ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	trash, _ := f.svc.ListTrash(f.ctx)
	if len(trash) != 1 {
		t.Fatalf("回收站 = %+v", trash)
	}
	if _, err := f.svc.Restore(f.ctx, trash[0].ID); err != nil {
		t.Fatal(err)
	}
	if f.exists(AttachmentDir) {
		t.Fatal("笔记的改写、删除、恢复不应重建 attachments/")
	}
	tree, _ := f.svc.Tree(f.ctx)
	for _, p := range tree.Folders {
		if p == AttachmentDir {
			t.Fatalf("文件树不应再有 attachments：%v", tree.Folders)
		}
	}
	// 再次上传才会重新创建
	f.upload(t, "b.png", "png")
	if !f.exists(AttachmentDir + "/b.png") {
		t.Fatal("上传应创建 attachments/")
	}
}

func mustID(t *testing.T, f *fixture, p string) string {
	t.Helper()
	tree, err := f.svc.Tree(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range tree.Notes {
		if n.Path == p {
			return n.ID
		}
	}
	t.Fatalf("没有笔记 %s", p)
	return ""
}

// 只有附件、没有笔记的 attachments/ 不在文件树里显示；放了笔记就正常显示。
func TestAttachmentOnlyFolderHiddenFromTree(t *testing.T) {
	f := newFixture(t)
	f.upload(t, "a.png", "png")
	f.writeDisk(t, "照片/b.png", "png")
	f.create(t, "旅行/日记.md", "x")
	if _, err := f.svc.Reconcile(f.ctx); err != nil {
		t.Fatal(err)
	}
	tree, _ := f.svc.Tree(f.ctx)
	got := strings.Join(tree.Folders, ",")
	if got != "旅行" {
		t.Fatalf("文件树文件夹 = %q，只有附件的文件夹不应显示", got)
	}
	ls, err := f.svc.ListFolder(f.ctx, "", false)
	if err != nil || strings.Join(ls.Folders, ",") != "旅行" {
		t.Fatalf("ListFolder = %+v, %v", ls, err)
	}
	// 文件夹里有笔记就显示
	f.create(t, "attachments/说明.md", "x")
	tree, _ = f.svc.Tree(f.ctx)
	if got := strings.Join(tree.Folders, ","); got != "attachments,旅行" {
		t.Fatalf("放了笔记之后文件夹 = %q", got)
	}
	// 用户明确新建的空文件夹仍然显示
	if _, err := f.svc.CreateFolder(f.ctx, "空的"); err != nil {
		t.Fatal(err)
	}
	tree, _ = f.svc.Tree(f.ctx)
	if got := strings.Join(tree.Folders, ","); got != "attachments,旅行,空的" {
		t.Fatalf("空文件夹应显示：%q", got)
	}
}
