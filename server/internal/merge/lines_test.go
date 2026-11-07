package merge

import (
	"encoding/json"
	"testing"
)

func TestLines(t *testing.T) {
	a := "# 标题\n一\n二\n三\n四\n五\n六\n七\n"
	b := "# 标题\n一\n二\n三改\n四\n五\n六\n七\n八\n"
	got, _ := json.Marshal(Lines(a, b, 1))
	want := `[{"op":"…","text":"2"},{"op":" ","text":"二"},{"op":"-","text":"三"},{"op":"+","text":"三改"},{"op":" ","text":"四"},{"op":"…","text":"2"},{"op":" ","text":"七"},{"op":"+","text":"八"}]`
	if string(got) != want {
		t.Errorf("得到 %s\n期望 %s", got, want)
	}
	created, _ := json.Marshal(Lines("", "新\n内容", 3))
	if string(created) != `[{"op":"+","text":"新"},{"op":"+","text":"内容"}]` {
		t.Errorf("新建：%s", created)
	}
	if len(Lines("同\n", "同\n", 3)) != 0 {
		t.Error("没有改动时应为空")
	}
}
