package merge

import "testing"

func TestMergeNonOverlappingChanges(t *testing.T) {
	base := "第一段\n\n第二段\n\n第三段\n"
	ours := "第一段（A 改）\n\n第二段\n\n第三段\n"
	theirs := "第一段\n\n第二段\n\n第三段（B 改）\n"
	got, ok := Merge3(base, ours, theirs)
	want := "第一段（A 改）\n\n第二段\n\n第三段（B 改）\n"
	if !ok || got != want {
		t.Fatalf("Merge3 = %q, %v；期望 %q, true", got, ok, want)
	}
}

func TestMergeOverlappingChangesConflict(t *testing.T) {
	base := "a\nb\nc\n"
	if _, ok := Merge3(base, "a\nB1\nc\n", "a\nB2\nc\n"); ok {
		t.Fatal("两边改同一行应判为冲突")
	}
	// 相邻行的修改也按冲突处理（与 git 一致），避免拼出意外的组合
	if _, ok := Merge3(base, "A\nb\nc\n", "a\nB\nc\n"); ok {
		t.Fatal("相邻行的修改应判为冲突")
	}
}

func TestMergeIdenticalChangesOnBothSides(t *testing.T) {
	got, ok := Merge3("a\nb\n", "a\nx\n", "a\nx\n")
	if !ok || got != "a\nx\n" {
		t.Fatalf("两边改成一样应直接合并，得到 %q %v", got, ok)
	}
}

func TestMergeOneSideUnchanged(t *testing.T) {
	cases := []struct{ base, ours, theirs, want string }{
		{"a\nb\n", "a\nb\n", "a\nb\nc\n", "a\nb\nc\n"},
		{"a\nb\n", "", "a\nb\n", ""},
		{"", "新内容", "", "新内容"},
		{"a", "a", "b", "b"}, // 没有结尾换行
	}
	for _, c := range cases {
		got, ok := Merge3(c.base, c.ours, c.theirs)
		if !ok || got != c.want {
			t.Errorf("Merge3(%q,%q,%q) = %q %v，期望 %q", c.base, c.ours, c.theirs, got, ok, c.want)
		}
	}
}

func TestMergeInsertionsAndDeletionsFarApart(t *testing.T) {
	base := "1\n2\n3\n4\n5\n6\n7\n"
	ours := "0\n1\n2\n3\n4\n5\n6\n7\n" // 开头插入
	theirs := "1\n2\n3\n4\n5\n7\n"     // 删除第 6 行
	got, ok := Merge3(base, ours, theirs)
	if want := "0\n1\n2\n3\n4\n5\n7\n"; !ok || got != want {
		t.Fatalf("得到 %q %v，期望 %q", got, ok, want)
	}
}

func TestMergeKeepsCRLF(t *testing.T) {
	base := "a\r\nb\r\nc\r\nd\r\n"
	got, ok := Merge3(base, "A\r\nb\r\nc\r\nd\r\n", "a\r\nb\r\nc\r\nD\r\n")
	if want := "A\r\nb\r\nc\r\nD\r\n"; !ok || got != want {
		t.Fatalf("得到 %q %v，期望 %q", got, ok, want)
	}
}

func TestMergeLargeMiddleFallsBackSafely(t *testing.T) {
	// 中间差异超过 LCS 表上限时整体当作一个改动：不重叠的另一侧修改仍能合并，重叠时报冲突，绝不丢内容。
	var base, ours []byte
	for i := 0; i < 3000; i++ {
		base = append(base, []byte("line\n")...)
		if i%2 == 0 {
			ours = append(ours, []byte("changed\n")...)
		} else {
			ours = append(ours, []byte("line\n")...)
		}
	}
	theirs := string(base) + "tail\n"
	got, ok := Merge3(string(base), string(ours), theirs)
	if !ok || got != string(ours)+"tail\n" {
		t.Fatalf("大文件不重叠修改应合并，ok=%v", ok)
	}
}
