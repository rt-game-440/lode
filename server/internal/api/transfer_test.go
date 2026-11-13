package api

import (
	"os"
	"path/filepath"
	"testing"
)

// #72：POST /api/transfer 与 /api/w/{ws}/transfer。

func TestTransferAPI(t *testing.T) {
	c := newServer(t)
	c.setup()
	id, pw := c.newWorkspace("工作")
	n := c.mustDo("POST", "/api/notes", map[string]any{"path": "资料/a.md", "content": "a [[b]]\n"}, 201)
	c.mustDo("POST", "/api/notes", map[string]any{"path": "b.md", "content": "b\n"}, 201)
	c.mustDo("POST", "/api/notes", map[string]any{"path": "引用.md", "content": "[[a]]\n"}, 201)
	c.mustDo("POST", pw+"/notes", map[string]any{"path": "a.md", "content": "已有\n"}, 201)
	items := []map[string]any{{"kind": "note", "id": n["id"]}}

	// 参数校验
	for _, body := range []map[string]any{
		{"items": items, "target_workspace": id, "mode": "cut"},
		{"items": items, "mode": "copy"},
		{"items": items, "target_workspace": "default", "mode": "copy"},
		{"items": []map[string]any{}, "target_workspace": id, "mode": "copy"},
	} {
		if st, out := c.do("POST", "/api/transfer", body); st != 400 || out["code"] != "bad_request" {
			t.Errorf("%v = %d %v，期望 400", body, st, out)
		}
	}
	if st, out := c.do("POST", "/api/transfer", map[string]any{"items": items, "target_workspace": "nope00", "mode": "copy"}); st != 404 || out["code"] != "target_workspace_not_found" {
		t.Fatalf("目标不存在 = %d %v", st, out)
	}

	// 预演：会失效的链接数、改名项
	dry := c.mustDo("POST", "/api/transfer", map[string]any{"items": items, "target_workspace": id, "mode": "move", "dry_run": true}, 200)
	if dry["broken_links"] != 1.0 || len(dry["renamed"].([]any)) != 1 || dry["dry_run"] != true {
		t.Fatalf("预演 = %v", dry)
	}
	if len(c.mustDo("GET", "/api/notes?recursive=1", nil, 200)["notes"].([]any)) != 3 {
		t.Fatal("预演不应改动")
	}

	out := c.mustDo("POST", "/api/transfer", map[string]any{"items": items, "target_workspace": id, "mode": "move"}, 200)
	if out["trashed"] != 1.0 || out["source_workspace"] != "default" || out["target_workspace"] != id {
		t.Fatalf("移动 = %v", out)
	}
	moved := out["notes"].([]any)[0].(map[string]any)
	if moved["path"] != "a 1.md" {
		t.Fatalf("应自动改名：%v", moved)
	}
	got := c.mustDo("GET", pw+"/notes/"+moved["id"].(string), nil, 200)
	if got["content"] != "a [[b]]\n" {
		t.Fatalf("目标笔记 = %v", got)
	}
	trash := c.mustDo("GET", "/api/trash", nil, 200)["items"].([]any)
	if len(trash) != 1 {
		t.Fatalf("回收站 = %v", trash)
	}

	// 反方向：从工作空间复制回默认空间（/api/w/{ws}/transfer）
	back := c.mustDo("POST", pw+"/transfer", map[string]any{"items": []map[string]any{{"kind": "note", "path": "a.md"}}, "target_workspace": "default", "target_dir": "导入", "mode": "copy"}, 200)
	if p := back["notes"].([]any)[0].(map[string]any)["path"]; p != "导入/a.md" {
		t.Fatalf("复制回来 = %v", back)
	}
}

// 目标外部目录不可用：503 workspace_vault_unavailable，workspace 字段指出是哪个空间。
func TestTransferAPITargetVaultUnavailable(t *testing.T) {
	c := newServer(t)
	c.setup()
	ext := filepath.Join(t.TempDir(), "库")
	if err := os.Mkdir(ext, 0o755); err != nil {
		t.Fatal(err)
	}
	id := c.mustDo("POST", "/api/workspaces", map[string]any{"name": "外部", "vault_dir": ext}, 201)["id"].(string)
	c.mustDo("GET", "/api/w/"+id+"/tree", nil, 200) // 先打开
	if err := os.RemoveAll(ext); err != nil {
		t.Fatal(err)
	}
	n := c.mustDo("POST", "/api/notes", map[string]any{"path": "a.md", "content": "a\n"}, 201)
	st, out := c.do("POST", "/api/transfer", map[string]any{"items": []map[string]any{{"kind": "note", "id": n["id"]}}, "target_workspace": id, "mode": "move"})
	if st != 503 || out["code"] != "workspace_vault_unavailable" || out["workspace"] != id {
		t.Fatalf("= %d %v", st, out)
	}
	if _, err := os.Stat(ext); !os.IsNotExist(err) {
		t.Fatal("不应重新创建外部目录")
	}
	c.mustDo("GET", "/api/notes/"+n["id"].(string), nil, 200)
}
