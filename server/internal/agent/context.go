package agent

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/rt-game-440/lode/server/internal/llm"
)

// Budget 是一次请求可用的上下文：窗口 − 最大输出 − 窗口的 5%（留给估算误差）。
type Budget struct {
	Window    int
	MaxOutput int
}

// Limit 返回输入部分（系统提示 + 工具定义 + 历史）的 token 上限。
func (b Budget) Limit() int { return b.Window - b.MaxOutput - b.Window*5/100 }

// EstimateTokens 粗略估算 token 数：中日韩字符每字 1 个，其他字符每 4 个 1 个。
func EstimateTokens(s string) int {
	cjk, other := 0, 0
	for _, r := range s {
		if isCJK(r) {
			cjk++
		} else {
			other++
		}
	}
	return cjk + (other+3)/4
}

func isCJK(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) ||
		(r >= 0x3000 && r <= 0x303F) || (r >= 0xFF00 && r <= 0xFFEF)
}

// 附件的粗略估算：图片按固定值，PDF 和音频按字节数。
const (
	imageTokens     = 1500
	pdfBytesPerTok  = 300
	audioBytesPerTk = 1000
	messageOverhead = 4
)

func estimatePart(p llm.Part) int {
	switch p.Type {
	case llm.PartText, llm.PartThinking:
		return EstimateTokens(p.Text)
	case llm.PartToolCall:
		return EstimateTokens(p.Call.Name) + EstimateTokens(string(p.Call.Args)) + 4
	case llm.PartToolResult:
		return EstimateTokens(p.Result.Content) + 4
	case llm.PartMedia:
		switch {
		case strings.HasPrefix(p.Media.MIME, "image/"):
			return imageTokens
		case strings.HasPrefix(p.Media.MIME, "audio/"):
			return len(p.Media.Data)/audioBytesPerTk + 1
		default:
			return len(p.Media.Data)/pdfBytesPerTok + 1
		}
	}
	return 0
}

// EstimateMessage 估算一条消息。
func EstimateMessage(m llm.Message) int {
	n := messageOverhead
	for _, p := range m.Parts {
		n += estimatePart(p)
	}
	return n
}

// EstimateMessages 估算多条消息。
func EstimateMessages(ms []llm.Message) int {
	n := 0
	for _, m := range ms {
		n += EstimateMessage(m)
	}
	return n
}

// isUserTurn 报告消息是否是用户的提问（而不只是工具结果）。
func isUserTurn(m llm.Message) bool {
	if m.Role != llm.RoleUser {
		return false
	}
	for _, p := range m.Parts {
		if p.Type != llm.PartToolResult {
			return true
		}
	}
	return false
}

// lastRoundStart 返回最近一轮（最后一条用户提问及其之后）的起点。
func lastRoundStart(ms []llm.Message) int {
	for i := len(ms) - 1; i >= 0; i-- {
		if isUserTurn(ms[i]) {
			return i
		}
	}
	return 0
}

// 截断后的工具结果最多保留这么多 token。
const truncatedResultTokens = 200

// Fit 让系统提示、工具定义（toolTokens）和历史一起不超过 limit：
// 先截断较早轮次的工具结果，仍超出时把较早的轮次压缩成一条摘要，最后才截断最近一轮的工具结果。
// 系统提示和最近一轮的提问始终保留。返回新的历史和估算的总 token 数；不修改传入的切片。
func Fit(system string, toolTokens int, msgs []llm.Message, limit int) ([]llm.Message, int) {
	fixed := EstimateTokens(system) + toolTokens
	total := fixed + EstimateMessages(msgs)
	if total <= limit {
		return msgs, total
	}
	r := lastRoundStart(msgs)
	earlier, recent := cloneMessages(msgs[:r]), msgs[r:]

	// 1. 截断较早轮次的工具结果，从最早的开始
	for i := range earlier {
		if total <= limit {
			break
		}
		total -= truncateResults(&earlier[i], truncatedResultTokens)
	}
	if total <= limit {
		return append(earlier, recent...), total
	}

	// 2. 较早的轮次压缩成摘要
	recentTokens := EstimateMessages(recent)
	room := limit - fixed - recentTokens
	out := []llm.Message{}
	if s, ok := summarize(earlier, room); ok {
		out = append(out, s)
	}
	out = append(out, recent...)
	total = fixed + EstimateMessages(out)
	if total <= limit {
		return out, total
	}

	// 3. 最近一轮本身就超出：截断其中的工具结果
	out = cloneMessages(out)
	for i := range out {
		if total <= limit {
			break
		}
		total -= truncateResults(&out[i], truncatedResultTokens)
	}
	return out, total
}

// truncateResults 把消息里超长的工具结果截到 maxTokens，返回减少的 token 数。
func truncateResults(m *llm.Message, maxTokens int) int {
	saved := 0
	for j, p := range m.Parts {
		if p.Type != llm.PartToolResult || EstimateTokens(p.Result.Content) <= maxTokens {
			continue
		}
		before := estimatePart(p)
		res := *p.Result
		res.Content = cut(res.Content, maxTokens) + "\n…（工具结果过长，已截断。需要时请重新调用工具读取。）"
		m.Parts[j].Result = &res
		saved += before - estimatePart(m.Parts[j])
	}
	return saved
}

// cut 截取开头约 maxTokens 个 token 的内容。
func cut(s string, maxTokens int) string {
	n := 0
	other := 0
	for i, r := range s {
		if isCJK(r) {
			n++
		} else {
			other++
			if other == 4 {
				n++
				other = 0
			}
		}
		if n >= maxTokens {
			return s[:i]
		}
	}
	return s
}

// summarize 把较早的轮次压缩成一条用户消息：每轮记下提问、调用过的工具和回答的开头。
// 从最近的轮次往前取，直到用完 room；一轮都放不下时返回 false。
func summarize(earlier []llm.Message, room int) (llm.Message, bool) {
	const head = "以下是较早对话的摘要（原文已省略）：\n"
	const perLine = 80 // 每条提问或回答最多保留的 token 数
	budget := room - messageOverhead - EstimateTokens(head) - 20
	if budget <= 0 {
		return llm.Message{}, false
	}
	// 按轮切分
	var rounds [][]llm.Message
	for _, m := range earlier {
		if isUserTurn(m) || len(rounds) == 0 {
			rounds = append(rounds, nil)
		}
		rounds[len(rounds)-1] = append(rounds[len(rounds)-1], m)
	}
	var lines []string
	used := 0
	for i := len(rounds) - 1; i >= 0; i-- {
		var b strings.Builder
		var tools []string
		answer := ""
		for _, m := range rounds[i] {
			for _, p := range m.Parts {
				switch {
				case m.Role == llm.RoleUser && p.Type == llm.PartText:
					fmt.Fprintf(&b, "- 用户：%s\n", oneLine(cut(p.Text, perLine)))
				case p.Type == llm.PartToolCall:
					tools = append(tools, p.Call.Name)
				case m.Role == llm.RoleAssistant && p.Type == llm.PartText && p.Text != "":
					answer = p.Text
				}
			}
		}
		if len(tools) > 0 {
			fmt.Fprintf(&b, "  （调用了 %s）\n", strings.Join(tools, "、"))
		}
		if answer != "" {
			fmt.Fprintf(&b, "  助手：%s\n", oneLine(cut(answer, perLine)))
		}
		line := b.String()
		n := EstimateTokens(line)
		if used+n > budget {
			break
		}
		used += n
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return llm.Message{}, false
	}
	var b strings.Builder
	b.WriteString(head)
	for i := len(lines) - 1; i >= 0; i-- {
		b.WriteString(lines[i])
	}
	return llm.Message{Role: llm.RoleUser, Parts: []llm.Part{{Type: llm.PartText, Text: b.String()}}}, true
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// cloneMessages 复制消息和片段切片，修改时不影响原数据。
func cloneMessages(ms []llm.Message) []llm.Message {
	out := make([]llm.Message, len(ms))
	for i, m := range ms {
		out[i] = llm.Message{Role: m.Role, Parts: append([]llm.Part(nil), m.Parts...)}
	}
	return out
}
