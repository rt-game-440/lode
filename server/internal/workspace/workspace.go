// Package workspace 管理工作空间：每个工作空间是一个互相隔离的笔记库（vault、索引、回收站、变更推送），
// 由 Manager 统一打开和关停。设计见 docs/workspaces.md 第 5 节。
//
// 目前（#56）只有默认工作空间：它的索引在 app.db，vault 在 data/vault，和引入工作空间之前完全一样。
// 之后的票在这里扩展：按需打开其他工作空间（#57）、每个工作空间的助手对话（#61）。
package workspace

import (
	"context"
	"errors"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/tools"
)

// DefaultID 是默认工作空间的 id（保留，不能删除）。现有的 /api/... 路径都表示它。
const DefaultID = "default"

// ErrNotFound 表示没有这个工作空间。
var ErrNotFound = errors.New("workspace not found")

// 后台任务的默认参数。
const (
	DefaultDebounce      = 300 * time.Millisecond
	DefaultPruneInterval = time.Hour
)

// Workspace 是一个已打开的工作空间。字段在打开后不再改变，可以并发读取。
type Workspace struct {
	ID    string
	Notes *notes.Service
	// Tools 是绑定到本工作空间笔记的工具注册表，助手和 MCP 共用。
	Tools *tools.Registry

	cancel context.CancelFunc // 停止后台任务；未启动时为 nil
	bg     sync.WaitGroup
}

// Options 配置 Manager。
type Options struct {
	// Default 是默认工作空间的笔记服务（必填）。
	Default *notes.Service
	Logger  *slog.Logger
	// Debounce 是文件监听的去抖时间，默认 DefaultDebounce。
	Debounce time.Duration
	// PruneInterval 是清理历史版本的间隔，默认 DefaultPruneInterval。
	PruneInterval time.Duration
}

// Manager 管理工作空间的打开和关停。可以并发使用。
type Manager struct {
	log      *slog.Logger
	debounce time.Duration
	prune    time.Duration

	mu      sync.Mutex
	open    map[string]*Workspace // 已打开的工作空间
	order   []string              // 打开顺序，Opened 按它返回
	baseCtx context.Context       // Start 之后非 nil；之后打开的工作空间用它启动后台任务
	closed  bool
}

// New 创建 Manager，默认工作空间立即可用（但后台任务要等 Start）。
func New(o Options) *Manager {
	if o.Default == nil {
		panic("workspace: Options.Default 不能为空")
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.Debounce <= 0 {
		o.Debounce = DefaultDebounce
	}
	if o.PruneInterval <= 0 {
		o.PruneInterval = DefaultPruneInterval
	}
	m := &Manager{log: o.Logger, debounce: o.Debounce, prune: o.PruneInterval, open: map[string]*Workspace{}}
	m.add(newWorkspace(DefaultID, o.Default))
	return m
}

func newWorkspace(id string, svc *notes.Service) *Workspace {
	return &Workspace{ID: id, Notes: svc, Tools: tools.New(svc)}
}

func (m *Manager) add(w *Workspace) {
	m.open[w.ID] = w
	m.order = append(m.order, w.ID)
}

// Default 返回默认工作空间。
func (m *Manager) Default() *Workspace {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.open[DefaultID]
}

// Get 返回 id 对应的工作空间；不存在时返回 ErrNotFound。
// 以后（#57）其他工作空间在第一次 Get 时打开：打开库、迁移、启动后台任务（先监听再对账）。
func (m *Manager) Get(ctx context.Context, id string) (*Workspace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if w := m.open[id]; w != nil {
		return w, nil
	}
	return nil, ErrNotFound
}

// Opened 按打开顺序返回所有已打开的工作空间。
func (m *Manager) Opened() []*Workspace {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Workspace, 0, len(m.order))
	for _, id := range m.order {
		out = append(out, m.open[id])
	}
	return out
}

// Start 启动已打开工作空间的后台任务（文件监听、启动对账、定期清理历史版本），立即返回。
// 后台任务随 ctx 取消或 Close 结束。只能调用一次。
func (m *Manager) Start(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.baseCtx != nil || m.closed {
		return
	}
	m.baseCtx = ctx
	for _, id := range m.order {
		m.startLocked(m.open[id])
	}
}

// Close 停止所有工作空间的后台任务并等它们结束。调用方应在关闭数据库之前调用。可以重复调用。
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	ws := make([]*Workspace, 0, len(m.order))
	for _, id := range m.order {
		ws = append(ws, m.open[id])
	}
	m.mu.Unlock()
	for _, w := range ws {
		if w.cancel != nil {
			w.cancel()
		}
	}
	for _, w := range ws {
		w.bg.Wait()
	}
}

// testHook 供测试观察后台任务的顺序：watching（监听已建立）、reconcile（开始对账）、
// ready（对账完成）、stopped（某个后台任务退出）。
var testHook func(id, event string)

func hook(id, event string) {
	if testHook != nil {
		testHook(id, event)
	}
}

// startLocked 启动 w 的后台任务：先建立文件监听，再全量对账（中间的外部修改由监听事件补上）；
// 另有一个任务定期清理历史版本。调用方持有 m.mu。
func (m *Manager) startLocked(w *Workspace) {
	ctx, cancel := context.WithCancel(m.baseCtx)
	w.cancel = cancel
	log := m.log.With("workspace", w.ID)
	svc := w.Notes
	watching := make(chan struct{})
	w.bg.Go(func() {
		defer hook(w.ID, "stopped")
		var once sync.Once
		markReady := func() {
			once.Do(func() {
				hook(w.ID, "watching")
				close(watching)
			})
		}
		defer markReady() // 监听启动失败时也不要阻塞对账
		if err := svc.Watch(ctx, m.debounce, markReady); err != nil {
			log.Error("文件监听失败", "err", err)
		}
	})
	w.bg.Go(func() {
		defer hook(w.ID, "stopped")
		select {
		case <-watching:
		case <-ctx.Done():
			return
		}
		hook(w.ID, "reconcile")
		start := time.Now()
		st, err := svc.Reconcile(ctx)
		if err != nil {
			if ctx.Err() == nil {
				log.Error("启动对账失败", "err", err)
			}
			return
		}
		log.Info("索引就绪", "added", st.Added, "updated", st.Updated, "moved", st.Moved, "removed", st.Removed, "dur", time.Since(start).Round(time.Millisecond))
		hook(w.ID, "ready")
		debug.FreeOSMemory()
	})
	w.bg.Go(func() {
		defer hook(w.ID, "stopped")
		ticker := time.NewTicker(m.prune)
		defer ticker.Stop()
		prune := func() {
			if st, err := svc.PruneHistory(ctx); err != nil {
				if ctx.Err() == nil {
					log.Error("清理历史版本失败", "err", err)
				}
			} else if st.Versions+st.Changes > 0 {
				log.Info("已清理历史", "versions", st.Versions, "changes", st.Changes)
			}
		}
		prune()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				prune()
			}
		}
	})
}

type ctxKey struct{}

// WithContext 把当前请求的工作空间放进 context。
func WithContext(ctx context.Context, w *Workspace) context.Context {
	return context.WithValue(ctx, ctxKey{}, w)
}

// FromContext 取出 WithContext 放进去的工作空间；没有时返回 nil。
func FromContext(ctx context.Context) *Workspace {
	w, _ := ctx.Value(ctxKey{}).(*Workspace)
	return w
}
