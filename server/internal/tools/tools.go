// Package tools 是笔记工具的注册表：每个工具有名称、给模型看的描述、输入 JSON Schema、是否只读和处理函数。
// MCP 服务和阶段 5 的 Agent 共用这一份注册表；处理函数只调用 notes 服务。
package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/rt-game-440/lode/server/internal/notes"
)

var (
	// ErrUnknownTool 表示没有这个工具。
	ErrUnknownTool = errors.New("unknown tool")
	// ErrReadOnly 表示只读调用方调用了写工具。
	ErrReadOnly = errors.New("read-only")
	// ErrBadArguments 表示参数不符合工具的 JSON Schema。
	ErrBadArguments = errors.New("bad arguments")
)

// Tool 是一个可供模型调用的工具。
type Tool struct {
	Name        string
	Description string             // 写给模型看：用途、参数、返回内容和常见错误
	InputSchema *jsonschema.Schema // 参数的 JSON Schema，type 为 object
	ReadOnly    bool               // 只读工具；只读调用方只能看到和调用这些工具

	resolved *jsonschema.Resolved
	run      func(ctx context.Context, raw json.RawMessage) (value any, target string, err error)
}

// Registry 是工具注册表。
type Registry struct {
	tools  []*Tool
	byName map[string]*Tool
}

// New 创建包含全部笔记工具的注册表。
func New(svc *notes.Service) *Registry {
	r := &Registry{byName: map[string]*Tool{}}
	for _, t := range noteTools(svc) {
		r.tools = append(r.tools, t)
		r.byName[t.Name] = t
	}
	return r
}

// Tools 返回调用方可见的工具；canWrite 为 false 时只含只读工具。
func (r *Registry) Tools(canWrite bool) []*Tool {
	out := make([]*Tool, 0, len(r.tools))
	for _, t := range r.tools {
		if canWrite || t.ReadOnly {
			out = append(out, t)
		}
	}
	return out
}

// Result 是一次成功调用的结果。
type Result struct {
	Target string // 涉及的笔记路径或查询词，供审计日志使用
	Value  any
}

// Text 把结果编码为给模型看的 JSON 文本（不转义 HTML 字符，Markdown 原样可读）。
func (r Result) Text() string { return encode(r.Value) }

// Error 是工具调用失败：Error() 返回给模型看的中文说明，Unwrap 返回原始错误。
type Error struct {
	Msg string
	Err error
}

func (e *Error) Error() string { return e.Msg }
func (e *Error) Unwrap() error { return e.Err }

// Call 按名称调用工具：先按 JSON Schema 校验参数，只读调用方调用写工具时拒绝。
// 失败时返回 *Error；Result.Target 在参数能解析时总会填上，便于审计。
func (r *Registry) Call(ctx context.Context, name string, args json.RawMessage, canWrite bool) (Result, error) {
	t, ok := r.byName[name]
	if !ok {
		return Result{}, &Error{Msg: fmt.Sprintf("没有名为 %s 的工具。", name), Err: ErrUnknownTool}
	}
	if !t.ReadOnly && !canWrite {
		return Result{}, &Error{Msg: fmt.Sprintf("当前 token 只有只读权限，不能调用 %s。", name), Err: ErrReadOnly}
	}
	if len(bytes.TrimSpace(args)) == 0 || bytes.Equal(bytes.TrimSpace(args), []byte("null")) {
		args = json.RawMessage("{}")
	}
	var instance any
	if err := json.Unmarshal(args, &instance); err != nil {
		return Result{}, badArgs(err)
	}
	if err := t.resolved.Validate(instance); err != nil {
		return Result{}, badArgs(err)
	}
	v, target, err := t.run(ctx, args)
	if err != nil {
		return Result{Target: target}, explain(err, target)
	}
	return Result{Target: target, Value: v}, nil
}

func badArgs(err error) *Error {
	return &Error{Msg: "参数不合法：" + err.Error() + "。请对照工具的参数说明重试。", Err: fmt.Errorf("%w: %v", ErrBadArguments, err)}
}

// input 是工具参数类型：target 返回审计日志里记录的路径或查询词。
type input interface{ target() string }

// define 用参数类型 In 推断 JSON Schema（不带 omitempty 的字段为必填，不允许多余字段），
// tune 可补充默认值、取值范围等约束。
func define[In input](name string, readOnly bool, desc string, tune func(props map[string]*jsonschema.Schema), run func(ctx context.Context, in In) (any, error)) *Tool {
	s, err := jsonschema.For[In](nil)
	if err != nil {
		panic(fmt.Sprintf("tools: %s 的参数类型无法生成 schema: %v", name, err))
	}
	if tune != nil {
		tune(s.Properties)
	}
	resolved, err := s.Resolve(nil)
	if err != nil {
		panic(fmt.Sprintf("tools: %s 的 schema 无效: %v", name, err))
	}
	return &Tool{
		Name:        name,
		Description: strings.TrimSpace(desc),
		InputSchema: s,
		ReadOnly:    readOnly,
		resolved:    resolved,
		run: func(ctx context.Context, raw json.RawMessage) (any, string, error) {
			var in In
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, "", badArgs(err)
			}
			v, err := run(ctx, in)
			return v, in.target(), err
		},
	}
}

// explain 把 notes 的错误翻译成给模型看的说明，告诉它下一步怎么做。
func explain(err error, target string) *Error {
	var te *Error
	if errors.As(err, &te) {
		return te
	}
	var ce *notes.ConflictError
	var pe *notes.PatchError
	msg := ""
	switch {
	case errors.As(err, &ce) && ce.CopyPath != "":
		msg = fmt.Sprintf("base_rev 已过期（当前 rev 为 %d），你的修改与别处的修改冲突，无法自动合并。笔记保持服务器版本不变，你提交的全文已另存为冲突副本 %s。请先用 read_note 读取最新内容，再基于新的 rev 修改。", ce.CurrentRev, ce.CopyPath)
	case errors.As(err, &ce):
		msg = fmt.Sprintf("base_rev 已过期（当前 rev 为 %d），无法自动合并。请先用 read_note 读取最新内容，再基于新的 rev 修改。", ce.CurrentRev)
	case errors.As(err, &pe) && pe.Matches == 0:
		msg = fmt.Sprintf("edits 第 %d 处的 old 没有匹配到任何内容。old 必须与原文逐字一致（包括空格、标点和换行），请先用 read_note 确认原文。", pe.Index+1)
	case errors.As(err, &pe):
		msg = fmt.Sprintf("edits 第 %d 处的 old 匹配到 %d 处，必须唯一。请在 old 里多带一些上下文，让它只匹配一处。", pe.Index+1, pe.Matches)
	case errors.Is(err, notes.ErrInvalidPath):
		msg = fmt.Sprintf("路径不合法：%s。路径相对笔记库根目录，用 / 分隔，不能包含 ..、盘符或 <>:\"|?* 等字符；笔记路径必须以 .md 结尾。（%s）", target, detail(err))
	case errors.Is(err, notes.ErrNotFound):
		msg = fmt.Sprintf("找不到 %s。可以先用 search_notes 或 list_notes 确认路径。", target)
	case errors.Is(err, notes.ErrExists):
		msg = fmt.Sprintf("%s 已存在。换一个路径，或用 update_note 修改已有笔记。", target)
	case errors.Is(err, notes.ErrInvalid):
		msg = "参数不合法：" + detail(err) + "。"
	default:
		msg = "服务器内部错误：" + err.Error()
	}
	return &Error{Msg: msg, Err: err}
}

// detail 去掉哨兵错误的英文前缀，只留补充说明。
func detail(err error) string {
	s := err.Error()
	if i := strings.Index(s, ": "); i >= 0 {
		return s[i+2:]
	}
	return s
}

func encode(v any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return fmt.Sprintf(`{"error":%q}`, err.Error())
	}
	return strings.TrimSuffix(b.String(), "\n")
}
