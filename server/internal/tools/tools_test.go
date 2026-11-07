package tools

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/vault"
)

func newRegistry(t *testing.T) (*Registry, *notes.Service) {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	v, err := vault.New(filepath.Join(dir, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	svc := notes.New(notes.Options{DB: d, Vault: v, TrashDir: filepath.Join(dir, "trash")})
	return New(svc), svc
}

func call(t *testing.T, r *Registry, name, args string) (map[string]any, error) {
	t.Helper()
	res, err := r.Call(context.Background(), name, json.RawMessage(args), true)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(res.Text()), &out); err != nil {
		t.Fatalf("%s 的结果不是 JSON 对象：%v", name, err)
	}
	return out, nil
}

func TestReadNotePagesLongNotes(t *testing.T) {
	r, svc := newRegistry(t)
	var b strings.Builder
	for i := 1; i <= 5; i++ {
		b.WriteString("第" + string(rune('0'+i)) + "行\n")
	}
	if _, err := svc.Create(context.Background(), "长文.md", b.String()); err != nil {
		t.Fatal(err)
	}
	got, err := call(t, r, "read_note", `{"path":"长文.md","max_lines":2}`)
	if err != nil {
		t.Fatal(err)
	}
	if got["content"] != "第1行\n第2行\n" || got["total_lines"] != 5.0 || got["end_line"] != 2.0 || got["truncated"] != true || got["rev"] != 1.0 {
		t.Fatalf("第一段：%v", got)
	}
	got, err = call(t, r, "read_note", `{"path":"/长文.md","start_line":5}`)
	if err != nil || got["content"] != "第5行\n" || got["truncated"] != false || got["start_line"] != 5.0 {
		t.Fatalf("最后一段：%v, %v", got, err)
	}
	if _, err := call(t, r, "read_note", `{"path":"长文.md","start_line":9}`); err == nil || !strings.Contains(err.Error(), "只有 5 行") {
		t.Fatalf("超出范围：%v", err)
	}
}

func TestCallValidatesArgumentsAgainstSchema(t *testing.T) {
	r, _ := newRegistry(t)
	for _, tc := range []struct{ name, args, want string }{
		{"read_note", `{}`, "path"},
		{"search_notes", `{"query":"x","limit":500}`, "limit"},
		{"update_note", `{"path":"a.md","base_rev":1,"mode":"overwrite","content":"x"}`, "mode"},
		{"list_notes", `{"folder":"x"}`, "folder"},
	} {
		_, err := r.Call(context.Background(), tc.name, json.RawMessage(tc.args), true)
		if !errors.Is(err, ErrBadArguments) || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s %s 应报参数错误并提到 %s，得到 %v", tc.name, tc.args, tc.want, err)
		}
	}
	if _, err := r.Call(context.Background(), "list_tags", nil, false); err != nil {
		t.Errorf("无参数工具可以不传 arguments：%v", err)
	}
}

func TestReadOnlyCallerCannotSeeOrCallWriteTools(t *testing.T) {
	r, _ := newRegistry(t)
	names := func(ts []*Tool) (out []string) {
		for _, t := range ts {
			out = append(out, t.Name)
		}
		return
	}
	ro := strings.Join(names(r.Tools(false)), ",")
	if ro != "search_notes,read_note,list_notes,get_backlinks,list_tags,get_notes_by_tag" {
		t.Fatalf("只读工具：%s", ro)
	}
	if len(r.Tools(true)) != 10 {
		t.Fatalf("全部工具应有 10 个：%v", names(r.Tools(true)))
	}
	_, err := r.Call(context.Background(), "create_note", json.RawMessage(`{"path":"a.md","content":""}`), false)
	if !errors.Is(err, ErrReadOnly) {
		t.Fatalf("只读调用写工具应被拒：%v", err)
	}
}
