# Agent 助手：模型供应商接入说明

本文记录 `server/internal/llm` 三个适配器依据的官方接口格式，以及“推理强度”如何映射到各家参数。查阅日期：2026-11-07。文档没写清楚的地方单独标注，并说明实现里怎么处理。

## 供应商类型

| 类型 | 接口 | 鉴权 | 流式 |
| --- | --- | --- | --- |
| OpenAI 兼容（`openai`） | `POST {base}/chat/completions`（Chat Completions） | `Authorization: Bearer <key>` | `stream: true`，`stream_options.include_usage: true` |
| Anthropic（`anthropic`） | `POST {base}/v1/messages` | `x-api-key`，`anthropic-version: 2026-10-21` | `stream: true` |
| Gemini（`gemini`） | `POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse` | `x-goog-api-key` 请求头 | `alt=sse` |

- OpenAI 兼容类型的 base URL 填到 `/v1` 为止，例如 `https://api.openai.com/v1`、`http://127.0.0.1:11434/v1`。默认值：OpenAI `https://api.openai.com/v1`，Anthropic `https://api.anthropic.com`，Gemini `https://generativelanguage.googleapis.com`。
- 没有用 OpenAI Responses 接口：第三方兼容服务（Ollama、vLLM、OpenRouter、DeepSeek 等）普遍只实现 Chat Completions。代价是 OpenAI 官方模型在 Chat Completions 下不返回思考文本，只返回思考 token 数；另外 GPT-6 Astra、GPT-6.1 Sol 在 Chat Completions 下不支持工具调用，这两个模型请在模型设置里关掉“支持工具”。
- 测试连接调用各家的模型列表接口：OpenAI `GET {base}/models`，Anthropic `GET /v1/models`，Gemini `GET /v1beta/models`。

## 推理强度映射

Lode 统一用 4 档：`off`、`low`、`medium`、`high`。模型设置里“推理强度”关闭（模型不支持推理）时，不发送任何推理参数，界面也不显示推理强度选择。

| Lode | OpenAI 兼容 `reasoning_effort` | Anthropic（4.6 及以后、5.x） | Anthropic（4.5 及更早） | Gemini 3 及以后 `thinkingConfig` | Gemini 2.x `thinkingConfig` |
| --- | --- | --- | --- | --- | --- |
| off | `"none"` | 不发送 `thinking` 和 `effort` | 不发送 `thinking` | `thinkingLevel: "MINIMAL"` | `thinkingBudget: 0` ※ |
| low | `"low"` | `thinking: {type: "adaptive"}`，`output_config: {effort: "low"}` | `thinking: {type: "enabled", budget_tokens: 2048}` | `thinkingLevel: "LOW"`，`includeThoughts: true` | `thinkingBudget: 2048`，`includeThoughts: true` |
| medium | `"medium"` | 同上，`effort: "medium"` | `budget_tokens: 8192` | `"MEDIUM"`，`includeThoughts: true` | `thinkingBudget: 8192`，`includeThoughts: true` |
| high | `"high"` | 同上，`effort: "high"` | `budget_tokens: 24576` | `"HIGH"`，`includeThoughts: true` | `thinkingBudget: 24576`，`includeThoughts: true` |

依据与说明：

- **OpenAI**：`reasoning_effort` 可取 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，具体支持哪些取决于模型。例如 gpt-6-astra 不支持 `none`（返回 400），gpt-6.1-sol 不支持 `none` 和 `minimal`。遇到这种模型时 `off` 会得到 400 错误，界面显示“请求参数不被接受”，请改选 low。思考 token 数在 `usage.completion_tokens_details.reasoning_tokens`。Chat Completions 的 delta 里没有思考文本字段；部分兼容服务（DeepSeek、OpenRouter、vLLM）会在 delta 里带 `reasoning_content` 或 `reasoning`，这不在 OpenAI 文档里，适配器把这两个字段当作思考增量处理。
- **Anthropic**：
  - 4.5 及更早只支持 `{type: "enabled", budget_tokens}`，`budget_tokens` 至少 1024，且必须小于 `max_tokens`。适配器会把它限制在 `max_tokens - 1024` 以内，不足 1024 时不开启思考。
  - 4.7 及以后、5.x 只支持 `{type: "adaptive"}`，配合 `output_config.effort`（low / medium / high / xhigh / max），这些模型传 `enabled` 会返回 400；4.6 两种都支持。
  - Opus 5.5 不能关闭思考，`off` 时不发送参数，由模型按默认值思考。
  - 适配器按模型 ID 区分新旧：匹配 `claude-3*` 或 `claude-*-4-[0-5]`（含 `claude-*-4` 本身）的视为旧模型，其他一律按新模型处理。
  - API 版本 `2026-10-21` 移除了 `temperature`、`top_p`、`top_k`，发送会返回 400，所以 Anthropic 适配器忽略模型设置里的 temperature。
- **Gemini**：
  - `thinkingLevel` 取值 `MINIMAL`、`LOW`、`MEDIUM`、`HIGH`，文档写明“推荐 Gemini 3 及以后的模型使用，旧模型使用会报错”；适配器按模型 ID 匹配 `gemini-([3-9]|\d{2})` 判断。
  - ※ `thinkingBudget` 在参考文档里只写了“模型应生成的思考 token 数”，没写 0 表示关闭、-1 表示动态。实现沿用 `0` 关闭思考；若模型拒绝（例如某些 Pro 模型不允许关闭），会得到 400 并显示可读错误。
  - `includeThoughts: true` 时，思考内容以 `thought: true` 的 part 返回。Gemini 3.6 及以后忽略 `temperature`。

## 统一事件流

`llm.Stream` 把三家的流式响应翻译成同一组事件：

| 事件 | 含义 |
| --- | --- |
| `text` | 正文增量 |
| `thinking` | 思考增量 |
| `tool_call` | 一次完整的工具调用（参数拼接完成后才发出） |
| `usage` | 用量：输入、输出、其中思考 token |
| `done` | 正常结束，带结束原因：`stop`、`tool_calls`、`max_tokens`、`refusal` |
| `error` | 出错，带错误类别 |

错误类别与提示：`auth`（API key 无效或没有权限）、`rate_limit`（限流或额度用尽）、`context_length`（超出上下文窗口）、`model_not_found`（模型不存在）、`bad_request`（参数不被接受）、`server`（供应商服务出错或过载）、`network`（连不上供应商）、`canceled`（用户停止）。

### OpenAI Chat Completions

- SSE 每帧为 `data: {chunk}`，以 `data: [DONE]` 结束。开启 `include_usage` 后，`[DONE]` 之前多一帧：`choices` 为空，带 `usage`。
- `choices[0].delta` 中有 `content`、`refusal`、`tool_calls[{index, id?, type?, function: {name?, arguments?}}]`。同一工具调用的参数分多帧到达，按 `index` 拼接。
- `finish_reason`：`stop`、`length`、`tool_calls`、`content_filter`。
- 工具定义 `{type: "function", function: {name, description, parameters}}`；工具结果消息 `{role: "tool", tool_call_id, content}`。
- `max_completion_tokens` 取代已弃用的 `max_tokens`。
- 多模态：图片 `{type: "image_url", image_url: {url: "data:<mime>;base64,..."}}`；PDF `{type: "file", file: {file_data: "data:application/pdf;base64,...", filename}}`；音频 `{type: "input_audio", input_audio: {data: <裸 base64>, format: "wav" | "mp3"}}`。
- 错误体 `{error: {message, type, param, code}}`。文档没有列出“上下文超长”的错误码，适配器在 400 响应里匹配 `context_length_exceeded` 或消息中的 “context length / maximum context” 字样。

### Anthropic Messages

- SSE 事件顺序：`message_start`（`message.usage`）→ `content_block_start`（`text`、`thinking`、`redacted_thinking`、`tool_use{id, name}`）→ `content_block_delta`（`text_delta.text`、`thinking_delta.thinking`、`signature_delta.signature`、`input_json_delta.partial_json`）→ `content_block_stop` → `message_delta`（`delta.stop_reason`，`usage` 为累计值）→ `message_stop`。另有 `ping` 和 `error`（`{type: "error", error: {type, message}}`）。
- 工具定义 `{name, description, input_schema}`；工具结果是 user 消息里的 `{type: "tool_result", tool_use_id, content, is_error}`，放在其他内容之前。
- 带工具调用的多轮里，上一条 assistant 的 thinking 块（含 `signature`）和 `redacted_thinking` 块必须原样带回，适配器把它们存在消息里。
- `stop_reason`：`end_turn`、`tool_use`、`max_tokens`、`refusal`、`model_context_window_exceeded`（4.5 及以后超出上下文窗口时返回）等。
- 多模态：图片 `{type: "image", source: {type: "base64", media_type, data}}`；PDF `{type: "document", source: {type: "base64", media_type: "application/pdf", data}}`。不支持音频。
- 错误类型与状态码：`invalid_request_error` 400、`authentication_error` 401、`permission_error` 403、`not_found_error` 404、`rate_limit_error` 429、`api_error` 500、`overloaded_error` 529。

### Gemini generateContent

- SSE 每帧为 `data: <GenerateContentResponse JSON>`，没有 `[DONE]`，连接关闭即结束。
- 请求体：`contents`（role 为 `user` / `model`）、`systemInstruction`、`tools: [{functionDeclarations: [{name, description, parametersJsonSchema}]}]`、`generationConfig`（`maxOutputTokens`、`temperature`、`thinkingConfig`）。
- 响应：`candidates[0].content.parts[]`，part 可能是 `text`（`thought: true` 时为思考）或 `functionCall{id?, name, args}`；`finishReason`（`STOP`、`MAX_TOKENS`、`SAFETY`、`MALFORMED_FUNCTION_CALL` 等）；`usageMetadata`（`promptTokenCount`、`candidatesTokenCount`、`thoughtsTokenCount`）。
- part 上的 `thoughtSignature` 需要在下一轮原样带回，适配器把它存在工具调用和思考内容上。
- 工具结果用 `functionResponse{id, name, response}` 回传，所在 content 的 role 用 `user`（官方 Python SDK 的自动函数调用就是这样做的；参考文档中 `function` 和 `user` 两种写法都出现过）。
- 多模态：`inlineData{mimeType, data}`，支持图片、PDF、音频；单次请求内联数据上限 20MB。
- 错误体 `{error: {code, message, status}}`，`status` 如 `INVALID_ARGUMENT`、`PERMISSION_DENIED`、`NOT_FOUND`、`RESOURCE_EXHAUSTED`。

## 依据链接

- OpenAI Chat Completions：<https://developers.openai.com/api/reference/resources/chat>、流式事件 <https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events>（`platform.openai.com/docs` 对自动抓取返回 403）
- OpenAI 推理：<https://developers.openai.com/api/docs/guides/reasoning>
- OpenAI 多模态：<https://developers.openai.com/api/docs/guides/images-vision>、<https://developers.openai.com/api/docs/guides/pdf-files>、<https://developers.openai.com/api/docs/guides/audio-chat-completions>
- OpenAI 错误码：<https://developers.openai.com/api/docs/guides/error-codes>
- OpenAI Responses（调研过，未采用）：<https://developers.openai.com/api/reference/resources/responses/methods/create>、<https://developers.openai.com/api/reference/resources/responses/streaming-events>
- Anthropic Messages 与流式：<https://platform.claude.com/docs/en/api/messages>、<https://platform.claude.com/docs/en/build-with-claude/streaming>
- Anthropic 思考：<https://platform.claude.com/docs/en/build-with-claude/extended-thinking>、<https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking>、<https://platform.claude.com/docs/en/build-with-claude/effort>
- Anthropic 工具调用：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls>
- Anthropic 多模态：<https://platform.claude.com/docs/en/build-with-claude/vision>、<https://platform.claude.com/docs/en/build-with-claude/pdf-support>
- Anthropic API 版本：<https://platform.claude.com/docs/en/api/versioning>；SDK 默认值 <https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/_constants.py>
- Anthropic 错误：<https://platform.claude.com/docs/en/api/errors>
- Gemini generateContent / 流式：<https://aistudio.google.com/api-reference/generate-content/stream-generate-content>（`ai.google.dev` 已跳转到此）
- Gemini thinking：<https://aistudio.google.com/docs/thinking>
- Gemini 错误：<https://aistudio.google.com/docs/troubleshooting>
- Gemini function calling：<https://aistudio.google.com/docs/function-calling>
- Gemini SDK 的 SSE 解析、鉴权头、functionResponse 的 role：<https://github.com/googleapis/python-genai/blob/main/google/genai/_api_client.py>、<https://github.com/googleapis/python-genai/blob/main/google/genai/models.py>

## Agent 行为

- 只读工具（search_notes、read_note、list_notes、get_backlinks、list_tags、get_notes_by_tag）自动执行。
- 写工具（create_note、update_note、move_note、delete_note）先暂停，把预览 diff 发给前端；批准后执行，拒绝时告诉模型“用户拒绝了这次操作”。设置里的“自动批准写操作”默认关闭。
- 每轮（一条用户消息开始到模型给出最终回答）最多 20 次工具调用。超出的调用直接返回“已达到上限”的错误结果，模型再请求一次工具就结束本轮。
- 上下文预算 = 上下文窗口 − 最大输出 − 窗口的 5%。估算：中日韩字符每字 1 token，其他字符每 4 个 1 token。超出预算时先截断较早的工具结果，再把较早的轮次压缩成摘要；系统提示和最近一轮始终保留。
