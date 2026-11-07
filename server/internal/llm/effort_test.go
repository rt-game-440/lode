package llm

import "testing"

func TestEffortMapping(t *testing.T) {
	t.Run("OpenAI reasoning_effort", func(t *testing.T) {
		for _, c := range []struct {
			in   Effort
			want string
		}{{"", ""}, {EffortOff, "none"}, {EffortLow, "low"}, {EffortMedium, "medium"}, {EffortHigh, "high"}} {
			eq(t, openAIEffort(c.in), c.want, "OpenAI "+string(c.in))
		}
	})

	t.Run("Anthropic thinking", func(t *testing.T) {
		adaptive := map[string]any{"type": "adaptive"}
		for _, c := range []struct {
			model     string
			in        Effort
			maxTokens int
			thinking  any
			effort    any
		}{
			{"claude-sonnet-5-5", "", 8000, nil, nil},
			{"claude-sonnet-5-5", EffortOff, 8000, nil, nil},
			{"claude-sonnet-5-5", EffortLow, 8000, adaptive, map[string]any{"effort": "low"}},
			{"claude-opus-5-5", EffortMedium, 8000, adaptive, map[string]any{"effort": "medium"}},
			{"claude-haiku-5-5", EffortHigh, 8000, adaptive, map[string]any{"effort": "high"}},
			{"claude-opus-4-6", EffortHigh, 8000, adaptive, map[string]any{"effort": "high"}},
			{"claude-opus-4-7", EffortLow, 8000, adaptive, map[string]any{"effort": "low"}},
			// 4.5 及更早只支持 enabled + budget_tokens；budget 至少 1024 且小于 max_tokens
			{"claude-sonnet-4-5", EffortLow, 32000, map[string]any{"type": "enabled", "budget_tokens": 2048}, nil},
			{"claude-sonnet-4-5-20250929", EffortMedium, 32000, map[string]any{"type": "enabled", "budget_tokens": 8192}, nil},
			{"claude-opus-4-1", EffortHigh, 32000, map[string]any{"type": "enabled", "budget_tokens": 24576}, nil},
			{"claude-sonnet-4", EffortHigh, 8000, map[string]any{"type": "enabled", "budget_tokens": 6976}, nil},
			{"claude-3-7-sonnet-latest", EffortHigh, 1500, nil, nil},
			{"claude-haiku-4-5", EffortOff, 8000, nil, nil},
		} {
			th, eff := anthropicThinking(c.model, c.in, c.maxTokens)
			eq(t, th, c.thinking, c.model+" "+string(c.in)+" thinking")
			eq(t, eff, c.effort, c.model+" "+string(c.in)+" output_config")
		}
	})

	t.Run("Gemini thinkingConfig", func(t *testing.T) {
		for _, c := range []struct {
			model string
			in    Effort
			want  any
		}{
			{"gemini-3-pro", "", nil},
			{"gemini-3-pro", EffortOff, map[string]any{"thinkingLevel": "MINIMAL"}},
			{"gemini-3-flash", EffortLow, map[string]any{"thinkingLevel": "LOW", "includeThoughts": true}},
			{"gemini-3.5-flash", EffortMedium, map[string]any{"thinkingLevel": "MEDIUM", "includeThoughts": true}},
			{"models/gemini-3-pro-preview", EffortHigh, map[string]any{"thinkingLevel": "HIGH", "includeThoughts": true}},
			{"gemini-2.5-flash", EffortOff, map[string]any{"thinkingBudget": 0}},
			{"gemini-2.5-flash", EffortLow, map[string]any{"thinkingBudget": 2048, "includeThoughts": true}},
			{"gemini-2.5-pro", EffortMedium, map[string]any{"thinkingBudget": 8192, "includeThoughts": true}},
			{"gemini-2.5-pro", EffortHigh, map[string]any{"thinkingBudget": 24576, "includeThoughts": true}},
		} {
			eq(t, geminiThinking(c.model, c.in), c.want, c.model+" "+string(c.in))
		}
	})
}
