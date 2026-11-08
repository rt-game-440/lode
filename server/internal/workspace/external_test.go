package workspace

import (
	"context"
	"crypto/sha256"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// #60：外部目录工作空间。

// dirState 返回目录里每个文件的相对路径和内容哈希（目录用 "/" 结尾表示）。
func dirState(t *testing.T, dir string) map[string][32]byte {
	t.Helper()
	out := map[string][32]byte{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
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

func sameState(a, b map[string][32]byte) bool {
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

func keys(m map[string][32]byte) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// writeObsidianVault 在 dir 里造一个像 Obsidian 库的目录：笔记、子目录、.obsidian 配置、非 Markdown 附件。
func writeObsidianVault(t *testing.T, dir string) {
	t.Helper()
	files := map[string]string{
		"首页.md":                    "# 首页\n\n[[读书/书单]] #索引\n",
		"读书/书单.md":                 "# 书单\n\n- 《三体》\n",
		"读书/笔记/三体.md":              "# 三体\n",
		".obsidian/app.json":       `{"alwaysUpdateLinks":true}`,
		".obsidian/workspace.json": `{"main":{}}`,
		"附件/图.bin":                 "\x00\x01\x02",
	}
	for name, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// 验收：路径相同、互相嵌套、是数据目录、是根目录、是主目录、不存在等都拒绝创建，错误信息能区分原因。
func TestCreateRejectsBadVaultDirs(t *testing.T) {
	ctx := context.Background()
	m, dataDir, _ := newManager(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	base := t.TempDir()
	good := filepath.Join(base, "库甲")
	if err := os.MkdirAll(filepath.Join(good, "子"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Create(ctx, CreateOptions{Name: "甲", VaultDir: good}); err != nil {
		t.Fatalf("合法的外部目录应能创建：%v", err)
	}
	file := filepath.Join(base, "文件.md")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	upper := good
	if runtime.GOOS == "windows" {
		upper = strings.ToUpper(good)
	}
	root := filepath.VolumeName(base) + string(filepath.Separator)

	cases := []struct {
		name, dir, reason string
	}{
		{"相对路径", "库乙", ReasonNotAbsolute},
		{"相对路径带点", "./库乙", ReasonNotAbsolute},
		{"不存在", filepath.Join(base, "不存在"), ReasonNotFound},
		{"是文件", file, ReasonNotDirectory},
		{"控制字符", base + "\x00x", ReasonInvalid},
		{"根目录", root, ReasonRoot},
		{"主目录", home, ReasonHome},
		{"数据目录", dataDir, ReasonDataDir},
		{"数据目录里的默认 vault", filepath.Join(dataDir, "vault"), ReasonInsideDataDir},
		{"数据目录里的内置空间", filepath.Join(dataDir, DirName), ReasonInsideDataDir},
		{"包含数据目录", filepath.Dir(dataDir), ReasonContainsData},
		{"与已有的外部目录相同", good, ReasonSameVault},
		{"与已有的外部目录相同（带斜杠、大小写）", upper + string(filepath.Separator), ReasonSameVault},
		{"在已有外部目录里面", filepath.Join(good, "子"), ReasonNestedVault},
		{"包含已有外部目录", base, ReasonNestedVault},
	}
	seen := map[string]bool{}
	for _, c := range cases {
		_, err := m.Create(ctx, CreateOptions{Name: "新", VaultDir: c.dir})
		var ve *VaultDirError
		if !errors.As(err, &ve) || !errors.Is(err, ErrInvalid) {
			t.Errorf("%s：期望 VaultDirError，得到 %v", c.name, err)
			continue
		}
		if ve.Reason != c.reason || ve.Msg == "" {
			t.Errorf("%s：原因 = %q（%s），期望 %q", c.name, ve.Reason, ve.Msg, c.reason)
		}
		seen[ve.Reason] = true
	}
	if len(seen) < 11 {
		t.Errorf("各种情况的原因应互不相同：%v", seen)
	}

	// 拒绝后不留痕迹：只有默认空间和「甲」，data/workspaces 下只有一个目录
	l, _ := m.List(ctx)
	if len(l) != 2 {
		t.Fatalf("拒绝后登记表 = %+v", l)
	}
	ents, _ := os.ReadDir(filepath.Join(dataDir, DirName))
	if len(ents) != 1 {
		t.Fatalf("拒绝后 data/workspaces 里应只有一个目录：%v", ents)
	}
	// 外部目录里没被写入任何东西
	if st := dirState(t, good); len(st) != 1 {
		t.Fatalf("外部目录被改动：%v", keys(st))
	}
}

// 验收：接入一个已有 Markdown 文件的目录后，对账出全部笔记；外部直接修改文件后能被监听到；
// 外部目录里不写任何东西（索引、回收站、锁都在 data/workspaces/<id>/）。
func TestExternalVaultReconcilesAndWatches(t *testing.T) {
	rec := record(t)
	ctx := context.Background()
	m, dataDir, _ := newManager(t)
	ext := t.TempDir()
	writeObsidianVault(t, ext)
	before := dirState(t, ext)

	in, err := m.Create(ctx, CreateOptions{Name: "Obsidian 库", VaultDir: ext})
	if err != nil {
		t.Fatal(err)
	}
	resolved, _ := filepath.EvalSymlinks(ext)
	if !in.External || in.VaultDir != resolved || in.Path != resolved {
		t.Fatalf("Info = %+v，期望外部目录 %s", in, resolved)
	}
	p := PathsFor(dataDir, in.ID, in.VaultDir)
	if p.Vault != resolved || filepath.Dir(p.Index) != p.Root || filepath.Dir(p.Trash) != p.Root {
		t.Fatalf("Paths = %+v", p)
	}
	for _, f := range []string{p.Index, p.Trash} {
		if _, err := os.Stat(f); err != nil {
			t.Fatalf("data/workspaces/<id>/ 下应有 %s：%v", f, err)
		}
	}
	if _, err := os.Stat(filepath.Join(p.Root, "vault")); err == nil {
		t.Fatal("外部目录的工作空间不应再建内置 vault")
	}
	list, _ := m.List(ctx)
	if got := list[1]; !got.External || got.VaultDir != resolved {
		t.Fatalf("List = %+v", got)
	}

	m.Start(ctx)
	w, err := m.Get(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	rec.wait(t, in.ID+":ready")
	if n, _ := w.Notes.NoteCount(ctx); n != 3 {
		t.Fatalf("对账出 %d 篇笔记，期望 3（.obsidian 和非 Markdown 文件不算）", n)
	}
	for _, path := range []string{"首页.md", "读书/书单.md", "读书/笔记/三体.md"} {
		if _, err := w.Notes.ReadByPath(ctx, path); err != nil {
			t.Errorf("缺 %s：%v", path, err)
		}
	}
	if after := dirState(t, ext); !sameState(before, after) {
		t.Fatalf("打开并对账后外部目录被改动：\n之前 %v\n之后 %v", keys(before), keys(after))
	}

	// 外部直接新增、修改、删除，监听能看到
	if err := os.WriteFile(filepath.Join(ext, "新来的.md"), []byte("# 新来的\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { _, err := w.Notes.ReadByPath(ctx, "新来的.md"); return err == nil })
	if err := os.WriteFile(filepath.Join(ext, "首页.md"), []byte("# 首页\n\n在 Obsidian 里改过\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		n, err := w.Notes.ReadByPath(ctx, "首页.md")
		return err == nil && strings.Contains(n.Content, "在 Obsidian 里改过")
	})
	if err := os.Remove(filepath.Join(ext, "读书", "笔记", "三体.md")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { _, err := w.Notes.ReadByPath(ctx, "读书/笔记/三体.md"); return err != nil })

	// 在 Lode 里改和删：改写进外部目录，删除的笔记进 data/workspaces/<id>/trash，不是外部目录里的 .trash
	cur, _ := w.Notes.ReadByPath(ctx, "新来的.md")
	if _, err := w.Notes.Update(ctx, cur.ID, cur.Rev, "# 新来的\n\n在 Lode 里改过\n"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(ext, "新来的.md")); !strings.Contains(string(b), "在 Lode 里改过") {
		t.Fatalf("Lode 的修改应写进外部文件：%q", b)
	}
	item, err := w.Notes.Delete(ctx, cur.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(ext, "新来的.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("删除后外部文件应已移走：%v", err)
	}
	if tr, _ := os.ReadDir(p.Trash); len(tr) == 0 {
		t.Fatal("删除的笔记应在 data/workspaces/<id>/trash")
	}
	if _, err := os.Stat(filepath.Join(ext, ".trash")); err == nil {
		t.Fatal("不应在外部目录里建回收站")
	}
	// 外部目录里没有 Lode 的任何文件
	for name := range dirState(t, ext) {
		if strings.Contains(name, "index.db") || strings.Contains(name, ".lock") || strings.Contains(name, "trash") {
			t.Errorf("外部目录里出现了 Lode 的文件：%s", name)
		}
	}
	// 回收站恢复仍可用
	if _, err := w.Notes.Restore(ctx, item.ID); err != nil {
		t.Fatalf("恢复: %v", err)
	}
	if _, err := os.Stat(filepath.Join(ext, "新来的.md")); err != nil {
		t.Fatalf("恢复后外部文件应回来：%v", err)
	}
}

// 验收：删除外部工作空间后，外部目录里的文件逐一校验哈希都没变；索引和回收站被移走。
func TestRemoveExternalWorkspaceKeepsEveryFile(t *testing.T) {
	rec := record(t)
	ctx := context.Background()
	m, dataDir, _ := newManager(t)
	ext := t.TempDir()
	writeObsidianVault(t, ext)

	in, err := m.Create(ctx, CreateOptions{Name: "外部", VaultDir: ext})
	if err != nil {
		t.Fatal(err)
	}
	insertToken(t, m, "tk", in.ID)
	m.Start(ctx)
	w, err := m.Get(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	rec.wait(t, in.ID+":ready")
	// 在 Lode 里建一篇再删掉：它在 data/workspaces/<id>/trash 里，是 Lode 的数据，不是外部文件
	tmp, err := w.Notes.Create(ctx, "临时.md", "# 临时\n")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Notes.Delete(ctx, tmp.ID); err != nil {
		t.Fatal(err)
	}
	before := dirState(t, ext)
	if len(before) == 0 {
		t.Fatal("外部目录应有文件")
	}

	res, err := m.Remove(ctx, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if res.RevokedTokens != 1 || !strings.HasPrefix(res.Trash, TrashDirName+"/"+in.ID+"-") {
		t.Fatalf("Remove = %+v", res)
	}
	if after := dirState(t, ext); !sameState(before, after) {
		t.Fatalf("外部目录被改动：\n之前 %v\n之后 %v", keys(before), keys(after))
	}
	if _, err := os.Stat(filepath.Join(dataDir, DirName, in.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("data/workspaces/<id> 应已移走：%v", err)
	}
	moved := filepath.Join(dataDir, filepath.FromSlash(res.Trash))
	if _, err := os.Stat(filepath.Join(moved, "index.db")); err != nil {
		t.Fatalf("索引应在 trash-workspaces 里：%v", err)
	}
	// 移走的目录里没有外部目录的笔记副本（只有回收站里 Lode 自己删掉的那篇）
	for name := range dirState(t, moved) {
		if strings.HasSuffix(name, ".md") && !strings.HasPrefix(name, "trash/") {
			t.Errorf("trash-workspaces 里不应有外部笔记的副本：%s", name)
		}
	}
	if _, err := m.Get(ctx, in.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("删除后 Get = %v", err)
	}
	// 同一个目录删除后可以重新接入
	if _, err := m.Create(ctx, CreateOptions{Name: "再接入", VaultDir: ext}); err != nil {
		t.Fatalf("删除后应能重新接入同一个目录：%v", err)
	}
}

// 外部目录不见了（被删、卷没挂载）时打开返回 ErrVaultUnavailable，不能悄悄建一个空目录再对账；
// 这样的工作空间仍可以删除。
func TestExternalVaultMissingIsNotRecreated(t *testing.T) {
	ctx := context.Background()
	m, _, _ := newManager(t)
	ext := filepath.Join(t.TempDir(), "库")
	if err := os.Mkdir(ext, 0o755); err != nil {
		t.Fatal(err)
	}
	in, err := m.Create(ctx, CreateOptions{Name: "会消失", VaultDir: ext})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(ext); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Get(ctx, in.ID); !errors.Is(err, ErrVaultUnavailable) {
		t.Fatalf("Get = %v，期望 ErrVaultUnavailable", err)
	}
	if _, err := os.Stat(ext); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("不应重新创建外部目录：%v", err)
	}
	if m.IsOpen(in.ID) {
		t.Fatal("打开失败不应留下半开的工作空间")
	}
	if l, err := m.List(ctx); err != nil || len(l) != 2 {
		t.Fatalf("List = %+v %v", l, err)
	}
	if _, err := m.Remove(ctx, in.ID); err != nil {
		t.Fatalf("目录不在时仍应能删除：%v", err)
	}
}
