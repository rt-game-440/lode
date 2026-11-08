package workspace

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/rt-game-440/lode/server/internal/agent"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/vault"
)

// 工作空间登记表（app.db 的 workspaces 表，迁移 0006）和磁盘布局，见 docs/workspaces.md 第 3 节。

// DefaultName 是默认工作空间登记时的名称（迁移 0006 写入）。
const DefaultName = "笔记"

// DirName 是数据目录下存放其他工作空间的子目录名。
const DirName = "workspaces"

// MaxNameLen 是工作空间名称的最大长度（按字符计）。
const MaxNameLen = 64

// Paths 是一个工作空间在磁盘上的位置。
type Paths struct {
	Root  string // 工作空间自己的目录：默认工作空间是数据目录本身，其他是 data/workspaces/<id>
	Index string // 索引库：默认工作空间是 app.db，其他是 <Root>/index.db
	Vault string // 笔记文件
	Trash string // 回收站
}

// PathsFor 返回工作空间 id 在数据目录 dataDir 下的位置。vaultDir 是登记表里的 vault_dir：
// 空表示内置位置，否则是外部目录的绝对路径（这时 index.db 和 trash 仍在 Root 下）。
func PathsFor(dataDir, id, vaultDir string) Paths {
	if id == DefaultID {
		return Paths{Root: dataDir, Index: filepath.Join(dataDir, "app.db"),
			Vault: filepath.Join(dataDir, "vault"), Trash: filepath.Join(dataDir, "trash")}
	}
	root := filepath.Join(dataDir, DirName, id)
	p := Paths{Root: root, Index: filepath.Join(root, "index.db"),
		Vault: filepath.Join(root, "vault"), Trash: filepath.Join(root, "trash")}
	if vaultDir != "" {
		p.Vault = vaultDir
	}
	return p
}

// ValidID 判断 id 是否是合法的工作空间 id 格式：1～32 个小写字母或数字（default 也符合）。
func ValidID(id string) bool {
	if id == "" || len(id) > 32 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') {
			return false
		}
	}
	return true
}

// Info 是登记表里的一个工作空间，GET /api/workspaces 直接返回它。
type Info struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	External bool   `json:"external"`
	// VaultDir 只对外部目录返回（内置位置不暴露服务器上的路径）。
	VaultDir string `json:"vault_dir,omitempty"`
	// Path 是笔记文件所在位置，给设置页展示：内置位置是相对数据目录的路径（默认工作空间是 vault，
	// 其他是 workspaces/<id>/vault），外部目录是绝对路径。
	Path      string `json:"path"`
	Sort      int    `json:"sort"`
	CreatedAt int64  `json:"created_at"` // unix 毫秒
	// NoteCount 是索引里的笔记数。没打开的工作空间读的是上次打开时的索引，打开并对账后才准确。
	NoteCount int `json:"note_count"`
}

// CreateOptions 是新建工作空间的参数。
type CreateOptions struct {
	Name string
	// VaultDir 非空时把这个已有的绝对路径目录作为笔记目录（外部目录，规则见 CheckVaultDir）；
	// 为空则在 data/workspaces/<id>/vault 下新建。
	VaultDir string
}

// List 按排序返回所有登记的工作空间，不会打开它们。没有登记表时只返回默认工作空间。
func (m *Manager) List(ctx context.Context) ([]Info, error) {
	if m.global == nil {
		n, err := m.Default().Notes.NoteCount(ctx)
		if err != nil {
			return nil, err
		}
		return []Info{{ID: DefaultID, Name: DefaultName, Path: displayPath(DefaultID, ""), NoteCount: n}}, nil
	}
	rows, err := m.global.QueryContext(ctx, `SELECT id, name, vault_dir, sort, created_at FROM workspaces ORDER BY sort, created_at, id`)
	if err != nil {
		return nil, err
	}
	var out []Info
	for rows.Next() {
		var in Info
		var vaultDir string
		if err := rows.Scan(&in.ID, &in.Name, &vaultDir, &in.Sort, &in.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		if vaultDir != "" && in.ID != DefaultID {
			in.External, in.VaultDir = true, vaultDir
		}
		in.Path = displayPath(in.ID, in.VaultDir)
		out = append(out, in)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].NoteCount, err = m.noteCount(ctx, out[i].ID, out[i].VaultDir); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// displayPath 返回 Info.Path。
func displayPath(id, vaultDir string) string {
	switch {
	case vaultDir != "":
		return vaultDir
	case id == DefaultID:
		return "vault"
	}
	return DirName + "/" + id + "/vault"
}

// noteCount 返回工作空间索引里的笔记数。已打开的直接查；没打开的临时连上它的 index.db 查一次
// （不迁移、不启动后台任务、不算打开），索引库还不存在或读不了时为 0。
func (m *Manager) noteCount(ctx context.Context, id, vaultDir string) (int, error) {
	m.mu.Lock()
	w := m.open[id]
	m.mu.Unlock()
	if w != nil {
		return w.Notes.NoteCount(ctx)
	}
	p := PathsFor(m.dataDir, id, vaultDir)
	if _, err := os.Stat(p.Index); err != nil {
		return 0, nil
	}
	d, err := db.Connect(ctx, p.Index)
	if err != nil {
		return 0, nil
	}
	defer d.Close()
	var n int
	if err := d.QueryRowContext(ctx, `SELECT count(*) FROM notes`).Scan(&n); err != nil {
		return 0, nil // 不完整的索引库：打开时会迁移和对账，这里不报错
	}
	return n, nil
}

// Create 新建工作空间：在 data/workspaces/<id>/ 下建好 vault、trash 和迁移到最新的 index.db，
// 再写入登记表（排在最后）。新工作空间不会被打开，第一次 Get 时才打开。
// 指定了 VaultDir 时笔记目录是外部目录：校验通过后只在 data/workspaces/<id>/ 下建 trash 和 index.db，
// 不在外部目录里创建或写入任何东西。
func (m *Manager) Create(ctx context.Context, o CreateOptions) (Info, error) {
	if m.global == nil {
		return Info{}, ErrNoRegistry
	}
	name, err := cleanName(o.Name)
	if err != nil {
		return Info{}, err
	}
	m.adminMu.Lock()
	defer m.adminMu.Unlock()
	id, err := m.newID(ctx)
	if err != nil {
		return Info{}, err
	}
	vaultDir := ""
	if strings.TrimSpace(o.VaultDir) != "" {
		if vaultDir, err = m.checkVaultDirLocked(ctx, o.VaultDir); err != nil {
			return Info{}, err
		}
	}
	p := PathsFor(m.dataDir, id, vaultDir)
	cleanup := func() { os.RemoveAll(p.Root) } // 只清 data/workspaces/<id>/，不碰外部目录
	dirs := []string{p.Trash}
	if vaultDir == "" {
		dirs = append(dirs, p.Vault)
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			cleanup()
			return Info{}, err
		}
	}
	// 先建好并迁移索引库，出错时不登记
	d, err := db.Open(ctx, p.Index)
	if err != nil {
		cleanup()
		return Info{}, fmt.Errorf("创建工作空间的索引库: %w", err)
	}
	if err := d.Close(); err != nil {
		cleanup()
		return Info{}, err
	}
	in := Info{ID: id, Name: name, CreatedAt: m.now().UnixMilli(), Path: displayPath(id, vaultDir)}
	if vaultDir != "" {
		in.External, in.VaultDir = true, vaultDir
	}
	err = m.global.QueryRowContext(ctx,
		`INSERT INTO workspaces(id, name, vault_dir, sort, created_at)
		 SELECT ?, ?, ?, COALESCE(MAX(sort), 0) + 1, ? FROM workspaces
		 RETURNING sort`, id, name, vaultDir, in.CreatedAt).Scan(&in.Sort)
	if err != nil {
		cleanup()
		return Info{}, err
	}
	m.log.Info("已新建工作空间", "workspace", id, "external", vaultDir != "")
	return in, nil
}

// cleanName 校验并整理工作空间名称。
func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", fmt.Errorf("%w: 名称不能为空", ErrInvalid)
	case !utf8.ValidString(name):
		return "", fmt.Errorf("%w: 名称不是合法的 UTF-8", ErrInvalid)
	case utf8.RuneCountInString(name) > MaxNameLen:
		return "", fmt.Errorf("%w: 名称不能超过 %d 个字符", ErrInvalid, MaxNameLen)
	case strings.IndexFunc(name, unicode.IsControl) >= 0:
		return "", fmt.Errorf("%w: 名称不能包含控制字符", ErrInvalid)
	}
	return name, nil
}

// 新工作空间 id 的形式：6 个小写字母或数字（约 21 亿种）。
const (
	idAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	idLen      = 6
)

// newID 生成一个没有登记、目录也不存在的 id。调用方持有 adminMu。
func (m *Manager) newID(ctx context.Context) (string, error) {
	for range 16 {
		b := make([]byte, idLen)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		for i := range b {
			b[i] = idAlphabet[int(b[i])%len(idAlphabet)]
		}
		id := string(b)
		if id == DefaultID {
			continue
		}
		var n int
		if err := m.global.QueryRowContext(ctx, `SELECT count(*) FROM workspaces WHERE id = ?`, id).Scan(&n); err != nil {
			return "", err
		}
		if n > 0 {
			continue
		}
		// 目录已存在（例如以前留下的）也不用
		if _, err := os.Lstat(PathsFor(m.dataDir, id, "").Root); !errors.Is(err, os.ErrNotExist) {
			continue
		}
		return id, nil
	}
	return "", errors.New("无法生成不重复的工作空间 id")
}

// openWorkspace 按登记表打开工作空间 id（不是默认工作空间）：打开并迁移索引库、构造笔记服务。
// 不启动后台任务。
func (m *Manager) openWorkspace(ctx context.Context, id string) (*Workspace, error) {
	var vaultDir string
	err := m.global.QueryRowContext(ctx, `SELECT vault_dir FROM workspaces WHERE id = ?`, id).Scan(&vaultDir)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	p := PathsFor(m.dataDir, id, vaultDir)
	if vaultDir != "" {
		// 外部目录不存在时不要代为创建（卷没挂载时会得到一个空库，对账会把索引里的笔记全清掉）
		if err := checkVaultPresent(vaultDir); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(p.Root, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(p.Trash, 0o755); err != nil {
		return nil, err
	}
	d, err := db.Open(ctx, p.Index)
	if err != nil {
		return nil, fmt.Errorf("打开工作空间 %s 的索引库: %w", id, err)
	}
	v, err := vault.New(p.Vault)
	if err != nil {
		d.Close()
		return nil, err
	}
	log := m.log.With("workspace", id)
	w := newWorkspace(id, notes.New(notes.Options{DB: d, Vault: v, TrashDir: p.Trash, Logger: log}))
	w.db = d
	w.Chats = agent.NewChatStore(d)
	log.Info("已打开工作空间")
	return w, nil
}
