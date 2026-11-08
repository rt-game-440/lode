// Package workspace 管理工作空间：每个工作空间是一个互相隔离的笔记库（vault、索引、回收站、变更推送），
// 由 Manager 统一登记、打开和关停。设计见 docs/workspaces.md 第 3、5 节。
//
// 默认工作空间（id = default）的索引在 app.db，vault 在 data/vault，和引入工作空间之前完全一样；
// 其他工作空间登记在 app.db 的 workspaces 表里（registry.go），文件在 data/workspaces/<id>/{index.db,vault,trash}，
// 第一次被访问时才打开，打开后保持到 Close。
// 之后的票在这里扩展：外部目录（#60）。助手对话按工作空间存放（#61）：非默认工作空间的 Chats 在自己的 index.db 里。
package workspace

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"github.com/rt-game-440/lode/server/internal/agent"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/tools"
)

// DefaultID 是默认工作空间的 id（保留，不能删除）。现有的 /api/... 路径都表示它。
const DefaultID = "default"

var (
	// ErrNotFound 表示没有这个工作空间。
	ErrNotFound = errors.New("workspace not found")
	// ErrInvalid 表示新建参数不合法（名称为空、过长等），错误信息去掉前缀后可以直接给用户看。
	ErrInvalid = errors.New("invalid workspace")
	// ErrClosed 表示 Manager 已经关闭，不再打开新的工作空间。
	ErrClosed = errors.New("workspace manager closed")
	// ErrNoRegistry 表示 Manager 没有登记表（Options.DB 为空），不能新建工作空间。
	ErrNoRegistry = errors.New("workspace registry not configured")
	// ErrProtected 表示默认工作空间不能删除。
	ErrProtected = errors.New("default workspace cannot be removed")
)

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
	// Chats 是本工作空间的助手对话库（对话、消息、待批准操作），在本工作空间自己的 index.db 里。
	// 默认工作空间为 nil：它的对话和供应商同在 app.db，用 agent.Store.DefaultChats()。
	// 用 AgentSpace 得到助手需要的依赖。
	Chats *agent.ChatStore

	db     *sql.DB            // 本工作空间的索引库，由 Manager 打开和关闭；默认工作空间为 nil（app.db 归调用方）
	cancel context.CancelFunc // 停止后台任务；未启动时为 nil
	bg     sync.WaitGroup
	gone   chan struct{} // 工作空间被删除（Remove）时关闭
}

// Gone 返回一个在工作空间被删除时关闭的通道，长连接据此退出。
func (w *Workspace) Gone() <-chan struct{} { return w.gone }

// Options 配置 Manager。
type Options struct {
	// Default 是默认工作空间的笔记服务（必填）。
	Default *notes.Service
	// DB 是全局库 app.db，工作空间登记表在这里。为 nil 时只有默认工作空间，不能新建
	// （兼容只传 Notes 的调用方，例如 api.Server 的旧写法）。
	DB *sql.DB
	// DataDir 是数据目录，其他工作空间放在 DataDir/workspaces/<id>/。DB 不为 nil 时必填。
	DataDir string
	Logger  *slog.Logger
	// Debounce 是文件监听的去抖时间，默认 DefaultDebounce。
	Debounce time.Duration
	// PruneInterval 是清理历史版本的间隔，默认 DefaultPruneInterval。
	PruneInterval time.Duration
	// Now 返回当前时间，默认 time.Now。
	Now func() time.Time
}

// Manager 管理工作空间的登记、打开和关停。可以并发使用。
type Manager struct {
	log      *slog.Logger
	debounce time.Duration
	prune    time.Duration
	global   *sql.DB
	dataDir  string
	now      func() time.Time

	adminMu sync.Mutex // 串行化 Create / Rename / Reorder / Remove（分配 id、排序、删除）

	mu       sync.Mutex
	open     map[string]*Workspace    // 已打开的工作空间
	opening  map[string]chan struct{} // 正在打开的工作空间，打开结束（成功或失败）时关闭
	removing map[string]bool          // 正在删除的工作空间，Get 视为不存在
	order    []string                 // 打开顺序，Opened 按它返回
	baseCtx  context.Context          // Start 之后非 nil；之后打开的工作空间用它启动后台任务
	closed   bool

	closeDBs sync.Once

	beforeRemove func(id string) // 见 SetBeforeRemove
}

// New 创建 Manager，默认工作空间立即可用（但后台任务要等 Start）。
func New(o Options) *Manager {
	if o.Default == nil {
		panic("workspace: Options.Default 不能为空")
	}
	if o.DB != nil && o.DataDir == "" {
		panic("workspace: 设置了 Options.DB 时 DataDir 不能为空")
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
	if o.Now == nil {
		o.Now = time.Now
	}
	m := &Manager{log: o.Logger, debounce: o.Debounce, prune: o.PruneInterval, global: o.DB, dataDir: o.DataDir, now: o.Now,
		open: map[string]*Workspace{}, opening: map[string]chan struct{}{}, removing: map[string]bool{}}
	m.add(newWorkspace(DefaultID, o.Default))
	return m
}

// AgentSpace 返回助手在本工作空间里工作所需的依赖。defaultChats 是默认工作空间的对话库
// （agent.Store.DefaultChats()），只在本工作空间是默认工作空间时使用。
func (w *Workspace) AgentSpace(defaultChats *agent.ChatStore) agent.Space {
	chats := w.Chats
	if w.ID == DefaultID || chats == nil {
		chats = defaultChats
	}
	return agent.Space{ID: w.ID, Chats: chats, Tools: w.Tools, Notes: w.Notes}
}

func newWorkspace(id string, svc *notes.Service) *Workspace {
	return &Workspace{ID: id, Notes: svc, Tools: tools.New(svc), gone: make(chan struct{})}
}

func (w *Workspace) closeDB() {
	if w.db != nil {
		w.db.Close()
	}
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

// Get 返回 id 对应的工作空间；没有登记时返回 ErrNotFound。
// 其他工作空间在第一次 Get 时打开（打开并迁移 index.db、构造笔记服务）：Start 之后打开的立即启动后台任务
// （先监听再全量对账），Start 之前打开的等 Start。打开后保持到 Close。并发的 Get 只打开一次。
func (m *Manager) Get(ctx context.Context, id string) (*Workspace, error) {
	for {
		m.mu.Lock()
		if w := m.open[id]; w != nil {
			m.mu.Unlock()
			return w, nil
		}
		if m.global == nil || !ValidID(id) || m.removing[id] {
			m.mu.Unlock()
			return nil, ErrNotFound
		}
		if m.closed {
			m.mu.Unlock()
			return nil, ErrClosed
		}
		if ch := m.opening[id]; ch != nil {
			m.mu.Unlock()
			select {
			case <-ch:
				continue // 别人打开完了（或失败了），重新看一次
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		ch := make(chan struct{})
		m.opening[id] = ch
		m.mu.Unlock()

		// 打开过程不受单个请求取消的影响，免得一个断开的请求连累并发等待的请求
		w, err := m.openWorkspace(context.WithoutCancel(ctx), id)

		m.mu.Lock()
		delete(m.opening, id)
		close(ch)
		if err == nil && m.closed {
			w.closeDB()
			err = ErrClosed
		}
		if err != nil {
			m.mu.Unlock()
			return nil, err
		}
		m.add(w)
		if m.baseCtx != nil {
			m.startLocked(w)
		}
		m.mu.Unlock()
		hook(id, "opened")
		return w, nil
	}
}

// IsOpen 判断工作空间 id 是否已经打开（不会触发打开）。
func (m *Manager) IsOpen(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.open[id] != nil
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

// Close 停止所有已打开工作空间的后台任务并等它们结束，再关闭 Manager 打开的索引库；
// 之后 Get 不再打开新的工作空间。调用方应在关闭 app.db 之前调用。可以重复调用。
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
	m.closeDBs.Do(func() {
		for _, w := range ws {
			w.closeDB()
		}
	})
}

// testHook 供测试观察工作空间的打开和后台任务：opened（按需打开完成）、watching（监听已建立）、reconcile（开始对账）、
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

// DataDir 返回数据目录。
func (m *Manager) DataDir() string { return m.dataDir }
