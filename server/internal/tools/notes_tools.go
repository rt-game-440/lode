package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/rt-game-440/lode/server/internal/notes"
)

// 默认值与上限。
const (
	defaultSearchLimit = 20
	maxSearchLimit     = 100
	defaultMaxLines    = 2000
)

// noteInfo 是返回给模型的笔记摘要。
type noteInfo struct {
	Path     string `json:"path"`
	Title    string `json:"title"`
	Rev      int64  `json:"rev"`
	Modified string `json:"modified"` // RFC 3339
}

func info(n notes.Note) noteInfo {
	return noteInfo{Path: n.Path, Title: n.Title, Rev: n.Rev, Modified: formatTime(n.Mtime)}
}

func infos(ns []notes.Note) []noteInfo {
	out := make([]noteInfo, 0, len(ns))
	for _, n := range ns {
		out = append(out, info(n))
	}
	return out
}

func formatTime(ms int64) string { return time.UnixMilli(ms).Format(time.RFC3339) }

// cleanArg 去掉首尾空白和开头的 /：模型常把笔记库根目录写成 /。
func cleanArg(p string) string { return strings.TrimLeft(strings.TrimSpace(p), "/") }

// 参数类型。jsonschema 标签是给模型看的参数说明。

type searchIn struct {
	Query      string `json:"query" jsonschema:"搜索词。多个词用空格分隔，结果须同时包含所有词；不区分大小写，支持中文"`
	Limit      int    `json:"limit,omitempty" jsonschema:"最多返回多少条，默认 20，最大 100"`
	PathPrefix string `json:"path_prefix,omitempty" jsonschema:"只搜索这个文件夹（含下级）里的笔记，例如 “项目/2026”；留空搜索全部"`
}

func (in searchIn) target() string { return in.Query }

type pathIn struct {
	Path string `json:"path" jsonschema:"笔记路径，相对笔记库根目录，以 .md 结尾，例如 “日记/2026-11-07.md”"`
}

func (in pathIn) target() string { return cleanArg(in.Path) }

type readIn struct {
	Path      string `json:"path" jsonschema:"笔记路径，相对笔记库根目录，以 .md 结尾，例如 “日记/2026-11-07.md”"`
	StartLine int    `json:"start_line,omitempty" jsonschema:"从第几行开始读，从 1 开始，默认 1"`
	MaxLines  int    `json:"max_lines,omitempty" jsonschema:"最多读多少行，默认 2000"`
}

func (in readIn) target() string { return cleanArg(in.Path) }

type listIn struct {
	PathPrefix string `json:"path_prefix,omitempty" jsonschema:"要列出的文件夹，例如 “项目”；留空为笔记库根目录"`
	Recursive  bool   `json:"recursive,omitempty" jsonschema:"为 true 时包含所有下级文件夹的内容；默认 false，只列直接子项"`
}

func (in listIn) target() string { return cleanArg(in.PathPrefix) }

type createIn struct {
	Path    string `json:"path" jsonschema:"新笔记的路径，相对笔记库根目录，以 .md 结尾；上级文件夹不存在时自动创建"`
	Content string `json:"content" jsonschema:"笔记的 Markdown 正文，可以为空字符串"`
}

func (in createIn) target() string { return cleanArg(in.Path) }

type editIn struct {
	Old string `json:"old" jsonschema:"要替换的原文片段，必须与原文逐字一致且在全文中只出现一次"`
	New string `json:"new" jsonschema:"替换后的内容；为空字符串表示删除这段"`
}

type updateIn struct {
	Path    string   `json:"path" jsonschema:"要修改的笔记路径"`
	BaseRev int64    `json:"base_rev" jsonschema:"你据以修改的版本号，即 read_note 返回的 rev"`
	Mode    string   `json:"mode" jsonschema:"修改方式：replace 用 content 替换全文；append 把 content 追加到末尾；patch 按 edits 逐处替换"`
	Content *string  `json:"content,omitempty" jsonschema:"replace 时为新的全文，append 时为要追加的内容；patch 时不填"`
	Edits   []editIn `json:"edits,omitempty" jsonschema:"patch 时的替换列表，按顺序依次应用；其他模式不填"`
}

func (in updateIn) target() string { return cleanArg(in.Path) }

type moveIn struct {
	From string `json:"from" jsonschema:"笔记当前路径"`
	To   string `json:"to" jsonschema:"新路径，以 .md 结尾；只改文件名时保持文件夹不变即可"`
}

func (in moveIn) target() string { return cleanArg(in.From) + " → " + cleanArg(in.To) }

type noIn struct{}

func (noIn) target() string { return "" }

type tagIn struct {
	Tag string `json:"tag" jsonschema:"标签名，可带或不带 #，例如 “工作” 或 “#工作/会议”；会同时匹配它的子标签"`
}

func (in tagIn) target() string { return "#" + strings.TrimPrefix(strings.TrimSpace(in.Tag), "#") }

// 返回值类型。

type searchHit struct {
	Path     string `json:"path"`
	Title    string `json:"title"`
	Snippet  string `json:"snippet"` // 命中部分用 ** 包裹
	Modified string `json:"modified"`
}

type readOut struct {
	Path       string `json:"path"`
	Title      string `json:"title"`
	Rev        int64  `json:"rev"`
	TotalLines int    `json:"total_lines"`
	StartLine  int    `json:"start_line"`
	EndLine    int    `json:"end_line"`
	Truncated  bool   `json:"truncated"`
	Content    string `json:"content"`
}

type writeOut struct {
	Path   string `json:"path"`
	Title  string `json:"title"`
	Rev    int64  `json:"rev"`
	Merged bool   `json:"merged,omitempty"`
	Note   string `json:"note,omitempty"`
}

// setDefault 给参数补充默认值与取值范围（只影响给模型看的 schema 和校验，默认值由处理函数应用）。
func setDefault(p *jsonschema.Schema, def any, min, max float64) {
	if b, err := json.Marshal(def); err == nil {
		p.Default = b
	}
	p.Minimum = &min
	if max > 0 {
		p.Maximum = &max
	}
}

func noteTools(svc *notes.Service) []*Tool {
	return []*Tool{
		define("search_notes", true, `
全文搜索笔记，按相关度返回 path、title、snippet（命中部分用 ** 包裹）和 modified（最后修改时间）。
想找某个主题、关键词或人名的笔记时先用它；拿到 path 后用 read_note 读全文。
没有结果时返回空列表，可以换个说法或减少关键词再试。`,
			func(p map[string]*jsonschema.Schema) {
				p["query"].MinLength = ptr(1)
				setDefault(p["limit"], defaultSearchLimit, 1, maxSearchLimit)
			},
			func(ctx context.Context, in searchIn) (any, error) {
				if in.Limit == 0 {
					in.Limit = defaultSearchLimit
				}
				rs, err := svc.Search(ctx, notes.SearchQuery{Query: in.Query, Limit: in.Limit, PathPrefix: cleanArg(in.PathPrefix)})
				if err != nil {
					return nil, err
				}
				hits := make([]searchHit, 0, len(rs))
				for _, r := range rs {
					snippet := strings.NewReplacer("\x02", "**", "\x03", "**").Replace(r.Snippet)
					hits = append(hits, searchHit{Path: r.Path, Title: r.Title, Snippet: snippet, Modified: formatTime(r.Mtime)})
				}
				return map[string]any{"results": hits}, nil
			}),

		define("read_note", true, `
读取一篇笔记的 Markdown 正文，返回 content、rev（当前版本号，修改时作为 base_rev 传给 update_note）、
total_lines（总行数）以及本次读取的 start_line、end_line。
长笔记每次最多读 max_lines 行（默认 2000），truncated 为 true 时用 start_line = end_line + 1 继续读。
笔记不存在时报错，可以先用 search_notes 或 list_notes 查路径。`,
			func(p map[string]*jsonschema.Schema) {
				setDefault(p["start_line"], 1, 1, 0)
				setDefault(p["max_lines"], defaultMaxLines, 1, 0)
			},
			func(ctx context.Context, in readIn) (any, error) {
				n, err := svc.ReadByPath(ctx, cleanArg(in.Path))
				if err != nil {
					return nil, err
				}
				return pageLines(n, in.StartLine, in.MaxLines)
			}),

		define("list_notes", true, `
列出一个文件夹里的子文件夹（folders）和笔记（notes，含 path、title、rev、modified）。
path_prefix 留空列出根目录；recursive 为 true 时包含所有下级内容。用来浏览笔记库结构、确认路径。
文件夹不存在时报错。`, nil,
			func(ctx context.Context, in listIn) (any, error) {
				l, err := svc.ListFolder(ctx, cleanArg(in.PathPrefix), in.Recursive)
				if err != nil {
					return nil, err
				}
				return map[string]any{"folders": l.Folders, "notes": infos(l.Notes)}, nil
			}),

		define("create_note", false, `
新建一篇笔记，返回 path、title 和 rev。路径已存在时报错（不会覆盖），此时请换路径，或先 read_note 再用 update_note 修改。
正文第一个一级标题（# 标题）会作为笔记标题；可以用 [[笔记名]] 链接其他笔记、用 #标签 打标签。`, nil,
			func(ctx context.Context, in createIn) (any, error) {
				n, err := svc.Create(ctx, cleanArg(in.Path), in.Content)
				if err != nil {
					return nil, err
				}
				return writeOut{Path: n.Path, Title: n.Title, Rev: n.Rev}, nil
			}),

		define("update_note", false, `
修改一篇已有笔记，返回新的 path、rev。base_rev 填你读取时拿到的 rev（先用 read_note 读取）。三种 mode：
- replace：content 为新的全文，整篇替换；
- append：把 content 追加到末尾（自动补换行），总是追加到最新版本，不会冲突；
- patch：edits 是 [{old, new}] 列表，依次把唯一出现的 old 换成 new。只改局部时优先用 patch，省流量也不易误改。
base_rev 过期（笔记在别处被改过）时，服务器会尝试三方合并：改动不重叠就自动合并并返回 merged=true；
重叠时不修改笔记，把你的版本另存为冲突副本并报错，此时请重新 read_note 后再改。
patch 的 old 匹配不到或匹配到多处时报错，请带上更多上下文。`,
			func(p map[string]*jsonschema.Schema) {
				p["base_rev"].Minimum = ptr(1.0)
				p["mode"].Enum = []any{"replace", "append", "patch"}
				p["edits"].MinItems = ptr(1)
				// 指针和切片默认推断为可为 null，部分客户端不认类型数组；这两个参数本就可以不传
				p["content"].Types, p["content"].Type = nil, "string"
				p["edits"].Types, p["edits"].Type = nil, "array"
			},
			func(ctx context.Context, in updateIn) (any, error) {
				n, err := svc.GetByPath(ctx, cleanArg(in.Path))
				if err != nil {
					return nil, err
				}
				var res notes.NoteContent
				switch in.Mode {
				case "replace", "append":
					if in.Content == nil || len(in.Edits) > 0 {
						return nil, fmt.Errorf("%w: %s 模式需要 content，且不要传 edits", notes.ErrInvalid, in.Mode)
					}
					if in.Mode == "replace" {
						res, err = svc.Update(ctx, n.ID, in.BaseRev, *in.Content)
					} else {
						res, err = svc.Append(ctx, n.ID, *in.Content)
					}
				default: // patch
					if len(in.Edits) == 0 || in.Content != nil {
						return nil, fmt.Errorf("%w: patch 模式需要 edits，且不要传 content", notes.ErrInvalid)
					}
					edits := make([]notes.Edit, len(in.Edits))
					for i, e := range in.Edits {
						edits[i] = notes.Edit{Old: e.Old, New: e.New}
					}
					res, err = svc.Patch(ctx, n.ID, in.BaseRev, edits)
				}
				if err != nil {
					return nil, err
				}
				out := writeOut{Path: res.Path, Title: res.Title, Rev: res.Rev, Merged: res.Merged}
				if res.Merged {
					out.Note = "笔记在别处被改过，已与你的修改自动合并。继续修改前请先 read_note 读取合并后的全文。"
				}
				return out, nil
			}),

		define("move_note", false, `
移动或重命名笔记（保留笔记身份和历史），并自动更新其他笔记里指向它的 [[链接]]。
返回新的 path 以及因更新链接而被改写的笔记列表 updated_links。目标路径已存在时报错。`, nil,
			func(ctx context.Context, in moveIn) (any, error) {
				n, err := svc.GetByPath(ctx, cleanArg(in.From))
				if err != nil {
					return nil, err
				}
				res, err := svc.Move(ctx, n.ID, cleanArg(in.To))
				if err != nil {
					return nil, err
				}
				updated := make([]string, 0, len(res.Updated))
				for _, u := range res.Updated {
					updated = append(updated, u.Path)
				}
				return map[string]any{"path": res.Note.Path, "rev": res.Note.Rev, "updated_links": updated}, nil
			}),

		define("delete_note", false, `
删除笔记：移入回收站（不是永久删除，用户可以在界面的回收站里恢复）。返回被删除笔记的 path。
删除前请确认用户确实要删除。`, nil,
			func(ctx context.Context, in pathIn) (any, error) {
				n, err := svc.GetByPath(ctx, cleanArg(in.Path))
				if err != nil {
					return nil, err
				}
				item, err := svc.Delete(ctx, n.ID)
				if err != nil {
					return nil, err
				}
				return map[string]any{"path": item.Path, "trashed": true}, nil
			}),

		define("get_backlinks", true, `
列出链接到这篇笔记的其他笔记（反向链接），每条含 path、title 以及引用所在行的行号和内容。
用来了解一个主题被哪些笔记提到。没有反向链接时返回空列表。`, nil,
			func(ctx context.Context, in pathIn) (any, error) {
				n, err := svc.GetByPath(ctx, cleanArg(in.Path))
				if err != nil {
					return nil, err
				}
				bl, err := svc.Backlinks(ctx, n.ID)
				if err != nil {
					return nil, err
				}
				type line struct {
					Line int    `json:"line"`
					Text string `json:"text"`
				}
				type link struct {
					Path  string `json:"path"`
					Title string `json:"title"`
					Lines []line `json:"lines"`
				}
				out := make([]link, 0, len(bl))
				for _, b := range bl {
					l := link{Path: b.Path, Title: b.Title, Lines: []line{}}
					for _, x := range b.Lines {
						l.Lines = append(l.Lines, line{Line: x.Line, Text: x.Text})
					}
					out = append(out, l)
				}
				return map[string]any{"backlinks": out}, nil
			}),

		define("list_tags", true, `
列出笔记库里的全部标签及每个标签的笔记数。标签不带 #，层级标签用 / 分隔（如 工作/会议）。`, nil,
			func(ctx context.Context, _ noIn) (any, error) {
				tags, err := svc.Tags(ctx)
				if err != nil {
					return nil, err
				}
				return map[string]any{"tags": tags}, nil
			}),

		define("get_notes_by_tag", true, `
列出带某个标签的笔记（含其子标签，例如查“工作”也会返回带“工作/会议”的笔记），每条含 path、title、rev、modified。`,
			func(p map[string]*jsonschema.Schema) { p["tag"].MinLength = ptr(1) },
			func(ctx context.Context, in tagIn) (any, error) {
				ns, err := svc.NotesByTag(ctx, in.Tag)
				if err != nil {
					return nil, err
				}
				return map[string]any{"notes": infos(ns)}, nil
			}),
	}
}

// pageLines 截取正文的第 start 行起最多 max 行（行号从 1 开始，0 表示默认值）。
func pageLines(n notes.NoteContent, start, max int) (readOut, error) {
	if start == 0 {
		start = 1
	}
	if max == 0 {
		max = defaultMaxLines
	}
	lines := strings.SplitAfter(n.Content, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1] // 末尾换行不算新的一行
	}
	total := len(lines)
	if start > total && !(start == 1 && total == 0) {
		return readOut{}, fmt.Errorf("%w: start_line 为 %d，但笔记只有 %d 行", notes.ErrInvalid, start, total)
	}
	end := min(total, start-1+max)
	out := readOut{Path: n.Path, Title: n.Title, Rev: n.Rev, TotalLines: total, StartLine: start, EndLine: end, Truncated: end < total}
	if total > 0 {
		out.Content = strings.Join(lines[start-1:end], "")
	}
	return out, nil
}

func ptr[T any](v T) *T { return &v }
