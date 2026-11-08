package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/rt-game-440/lode/server/internal/llm"
)

// 模型摘要：上下文放不下时，用当前模型把较早的轮次压缩成摘要。
// 摘要缓存在 agent_chats.summary，summary_upto 记录覆盖到第几条消息；
// 之后再超出时只把新增的轮次合并进已有摘要。模型调用失败时退回本地规则生成的摘要。

const (
	summarySystem = `你负责对话压缩：把笔记助手与用户的一段对话压缩成摘要，助手会带着这份摘要继续对话。
- 保留：用户的目标和偏好、已经确认的决定、提到或修改过的笔记路径、已完成的操作和尚未完成的事项。
- 省略：寒暄、重复内容，以及工具结果里与后续无关的细节。
- 给出已有摘要时，把新对话合并进去，输出完整的新摘要。
- 直接输出摘要正文，用简体中文，不超过 %d 字。`
	summaryMaxTokens    = 2000 // 摘要最长的 token 数
	summaryMinTokens    = 100  // 可用空间比这还小时不调用模型
	transcriptCallChars = 300  // 记录里每个工具参数最多保留的字符数
	transcriptResultTok = 200  // 记录里每个工具结果最多保留的 token 数
)

// modelSummarizer 返回用当前模型生成摘要的 Summarizer。
func (s *Service) modelSummarizer(ctx context.Context, sp Space, cfg llm.Config, chat Chat, m Model) Summarizer {
	return func(earlier []llm.Message, room int) (llm.Message, bool) {
		n := len(earlier)
		maxTok := min(room-messageOverhead-EstimateTokens(summaryHead)-20, summaryMaxTokens, m.MaxOutput)
		if n == 0 || maxTok < summaryMinTokens {
			return summarize(earlier, room)
		}
		prev, from := "", 0
		if chat.Summary != "" && chat.SummaryUpto <= n {
			prev, from = chat.Summary, chat.SummaryUpto
		}
		text := prev
		if from < n {
			t, err := s.summarizeWithModel(ctx, sp, cfg, chat.ID, m, prev, earlier[from:], maxTok)
			if err != nil {
				s.log().Warn("模型生成摘要失败，改用本地摘要", "chat", chat.ID, "model", m.Model, "err", err)
				return summarize(earlier, room)
			}
			text = t
			chat.Summary, chat.SummaryUpto = t, n
			if err := sp.Chats.SetSummary(context.WithoutCancel(ctx), chat.ID, t, n); err != nil {
				s.log().Warn("保存摘要失败", "chat", chat.ID, "err", err)
			}
		}
		if EstimateTokens(text) > maxTok {
			text = cut(text, maxTok)
		}
		return llm.Message{Role: llm.RoleUser, Parts: []llm.Part{{Type: llm.PartText, Text: summaryHead + text}}}, true
	}
}

// summarizeWithModel 请求模型把 msgs 合并进已有摘要 prev，返回新摘要。
func (s *Service) summarizeWithModel(ctx context.Context, sp Space, cfg llm.Config, chatID string, m Model, prev string, msgs []llm.Message, maxTok int) (string, error) {
	system := fmt.Sprintf(summarySystem, maxTok*4/5)
	// 摘要请求本身也要放进上下文窗口：放不下时只保留较新的部分
	inputLimit := Budget{Window: m.ContextWindow, MaxOutput: maxTok}.Limit() - EstimateTokens(system) - EstimateTokens(prev) - 100
	var b strings.Builder
	if prev != "" {
		fmt.Fprintf(&b, "已有摘要：\n%s\n\n需要合并进摘要的新对话：\n", prev)
	} else {
		b.WriteString("需要压缩的对话：\n")
	}
	b.WriteString(transcript(msgs, inputLimit))
	req := llm.Request{
		Model:     m.Model,
		System:    system,
		Messages:  []llm.Message{{Role: llm.RoleUser, Parts: []llm.Part{{Type: llm.PartText, Text: b.String()}}}},
		MaxTokens: maxTok,
	}
	res, err := llm.Stream(ctx, cfg, req, func(llm.Event) {})
	if err != nil {
		return "", err
	}
	_ = sp.Chats.addUsage(context.WithoutCancel(ctx), chatID, res.Usage)
	text := strings.TrimSpace(res.Message.Text())
	if text == "" {
		return "", fmt.Errorf("模型返回了空摘要")
	}
	return text, nil
}

// transcript 把消息写成纯文本记录，超过 limit 个 token 时丢弃最早的部分。
func transcript(msgs []llm.Message, limit int) string {
	var lines []string
	for _, m := range msgs {
		for _, p := range m.Parts {
			var line string
			switch {
			case p.Type == llm.PartText && p.Text != "" && m.Role == llm.RoleUser:
				line = "用户：" + p.Text
			case p.Type == llm.PartText && p.Text != "":
				line = "助手：" + p.Text
			case p.Type == llm.PartToolCall && p.Call != nil:
				args := []rune(string(p.Call.Args))
				if len(args) > transcriptCallChars {
					args = append(args[:transcriptCallChars], '…')
				}
				line = fmt.Sprintf("（助手调用 %s：%s）", p.Call.Name, string(args))
			case p.Type == llm.PartToolResult && p.Result != nil:
				line = fmt.Sprintf("（%s 的结果：%s）", p.Result.Name, cut(p.Result.Content, transcriptResultTok))
			case p.Type == llm.PartMedia && p.Media != nil:
				line = fmt.Sprintf("（附件 %s）", p.Media.Name)
			}
			if line != "" {
				lines = append(lines, line)
			}
		}
	}
	total := 0
	for _, l := range lines {
		total += EstimateTokens(l) + 1
	}
	dropped := false
	for total > limit && len(lines) > 1 {
		total -= EstimateTokens(lines[0]) + 1
		lines = lines[1:]
		dropped = true
	}
	out := strings.Join(lines, "\n")
	if dropped {
		out = "…（更早的内容已省略）\n" + out
	}
	return out
}
