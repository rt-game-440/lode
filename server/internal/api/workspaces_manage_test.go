package api

import (
	"bytes"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// #59：改名、排序、删除工作空间，token 绑定工作空间，审计按空间筛选。

func (c *client) workspaceNames() string {
	c.t.Helper()
	var names []string
	for i, w := range c.mustDo("GET", "/api/workspaces", nil, 200)["workspaces"].([]any) {
		m := w.(map[string]any)
		if m["sort"] != float64(i) {
			c.t.Fatalf("sort 应等于位置：%v", m)
		}
		names = append(names, m["name"].(string))
	}
	return strings.Join(names, ",")
}

func TestPatchWorkspace(t *testing.T) {
	c := newServer(t)
	if st, _ := c.do("PATCH", "/api/workspaces/default", map[string]any{"name": "x"}); st != 401 {
		t.Fatalf("未登录应 401，得到 %d", st)
	}
	if st, _ := c.do("DELETE", "/api/workspaces/abc", nil); st != 401 {
		t.Fatalf("未登录应 401，得到 %d", st)
	}
	c.setup()
	a, _ := c.newWorkspace("甲")
	b, _ := c.newWorkspace("乙")

	out := c.mustDo("PATCH", "/api/workspaces/"+a, map[string]any{"name": " 甲甲 "}, 200)
	if out["id"] != a || out["name"] != "甲甲" || out["path"] != "workspaces/"+a+"/vault" {
		t.Fatalf("改名 = %v", out)
	}
	c.mustDo("PATCH", "/api/workspaces/default", map[string]any{"name": "主库"}, 200) // 默认工作空间可以改名
	out = c.mustDo("PATCH", "/api/workspaces/"+b, map[string]any{"sort": 0}, 200)
	if out["sort"] != 0.0 {
		t.Fatalf("排序 = %v", out)
	}
	if got := c.workspaceNames(); got != "乙,主库,甲甲" {
		t.Fatalf("顺序 = %s", got)
	}
	c.mustDo("PATCH", "/api/workspaces/"+b, map[string]any{"name": "乙乙", "sort": 99}, 200) // 一起改
	if got := c.workspaceNames(); got != "主库,甲甲,乙乙" {
		t.Fatalf("顺序 = %s", got)
	}

	for _, body := range []map[string]any{{}, {"name": ""}, {"name": "  "}, {"name": strings.Repeat("长", 65)}, {"sort": -1}} {
		if st, out := c.do("PATCH", "/api/workspaces/"+a, body); st != 400 || out["code"] != "bad_request" {
			t.Errorf("PATCH %v = %d %v，期望 400", body, st, out)
		}
	}
	// 管理对象不存在是普通的 404 not_found，不是 workspace_not_found（前端收到后者会切回默认空间）
	for _, id := range []string{"nope", "ZZZ", "default2"} {
		if st, out := c.do("PATCH", "/api/workspaces/"+id, map[string]any{"name": "x"}); st != 404 || out["code"] != "not_found" {
			t.Errorf("PATCH %s = %d %v", id, st, out)
		}
	}
}

func TestDeleteWorkspace(t *testing.T) {
	var srv *Server
	c := newServer(t, func(s *Server) { srv = s; s.Workspaces.Start(t.Context()) })
	c.setup()
	if st, out := c.do("DELETE", "/api/workspaces/default", nil); st != 403 || out["code"] != "forbidden" {
		t.Fatalf("删除默认工作空间 = %d %v", st, out)
	}
	if st, out := c.do("DELETE", "/api/workspaces/nope", nil); st != 404 || out["code"] != "not_found" {
		t.Fatalf("删除不存在的 = %d %v", st, out)
	}
	keep, pk := c.newWorkspace("保留")
	id, p := c.newWorkspace("待删")
	c.mustDo("POST", p+"/notes", map[string]any{"path": "a.md", "content": "# a\n"}, 201)
	c.mustDo("POST", pk+"/notes", map[string]any{"path": "k.md", "content": "# k\n"}, 201)
	tokBody := func(name, ws string) map[string]any {
		return c.mustDo("POST", "/api/tokens", map[string]any{"name": name, "scope": "read", "workspace": ws}, 201)
	}
	tokBody("绑待删 1", id)
	tokBody("绑待删 2", id)
	tokBody("绑保留", keep)
	tokBody("绑默认", "")
	if !srv.Workspaces.IsOpen(id) {
		t.Fatal("访问后应已打开")
	}

	out := c.mustDo("DELETE", "/api/workspaces/"+id, nil, 200)
	if tr, _ := out["trash"].(string); !strings.HasPrefix(tr, "trash-workspaces/"+id+"-") || out["revoked_tokens"] != 2.0 {
		t.Fatalf("删除结果 = %v", out)
	}
	if srv.Workspaces.IsOpen(id) {
		t.Fatal("删除后应已关闭")
	}
	if got := c.workspaceNames(); got != "笔记,保留" {
		t.Fatalf("删除后的列表 = %s", got)
	}
	if st, out := c.do("GET", p+"/tree", nil); st != 404 || out["code"] != "workspace_not_found" {
		t.Fatalf("访问已删除的空间 = %d %v", st, out)
	}
	c.mustDo("GET", pk+"/tree", nil, 200) // 其他空间不受影响
	toks := c.mustDo("GET", "/api/tokens", nil, 200)["tokens"].([]any)
	var names []string
	for _, tk := range toks {
		names = append(names, tk.(map[string]any)["name"].(string))
	}
	if len(names) != 2 || strings.Contains(strings.Join(names, ","), "待删") {
		t.Fatalf("剩余 token = %v", names)
	}
	if st, _ := c.do("DELETE", "/api/workspaces/"+id, nil); st != 404 {
		t.Fatalf("重复删除 = %d", st)
	}
}

func TestTokenWorkspaceAndAuditFilter(t *testing.T) {
	c := newServer(t)
	c.setup()
	id, _ := c.newWorkspace("工作")

	// 默认空间；省略 workspace 等于 default
	def := c.mustDo("POST", "/api/tokens", map[string]any{"name": "默认", "scope": "write"}, 201)
	if def["token"].(map[string]any)["workspace"] != "default" {
		t.Fatalf("省略 workspace 应绑定默认空间：%v", def)
	}
	work := c.mustDo("POST", "/api/tokens", map[string]any{"name": "工作", "scope": "write", "workspace": id}, 201)
	if work["token"].(map[string]any)["workspace"] != id {
		t.Fatalf("绑定 = %v", work)
	}
	if st, out := c.do("POST", "/api/tokens", map[string]any{"name": "x", "scope": "read", "workspace": "nope"}); st != 400 || out["code"] != "bad_request" {
		t.Fatalf("绑定不存在的空间 = %d %v", st, out)
	}
	list := c.mustDo("GET", "/api/tokens", nil, 200)["tokens"].([]any)
	if len(list) != 2 {
		t.Fatalf("token 列表 = %v", list)
	}
	for _, tk := range list {
		m := tk.(map[string]any)
		want := "default"
		if m["name"] == "工作" {
			want = id
		}
		if m["workspace"] != want {
			t.Fatalf("token %v 的空间应为 %s", m, want)
		}
	}

	call := func(secret, tool string) {
		t.Helper()
		req, _ := http.NewRequest("POST", c.base+"/mcp", strings.NewReader(
			`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+tool+`","arguments":{}}}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Authorization", "Bearer "+secret)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("/mcp = %d", res.StatusCode)
		}
	}
	call(def["secret"].(string), "list_notes")
	call(work["secret"].(string), "list_notes")
	call(work["secret"].(string), "list_tags")

	entries := func(q string) []any {
		return c.mustDo("GET", "/api/audit"+q, nil, 200)["entries"].([]any)
	}
	if n := len(entries("")); n != 3 {
		t.Fatalf("全部审计 = %d", n)
	}
	inWork := entries("?workspace=" + id)
	if len(inWork) != 2 || inWork[0].(map[string]any)["workspace"] != id || inWork[0].(map[string]any)["tool"] != "list_tags" {
		t.Fatalf("按空间筛选 = %v", inWork)
	}
	inDef := entries("?workspace=default&limit=10")
	if len(inDef) != 1 || inDef[0].(map[string]any)["workspace"] != "default" || inDef[0].(map[string]any)["token_name"] != "默认" {
		t.Fatalf("按默认空间筛选 = %v", inDef)
	}
	if n := len(entries("?workspace=nope")); n != 0 {
		t.Fatalf("筛选不存在的空间 = %d", n)
	}
}

// #60：POST /api/workspaces 接受 vault_dir（也接受 vaultDir），接入已有目录；错误码区分原因；
// 只有外部空间返回 vault_dir；删除只删索引，外部文件不动。
func TestExternalWorkspaceAPI(t *testing.T) {
	var srv *Server
	c := newServer(t, func(s *Server) { srv = s; s.Workspaces.Start(t.Context()) })
	c.setup()
	ext := t.TempDir()
	if err := os.WriteFile(filepath.Join(ext, "已有.md"), []byte("# 已有\n\n正文\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(ext, "已有.md"))

	// 错误码区分原因
	for _, tc := range []struct {
		body map[string]any
		code string
	}{
		{map[string]any{"name": "x", "vault_dir": "相对/路径"}, "vault_dir_not_absolute"},
		{map[string]any{"name": "x", "vaultDir": filepath.Join(ext, "不存在")}, "vault_dir_not_found"},
		{map[string]any{"name": "x", "vault_dir": filepath.Join(ext, "已有.md")}, "vault_dir_not_directory"},
		{map[string]any{"name": "x", "vault_dir": filepath.VolumeName(ext) + string(filepath.Separator)}, "vault_dir_root"},
		{map[string]any{"name": "x", "vault_dir": srv.Workspaces.DataDir()}, "vault_dir_data_dir"},
		{map[string]any{"name": "x", "vault_dir": filepath.Join(srv.Workspaces.DataDir(), "vault")}, "vault_dir_inside_data_dir"},
		{map[string]any{"name": "x", "vault_dir": ext, "vaultDir": ext + "2"}, "bad_request"},
	} {
		st, out := c.do("POST", "/api/workspaces", tc.body)
		if st != 400 || out["code"] != tc.code || out["message"] == "" {
			t.Errorf("POST %v = %d %v，期望 400 %s", tc.body, st, out, tc.code)
		}
	}
	if got := c.workspaceNames(); got != "笔记" {
		t.Fatalf("被拒绝后不应登记：%s", got)
	}

	// vaultDir 写法
	out := c.mustDo("POST", "/api/workspaces", map[string]any{"name": "外部", "vaultDir": ext}, 201)
	id, _ := out["id"].(string)
	resolved, _ := filepath.EvalSymlinks(ext)
	if out["external"] != true || out["vault_dir"] != resolved || id == "" {
		t.Fatalf("新建 = %v", out)
	}
	if st, out := c.do("POST", "/api/workspaces", map[string]any{"name": "再来", "vault_dir": ext}); st != 400 || out["code"] != "vault_dir_same_vault" {
		t.Fatalf("同一目录再接入 = %d %v", st, out)
	}
	if st, out := c.do("POST", "/api/workspaces", map[string]any{"name": "里面", "vault_dir": filepath.Join(ext, "子")}); st != 400 {
		t.Fatalf("不存在的子目录 = %d %v", st, out)
	}

	list := c.mustDo("GET", "/api/workspaces", nil, 200)["workspaces"].([]any)
	if _, ok := list[0].(map[string]any)["vault_dir"]; ok {
		t.Fatalf("默认空间不应返回 vault_dir：%v", list[0])
	}
	if got := list[1].(map[string]any); got["vault_dir"] != resolved || got["external"] != true {
		t.Fatalf("列表 = %v", got)
	}

	// 对账出已有的笔记，在 Lode 里读写
	p := "/api/w/" + id
	var nt map[string]any
	for i := 0; i < 100; i++ { // 第一次访问时打开，对账在后台完成
		var st int
		if st, nt = c.do("GET", p+"/notes/by-path?path="+url.QueryEscape("已有.md"), nil); st == 200 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if s, _ := nt["content"].(string); !strings.Contains(s, "正文") {
		t.Fatalf("笔记 = %v", nt)
	}
	c.mustDo("POST", p+"/notes", map[string]any{"path": "新建.md", "content": "# 新建\n"}, 201)
	if _, err := os.Stat(filepath.Join(ext, "新建.md")); err != nil {
		t.Fatalf("在 Lode 里新建的笔记应写进外部目录：%v", err)
	}

	// 删除：外部文件不动（新建的也还在）
	res := c.mustDo("DELETE", "/api/workspaces/"+id, nil, 200)
	if tr, _ := res["trash"].(string); !strings.HasPrefix(tr, "trash-workspaces/"+id+"-") {
		t.Fatalf("删除结果 = %v", res)
	}
	if b, err := os.ReadFile(filepath.Join(ext, "已有.md")); err != nil || !bytes.Equal(b, before) {
		t.Fatalf("外部笔记应原样保留：%q %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(ext, "新建.md")); err != nil {
		t.Fatalf("外部目录里的其他文件应保留：%v", err)
	}
	if _, err := os.Stat(filepath.Join(srv.Workspaces.DataDir(), "workspaces", id)); !os.IsNotExist(err) {
		t.Fatalf("data/workspaces/<id> 应已移走：%v", err)
	}
}

// 外部目录不见了：访问返回 503 workspace_vault_unavailable，不重新创建目录，仍可删除。
func TestExternalWorkspaceVaultMissingAPI(t *testing.T) {
	c := newServer(t, func(s *Server) { s.Workspaces.Start(t.Context()) })
	c.setup()
	ext := filepath.Join(t.TempDir(), "库")
	if err := os.Mkdir(ext, 0o755); err != nil {
		t.Fatal(err)
	}
	id := c.mustDo("POST", "/api/workspaces", map[string]any{"name": "外部", "vault_dir": ext}, 201)["id"].(string)
	if err := os.RemoveAll(ext); err != nil {
		t.Fatal(err)
	}
	if st, out := c.do("GET", "/api/w/"+id+"/tree", nil); st != 503 || out["code"] != "workspace_vault_unavailable" {
		t.Fatalf("访问 = %d %v", st, out)
	}
	if _, err := os.Stat(ext); !os.IsNotExist(err) {
		t.Fatalf("不应重新创建外部目录：%v", err)
	}
	c.mustDo("DELETE", "/api/workspaces/"+id, nil, 200)
}
