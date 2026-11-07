package agent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/rt-game-440/lode/server/internal/llm"
	"github.com/rt-game-440/lode/server/internal/merge"
	"github.com/rt-game-440/lode/server/internal/notes"
)

// 预览 diff 最多这么多行，超出部分折叠。
const maxPreviewLines = 400

// preview 计算写操作的预览：不写入，只算出执行后笔记会变成什么样。
func (s *Service) preview(ctx context.Context, c llm.ToolCall) Preview {
	var a struct {
		Path    string  `json:"path"`
		From    string  `json:"from"`
		To      string  `json:"to"`
		Content *string `json:"content"`
		Mode    string  `json:"mode"`
		Edits   []struct {
			Old string `json:"old"`
			New string `json:"new"`
		} `json:"edits"`
	}
	if err := json.Unmarshal(c.Args, &a); err != nil {
		return Preview{Action: c.Name, Error: "参数不是合法的 JSON"}
	}
	clean := func(p string) string { return strings.TrimLeft(strings.TrimSpace(p), "/") }
	content := ""
	if a.Content != nil {
		content = *a.Content
	}
	switch c.Name {
	case "create_note":
		return Preview{Action: "create", Path: clean(a.Path), Diff: limit(merge.Lines("", content, 3))}
	case "move_note":
		return Preview{Action: "move", Path: clean(a.From), To: clean(a.To)}
	case "delete_note":
		p := Preview{Action: "delete", Path: clean(a.Path)}
		if n, err := s.Notes.ReadByPath(ctx, p.Path); err == nil {
			p.Diff = limit(merge.Lines(n.Content, "", 0))
		} else {
			p.Error = "找不到这篇笔记"
		}
		return p
	case "update_note":
		p := Preview{Action: "update", Path: clean(a.Path)}
		n, err := s.Notes.ReadByPath(ctx, p.Path)
		if err != nil {
			p.Error = "找不到这篇笔记"
			return p
		}
		next := n.Content
		switch a.Mode {
		case "replace":
			next = content
		case "append":
			next = appendPreview(n.Content, content)
		default:
			edits := make([]notes.Edit, len(a.Edits))
			for i, e := range a.Edits {
				edits[i] = notes.Edit{Old: e.Old, New: e.New}
			}
			out, err := notes.ApplyEdits(n.Content, edits)
			if err != nil {
				p.Error = "要替换的原文没有唯一匹配，批准后会执行失败"
				return p
			}
			next = out
		}
		p.Diff = limit(merge.Lines(n.Content, next, 3))
		return p
	}
	return Preview{Action: c.Name}
}

// appendPreview 与 notes.Service.Append 的换行规则一致。
func appendPreview(cur, text string) string {
	nl := "\n"
	if strings.Contains(cur, "\r\n") {
		nl = "\r\n"
	}
	if cur != "" && !strings.HasSuffix(cur, "\n") {
		cur += nl
	}
	if !strings.HasSuffix(text, "\n") {
		text += nl
	}
	return cur + text
}

func limit(d []merge.DiffLine) []merge.DiffLine {
	if len(d) <= maxPreviewLines {
		return d
	}
	rest := len(d) - maxPreviewLines
	return append(d[:maxPreviewLines:maxPreviewLines], merge.DiffLine{Op: "…", Text: itoa(rest)})
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
