// Package mdparse 从 Markdown 文本中提取 [[wikilink]] 与 #标签。
//
// 解析会跳过 YAML frontmatter（链接）、围栏代码块和行内代码。
package mdparse

import (
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Link 是一个 [[wikilink]] 或 ![[嵌入]]。偏移都是字节偏移。
type Link struct {
	Target      string // 原样的目标（不含 #标题 和 |别名），已去掉首尾空白
	Heading     string // # 后面的部分
	Alias       string // | 后面的部分
	Embed       bool   // 是否是 ![[...]]
	Start, End  int    // 整个 [[...]] 的范围（不含前缀 !）
	TargetStart int    // Target 在原文中的起点
	TargetEnd   int    // Target 在原文中的终点
	Line        int    // 1 起始的行号
}

// line 是一行文本及其在原文中的起始偏移。
type line struct {
	text  string
	start int
	no    int
}

// scanLines 逐行遍历正文，跳过 frontmatter 与围栏代码块。
func scanLines(src string, skipFrontmatter bool, fn func(l line)) {
	lines := splitLines(src)
	i := 0
	if skipFrontmatter {
		if end := frontmatterEnd(lines); end > 0 {
			i = end
		}
	}
	fence := ""
	for ; i < len(lines); i++ {
		l := lines[i]
		trimmed := strings.TrimLeft(l.text, " ")
		if len(l.text)-len(trimmed) <= 3 {
			if fence != "" {
				if strings.HasPrefix(trimmed, fence) && strings.TrimSpace(strings.TrimLeft(trimmed, fence[:1])) == "" {
					fence = ""
				}
				continue
			}
			if f := fenceOpen(trimmed); f != "" {
				fence = f
				continue
			}
		} else if fence != "" {
			continue
		}
		fn(l)
	}
}

func splitLines(src string) []line {
	var out []line
	start, no := 0, 1
	for start <= len(src) {
		idx := strings.IndexByte(src[start:], '\n')
		if idx < 0 {
			out = append(out, line{text: strings.TrimSuffix(src[start:], "\r"), start: start, no: no})
			break
		}
		out = append(out, line{text: strings.TrimSuffix(src[start:start+idx], "\r"), start: start, no: no})
		start += idx + 1
		no++
	}
	return out
}

// frontmatterEnd 返回 frontmatter 之后第一行的下标；没有 frontmatter 时返回 0。
func frontmatterEnd(lines []line) int {
	if len(lines) == 0 || strings.TrimRight(lines[0].text, " ") != "---" {
		return 0
	}
	for i := 1; i < len(lines); i++ {
		t := strings.TrimRight(lines[i].text, " ")
		if t == "---" || t == "..." {
			return i + 1
		}
	}
	return 0
}

func fenceOpen(s string) string {
	for _, ch := range []string{"`", "~"} {
		n := 0
		for n < len(s) && s[n] == ch[0] {
			n++
		}
		if n >= 3 {
			if ch == "`" && strings.Contains(s[n:], "`") {
				return "" // 反引号围栏的信息串里不能有反引号
			}
			return strings.Repeat(ch, n)
		}
	}
	return ""
}

// codeSpans 返回一行中行内代码的字节区间（相对行首）。
func codeSpans(s string) [][2]int {
	var spans [][2]int
	i := 0
	for i < len(s) {
		if s[i] != '`' {
			i++
			continue
		}
		n := 0
		for i+n < len(s) && s[i+n] == '`' {
			n++
		}
		open := i
		j := i + n
		closed := false
		for j < len(s) {
			if s[j] != '`' {
				j++
				continue
			}
			m := 0
			for j+m < len(s) && s[j+m] == '`' {
				m++
			}
			if m == n {
				spans = append(spans, [2]int{open, j + m})
				i = j + m
				closed = true
				break
			}
			j += m
		}
		if !closed {
			i = open + n
		}
	}
	return spans
}

func inSpans(pos int, spans [][2]int) bool {
	for _, sp := range spans {
		if pos >= sp[0] && pos < sp[1] {
			return true
		}
	}
	return false
}

// ParseLinks 提取正文中的全部 wikilink。
func ParseLinks(src string) []Link {
	var out []Link
	scanLines(src, true, func(l line) {
		s := l.text
		spans := codeSpans(s)
		i := 0
		for {
			idx := strings.Index(s[i:], "[[")
			if idx < 0 {
				return
			}
			open := i + idx
			if inSpans(open, spans) {
				i = open + 2
				continue
			}
			closeRel := strings.Index(s[open+2:], "]]")
			if closeRel < 0 {
				return
			}
			inner := s[open+2 : open+2+closeRel]
			end := open + 2 + closeRel + 2
			if strings.Contains(inner, "[[") {
				i = open + 2
				continue
			}
			if lk, ok := parseInner(inner, l.start+open+2); ok {
				lk.Start = l.start + open
				lk.End = l.start + end
				lk.Embed = open > 0 && s[open-1] == '!'
				lk.Line = l.no
				out = append(out, lk)
			}
			i = end
		}
	})
	return out
}

// parseInner 解析 [[ 与 ]] 之间的内容。base 是 inner 在原文中的偏移。
func parseInner(inner string, base int) (Link, bool) {
	targetPart, alias, hasAlias := strings.Cut(inner, "|")
	if hasAlias {
		targetPart = strings.TrimSuffix(targetPart, "\\") // 表格中的 \|
	}
	target, heading, _ := strings.Cut(targetPart, "#")
	lead := len(target) - len(strings.TrimLeft(target, " \t"))
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return Link{}, false
	}
	return Link{
		Target:      trimmed,
		Heading:     strings.TrimSpace(heading),
		Alias:       strings.TrimSpace(alias),
		TargetStart: base + lead,
		TargetEnd:   base + lead + len(trimmed),
	}, true
}

// NormalizeTarget 把链接目标规范化为索引键：小写、去掉 .md、去掉开头的 ./ 和 /。
func NormalizeTarget(t string) string {
	t = strings.TrimSpace(strings.ReplaceAll(t, "\\", "/"))
	t = strings.TrimPrefix(t, "./")
	t = strings.TrimLeft(t, "/")
	if strings.EqualFold(pathExt(t), ".md") {
		t = t[:len(t)-3]
	}
	return strings.ToLower(strings.TrimSpace(t))
}

func pathExt(p string) string {
	if i := strings.LastIndexByte(p, '.'); i >= 0 && !strings.Contains(p[i:], "/") {
		return p[i:]
	}
	return ""
}

// ParseTags 提取正文与 frontmatter 中的标签，返回去重、小写、排序后的结果（不含 #）。
func ParseTags(src string) []string {
	set := map[string]struct{}{}
	add := func(t string) {
		t = strings.ToLower(strings.Trim(strings.TrimSpace(t), `"'`))
		t = strings.TrimPrefix(t, "#")
		if validTag(t) {
			set[t] = struct{}{}
		}
	}
	for _, t := range frontmatterTags(src) {
		add(t)
	}
	scanLines(src, true, func(l line) {
		s := l.text
		spans := codeSpans(s)
		for i := 0; i < len(s); i++ {
			if s[i] != '#' || inSpans(i, spans) {
				continue
			}
			if i > 0 {
				prev, _ := utf8.DecodeLastRuneInString(s[:i])
				if !tagBoundary(prev) {
					continue
				}
			}
			j := i + 1
			for j < len(s) {
				r, size := utf8.DecodeRuneInString(s[j:])
				if !isTagRune(r) {
					break
				}
				j += size
			}
			if j > i+1 {
				add(s[i+1 : j])
			}
			i = j - 1
		}
	})
	out := make([]string, 0, len(set))
	for t := range set {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

func tagBoundary(r rune) bool {
	return unicode.IsSpace(r) || strings.ContainsRune("([{（【「，,。；;：:、“‘\"'", r)
}

func isTagRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.Is(unicode.Mn, r) || r == '_' || r == '-' || r == '/'
}

func validTag(t string) bool {
	t = strings.Trim(t, "/")
	if t == "" {
		return false
	}
	for _, r := range t {
		if !isTagRune(r) {
			return false
		}
	}
	for _, r := range t {
		if !unicode.IsDigit(r) {
			return true
		}
	}
	return false // 纯数字不是标签
}

// frontmatterTags 读取 frontmatter 中的 tags / tag 字段，支持 [a, b]、a, b 与 YAML 列表。
func frontmatterTags(src string) []string {
	lines := splitLines(src)
	end := frontmatterEnd(lines)
	if end == 0 {
		return nil
	}
	var out []string
	inList := false
	for _, l := range lines[1 : end-1] {
		s := l.text
		if inList {
			t := strings.TrimSpace(s)
			if strings.HasPrefix(t, "- ") || t == "-" {
				out = append(out, strings.TrimSpace(strings.TrimPrefix(t, "-")))
				continue
			}
			if t == "" {
				continue
			}
			inList = false
		}
		key, val, ok := strings.Cut(s, ":")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		if key != "tags" && key != "tag" {
			continue
		}
		val = strings.TrimSpace(val)
		if val == "" {
			inList = true
			continue
		}
		val = strings.TrimSuffix(strings.TrimPrefix(val, "["), "]")
		for _, part := range strings.FieldsFunc(val, func(r rune) bool { return r == ',' || r == ' ' }) {
			out = append(out, part)
		}
	}
	return out
}

// URLLink 是一个 Markdown 行内链接 [文字](目标) 或图片 ![说明](目标) 的目标部分。偏移都是字节偏移。
type URLLink struct {
	URL        string // 原样的目标（不含 <> 和标题）
	Start, End int    // URL 在原文中的范围
	Angle      bool   // 目标写在 <...> 里
	Image      bool   // 是否是 ![...](...)
	Line       int    // 1 起始的行号
}

// ParseURLLinks 提取正文中的行内链接和图片目标，跳过 frontmatter、围栏代码块和行内代码。
// 只做够用的解析：不处理跨行的链接和引用式链接 [文字][id]。
func ParseURLLinks(src string) []URLLink {
	var out []URLLink
	scanLines(src, true, func(l line) {
		s := l.text
		spans := codeSpans(s)
		i := 0
		for i < len(s) {
			idx := strings.Index(s[i:], "](")
			if idx < 0 {
				return
			}
			p := i + idx
			open := strings.LastIndexByte(s[:p], '[')
			if inSpans(p, spans) || open < 0 {
				i = p + 2
				continue
			}
			j := p + 2
			for j < len(s) && (s[j] == ' ' || s[j] == '\t') {
				j++
			}
			var us, ue int
			angle := false
			if j < len(s) && s[j] == '<' {
				k := strings.IndexByte(s[j+1:], '>')
				if k < 0 {
					i = p + 2
					continue
				}
				us, ue, angle = j+1, j+1+k, true
				j = ue + 1
			} else {
				depth, k := 0, j
			scan:
				for k < len(s) {
					switch s[k] {
					case '\\':
						k += 2
						continue
					case ' ', '\t':
						break scan
					case '(':
						depth++
					case ')':
						if depth == 0 {
							break scan
						}
						depth--
					}
					k++
				}
				if k > len(s) {
					k = len(s)
				}
				us, ue = j, k
				j = k
			}
			end := strings.IndexByte(s[j:], ')')
			if end < 0 || ue <= us {
				i = p + 2
				continue
			}
			out = append(out, URLLink{
				URL: s[us:ue], Start: l.start + us, End: l.start + ue, Angle: angle,
				Image: open > 0 && s[open-1] == '!', Line: l.no,
			})
			i = j + end + 1
		}
	})
	return out
}
