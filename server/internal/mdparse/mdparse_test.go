package mdparse

import (
	"reflect"
	"testing"
)

func TestParseLinks(t *testing.T) {
	src := "开头 [[笔记 A]] 和 [[文件夹/笔记 B|别名]]\n" +
		"![[attachments/图.png]] 与 [[C.md#小节]] [[D#小节|显示]]\n" +
		"`[[不是链接]]` 行内代码\n" +
		"```\n[[代码块里的]]\n```\n" +
		"表格 [[E\\|别名]] 结尾 [[ ]] [[未闭合\n"
	got := ParseLinks(src)
	type lk struct {
		Target, Heading, Alias string
		Embed                  bool
		Line                   int
	}
	var simple []lk
	for _, l := range got {
		simple = append(simple, lk{l.Target, l.Heading, l.Alias, l.Embed, l.Line})
		if src[l.TargetStart:l.TargetEnd] != l.Target {
			t.Errorf("target 偏移不对: %q vs %q", src[l.TargetStart:l.TargetEnd], l.Target)
		}
	}
	want := []lk{
		{"笔记 A", "", "", false, 1},
		{"文件夹/笔记 B", "", "别名", false, 1},
		{"attachments/图.png", "", "", true, 2},
		{"C.md", "小节", "", false, 2},
		{"D", "小节", "显示", false, 2},
		{"E", "", "别名", false, 7},
	}
	if !reflect.DeepEqual(simple, want) {
		t.Fatalf("got  %+v\nwant %+v", simple, want)
	}
}

func TestNormalizeTarget(t *testing.T) {
	cases := map[string]string{
		"Note":           "note",
		"Folder/Note.md": "folder/note",
		"./Note":         "note",
		"/Folder/Note":   "folder/note",
		"  空格 ":          "空格",
		"图.PNG":          "图.png",
	}
	for in, want := range cases {
		if got := NormalizeTarget(in); got != want {
			t.Errorf("NormalizeTarget(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseTags(t *testing.T) {
	src := "---\ntags: [项目, Work]\naliases: x\n---\n" +
		"# 标题不是标签\n" +
		"正文 #中文标签 和 #嵌套/子标签，#123 不是标签\n" +
		"网址 http://a.com/#anchor 不算，`#代码` 不算\n" +
		"```\n#代码块\n```\n" +
		"#Work 重复只算一次 (#括号)\n"
	got := ParseTags(src)
	want := []string{"work", "中文标签", "嵌套/子标签", "括号", "项目"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseTagsFrontmatterList(t *testing.T) {
	src := "---\ntitle: x\ntags:\n  - alpha\n  - \"#beta\"\n---\n正文"
	got := ParseTags(src)
	want := []string{"alpha", "beta"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// 笔记外观写在 front matter 的 lode 键下（#47），不能被当成标签，也不能影响紧挨着的 tags 列表和正文链接。
func TestFrontmatterAppearanceKeyIgnored(t *testing.T) {
	src := "---\ntags:\n  - alpha\nlode:\n  width: wide\n  font: serif\n---\n正文 #beta [[目标]]"
	if got, want := ParseTags(src), []string{"alpha", "beta"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("tags: got %v, want %v", got, want)
	}
	links := ParseLinks(src)
	if len(links) != 1 || links[0].Target != "目标" {
		t.Fatalf("links: got %+v", links)
	}
	only := "---\nlode:\n  font: mono\n---\n#gamma"
	if got, want := ParseTags(only), []string{"gamma"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("tags: got %v, want %v", got, want)
	}
}
