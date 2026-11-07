package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/rt-game-440/lode/server/internal/llm"
)

func TestEstimateTokens(t *testing.T) {
	for _, c := range []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abcd", 1},
		{"abcde", 2},
		{"你好世界", 4},
		{"こんにちは", 5},
		{"안녕", 2},
		{"你好 abcd", 4}, // 2 个汉字 + 5 个其他字符（含空格）→ 2 + 2
	} {
		if got := EstimateTokens(c.in); got != c.want {
			t.Errorf("EstimateTokens(%q) = %d，期望 %d", c.in, got, c.want)
		}
	}
}

func text(role llm.Role, s string) llm.Message {
	return llm.Message{Role: role, Parts: []llm.Part{{Type: llm.PartText, Text: s}}}
}

// history 构造 rounds 轮对话：每轮用户提问 → 助手调用工具 → 工具结果（很长）→ 助手回答。
func history(rounds int, unit string) []llm.Message {
	var out []llm.Message
	for i := 0; i < rounds; i++ {
		id := fmt.Sprintf("call_%d", i)
		out = append(out,
			text(llm.RoleUser, fmt.Sprintf("第 %d 个问题：%s", i, strings.Repeat(unit, 20))),
			llm.Message{Role: llm.RoleAssistant, Parts: []llm.Part{{Type: llm.PartToolCall, Call: &llm.ToolCall{ID: id, Name: "read_note", Args: json.RawMessage(`{"path":"a.md"}`)}}}},
			llm.Message{Role: llm.RoleUser, Parts: []llm.Part{{Type: llm.PartToolResult, Result: &llm.ToolResult{CallID: id, Name: "read_note", Content: strings.Repeat(unit, 400)}}}},
			text(llm.RoleAssistant, fmt.Sprintf("第 %d 个回答：%s", i, strings.Repeat(unit, 60))),
		)
	}
	return out
}

func TestFitKeepsSystemAndLastRoundWithinBudget(t *testing.T) {
	for _, c := range []struct {
		name string
		unit string
	}{{"中文", "笔记内容很长"}, {"英文", "note content is long "}} {
		t.Run(c.name, func(t *testing.T) {
			system := "你是 Lode 的笔记助手。" + strings.Repeat(c.unit, 30)
			msgs := history(40, c.unit)
			b := Budget{Window: 16000, MaxOutput: 2000}
			limit := b.Limit()
			if limit != 16000-2000-800 {
				t.Fatalf("预算 = 窗口 − 最大输出 − 5%%：得到 %d", limit)
			}
			full := EstimateTokens(system) + EstimateMessages(msgs)
			if full <= limit*3 {
				t.Fatalf("构造的历史应远超预算：%d / %d", full, limit)
			}
			out, used := Fit(system, 300, msgs, limit)
			if used > limit {
				t.Errorf("结果 %d 超出预算 %d", used, limit)
			}
			if got := EstimateTokens(system) + 300 + EstimateMessages(out); got != used {
				t.Errorf("used 应等于实际估算：%d / %d", used, got)
			}
			// 最近一轮原样保留
			last := msgs[len(msgs)-4:]
			tail := out[len(out)-4:]
			a, _ := json.Marshal(last)
			bb, _ := json.Marshal(tail)
			if string(a) != string(bb) {
				t.Errorf("最近一轮被改动了")
			}
			// 较早的轮次压缩成摘要，放在最前面，且保留了最近几轮的提问
			if !strings.Contains(out[0].Text(), "较早对话的摘要") || !strings.Contains(out[0].Text(), "第 38 个问题") {
				t.Errorf("第一条应是摘要：%.200s", out[0].Text())
			}
			// 工具调用和结果不能被拆散：每个 tool_result 前面都有对应的 tool_call
			calls := map[string]bool{}
			for _, m := range out {
				for _, p := range m.Parts {
					if p.Type == llm.PartToolCall {
						calls[p.Call.ID] = true
					}
					if p.Type == llm.PartToolResult && !calls[p.Result.CallID] {
						t.Errorf("tool_result %s 前面没有对应的 tool_call", p.Result.CallID)
					}
				}
			}
		})
	}
}

func TestFitTruncatesToolResultsFirst(t *testing.T) {
	msgs := history(3, "很长的工具结果")
	b := Budget{Window: 7000, MaxOutput: 1000}
	full := EstimateMessages(msgs)
	if full <= b.Limit() {
		t.Fatalf("应超出预算：%d / %d", full, b.Limit())
	}
	out, used := Fit("系统", 0, msgs, b.Limit())
	if used > b.Limit() {
		t.Fatalf("超出预算：%d", used)
	}
	if len(out) != len(msgs) {
		t.Fatalf("只截断工具结果就够时，不应压缩轮次：%d 条 → %d 条", len(msgs), len(out))
	}
	r := out[2].Parts[0].Result.Content
	if !strings.Contains(r, "已截断") || EstimateTokens(r) >= EstimateTokens(msgs[2].Parts[0].Result.Content) {
		t.Errorf("较早的工具结果应被截断：%.80s", r)
	}
	if out[len(out)-2].Parts[0].Result.Content != msgs[len(msgs)-2].Parts[0].Result.Content {
		t.Error("最近一轮的工具结果不应被截断")
	}
}

func TestFitUnderBudgetUnchanged(t *testing.T) {
	msgs := history(1, "短")
	out, _ := Fit("系统", 0, msgs, 100000)
	a, _ := json.Marshal(msgs)
	b, _ := json.Marshal(out)
	if string(a) != string(b) {
		t.Error("没超出预算时应原样返回")
	}
}
