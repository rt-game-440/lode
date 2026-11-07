// Package notes 是笔记的唯一业务层。REST、MCP 和 Agent 都只做薄封装并调用这里。
//
// 文件是唯一真相源：每次写入先原子写文件，再更新 SQLite 中的索引（全文、链接、标签、历史版本、变更序号）。
package notes

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/rt-game-440/lode/server/internal/mdparse"
	"github.com/rt-game-440/lode/server/internal/vault"
)

var (
	// ErrNotFound 表示笔记、文件夹或回收站条目不存在。
	ErrNotFound = errors.New("not found")
	// ErrExists 表示目标路径已存在。
	ErrExists = errors.New("already exists")
	// ErrInvalidPath 表示路径不合法（含目录穿越）。
	ErrInvalidPath = vault.ErrInvalidPath
	// ErrInvalid 表示参数不合法。
	ErrInvalid = errors.New("invalid argument")
)

// ConflictError 表示写入时 base_rev 与服务器当前 rev 不一致。
type ConflictError struct {
	CurrentRev int64
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("conflict: 笔记已被修改，当前 rev 为 %d", e.CurrentRev)
}

// PatchError 表示 patch 中某个 old 片段没有唯一匹配。
type PatchError struct {
	Index   int // 第几个 edit（从 0 开始）
	Matches int // 匹配到的次数
}

func (e *PatchError) Error() string {
	if e.Matches == 0 {
		return fmt.Sprintf("patch 第 %d 处的 old 没有匹配到任何内容", e.Index+1)
	}
	return fmt.Sprintf("patch 第 %d 处的 old 匹配到 %d 处，必须唯一", e.Index+1, e.Matches)
}

// Note 是笔记的元数据。
type Note struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	Title     string `json:"title"`
	Rev       int64  `json:"rev"`
	Hash      string `json:"hash"`
	Size      int64  `json:"size"`
	Mtime     int64  `json:"mtime"`      // 文件修改时间，unix 毫秒
	CreatedAt int64  `json:"created_at"` // unix 毫秒
	UpdatedAt int64  `json:"updated_at"` // unix 毫秒
}

// NoteContent 是带正文的笔记。
type NoteContent struct {
	Note
	Content string `json:"content"`
}

// Change 是一条变更事件。
type Change struct {
	Seq        int64  `json:"seq"`
	Type       string `json:"type"` // upsert | move | delete
	ID         string `json:"id"`
	Path       string `json:"path"`
	Rev        int64  `json:"rev"`
	DeviceID   string `json:"device_id"`
	DeviceName string `json:"device_name"`
	CreatedAt  int64  `json:"created_at"`
}

// Actor 描述写入来源（设备），记录在历史版本和变更事件里。
type Actor struct {
	DeviceID   string
	DeviceName string
}

type actorKey struct{}

// WithActor 把写入来源放进 context。
func WithActor(ctx context.Context, a Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, a)
}

func actorFrom(ctx context.Context) Actor {
	a, _ := ctx.Value(actorKey{}).(Actor)
	return a
}

// fsActor 用于文件系统外部修改产生的变更。
var fsActor = Actor{DeviceID: "fs", DeviceName: "文件系统"}

// Options 配置 Service。
type Options struct {
	DB       *sql.DB
	Vault    *vault.Vault
	TrashDir string
	Logger   *slog.Logger
	Now      func() time.Time
}

// Service 是笔记业务层。
type Service struct {
	db       *sql.DB
	vault    *vault.Vault
	trashDir string
	log      *slog.Logger
	now      func() time.Time

	mu sync.Mutex // 串行化所有写操作（含对账）

	subMu sync.Mutex
	subs  map[chan Change]struct{}
}

// New 创建 Service。
func New(o Options) *Service {
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Service{
		db:       o.DB,
		vault:    o.Vault,
		trashDir: o.TrashDir,
		log:      o.Logger,
		now:      o.Now,
		subs:     map[chan Change]struct{}{},
	}
}

// Vault 返回底层 vault。
func (s *Service) Vault() *vault.Vault { return s.vault }

// Subscribe 订阅变更事件。返回的取消函数会关闭通道。消费过慢时事件会被丢弃，订阅者应通过 Changes 补齐。
func (s *Service) Subscribe(buffer int) (<-chan Change, func()) {
	ch := make(chan Change, buffer)
	s.subMu.Lock()
	s.subs[ch] = struct{}{}
	s.subMu.Unlock()
	return ch, func() {
		s.subMu.Lock()
		if _, ok := s.subs[ch]; ok {
			delete(s.subs, ch)
			close(ch)
		}
		s.subMu.Unlock()
	}
}

func (s *Service) emit(changes []Change) {
	if len(changes) == 0 {
		return
	}
	s.subMu.Lock()
	defer s.subMu.Unlock()
	for ch := range s.subs {
		for _, c := range changes {
			select {
			case ch <- c:
			default:
			}
		}
	}
}

// ---- 工具函数 ----

func newID() string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
}

func hashContent(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// titleOf 返回笔记标题：文件名去掉 .md。
func titleOf(p string) string {
	b := path.Base(p)
	return b[:len(b)-len(path.Ext(b))]
}

// keyOf 返回小写、去掉 .md 的路径。
func keyOf(p string) string {
	return strings.ToLower(strings.TrimSuffix(p, path.Ext(p)))
}

func baseOf(p string) string {
	return strings.ToLower(titleOf(p))
}

func (s *Service) nowMs() int64 { return s.now().UnixMilli() }

// parentDirs 返回路径的所有父目录（不含根）。
func parentDirs(p string) []string {
	var out []string
	for d := path.Dir(p); d != "." && d != "/" && d != ""; d = path.Dir(d) {
		out = append(out, d)
	}
	return out
}

// normalizeTarget 是 mdparse.NormalizeTarget 的别名，便于阅读。
var normalizeTarget = mdparse.NormalizeTarget

// escapeLike 转义 LIKE 中的通配符，配合 ESCAPE '\'。
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}
