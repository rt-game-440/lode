package ops

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/workspace"
)

// RestoreOptions 是恢复选项。
type RestoreOptions struct {
	// ExternalTo 非空时，备份里的外部目录工作空间不恢复到原路径，而是恢复到这个目录下以工作空间 id 命名的
	// 子目录（<ExternalTo>/<id>），登记的路径随之更新。必须是绝对路径。
	ExternalTo string
}

// Result 是恢复的结果。
type Result struct {
	Kept       string           // 原有数据保存的 pre-restore-<时间>/ 目录，没有原有数据时为空
	Scope      string           // ScopeAll 或 ScopeWorkspace
	Workspaces []WorkspaceEntry // 恢复了哪些工作空间；外部目录的 VaultDir 是实际恢复到的位置
}

// ErrExternalNotEmpty 表示外部工作空间要恢复到的目录已存在且不是空的（不会覆盖用户的文件）。
var ErrExternalNotEmpty = errors.New("外部笔记目录已存在且不是空的")

// ExternalTarget 返回外部目录工作空间 e 恢复后所在的位置：默认是备份里记录的原路径，
// 指定 externalTo 时是 <externalTo>/<id>。
func ExternalTarget(e WorkspaceEntry, externalTo string) string {
	if externalTo == "" {
		return e.VaultDir
	}
	return filepath.Join(externalTo, e.ID)
}

// defaultIndexTables 是 app.db 里属于默认工作空间（笔记索引和助手对话）的表，按插入顺序（先父后子）；
// 其余表（设置、会话、通行密钥、token、审计、供应商、工作空间登记等）是全局数据。
// 单空间备份恢复默认工作空间时只替换这些表，TestDefaultIndexTablesCoverSchema 保证新增表时不会漏分类。
var defaultIndexTables = []string{"notes", "notes_fts", "links", "tags", "folders", "versions", "changes", "trash",
	"agent_chats", "agent_messages", "agent_pending"}

// 默认工作空间在 settings 表里的键（历史清理到的变更序号，见 notes 包）。
const changesFloorKey = "changes_floor"

// Restore 用备份替换数据目录里的数据，必须在服务停止时执行（否则返回 ErrLocked）。
// 原有数据移到 dataDir/pre-restore-<时间>/ 并返回该路径（没有原有数据时返回空串）。
// 备份文件无效时不改动数据目录。外部目录的处理见 RestoreArchive。
func Restore(ctx context.Context, dataDir, archive string, opts ...RestoreOptions) (string, error) {
	var opt RestoreOptions
	if len(opts) > 0 {
		opt = opts[0]
	}
	res, err := RestoreArchive(ctx, dataDir, archive, opt)
	return res.Kept, err
}

// RestoreArchive 恢复备份并返回详细结果。
//
//   - 完整备份（scope=all，包括阶段 6 的旧格式）：替换数据库、默认工作空间、data/workspaces/ 和登记表，
//     备份没有的工作空间不再登记（它们的内置目录随 workspaces/ 一起保留在 pre-restore 里）。
//     外部目录的笔记恢复到原路径；原路径已存在且非空时拒绝恢复（ErrExternalNotEmpty），用 opts.ExternalTo 指定新位置。
//     现有的、不在备份里的外部目录不会被改动。
//   - 单空间备份（scope=workspace）：只替换这一个工作空间，其他空间、全局数据和 secret.key 都不动。
//     已登记的空间沿用现在的登记路径；没有登记的会新登记（排在最后），必须是已有数据库的数据目录。
func RestoreArchive(ctx context.Context, dataDir, archive string, opt RestoreOptions) (Result, error) {
	unlock, err := Lock(dataDir)
	if err != nil && !errors.Is(err, ErrLockUnsupported) {
		return Result{}, err
	}
	defer unlock()
	if opt.ExternalTo != "" && !filepath.IsAbs(opt.ExternalTo) {
		return Result{}, fmt.Errorf("--external-to 必须是绝对路径：%s", opt.ExternalTo)
	}

	staging, err := os.MkdirTemp(dataDir, ".restore-*")
	if err != nil {
		return Result{}, err
	}
	defer os.RemoveAll(staging)
	m, err := extract(ctx, archive, staging)
	if err != nil {
		return Result{}, fmt.Errorf("读取备份: %w", err)
	}
	if m.DBVersion > db.LatestVersion() {
		return Result{}, fmt.Errorf("备份来自更新的 Lode（%s，数据库版本 %d），当前程序只支持到 %d，请先升级", m.Version, m.DBVersion, db.LatestVersion())
	}
	if err := checkEntries(m); err != nil {
		return Result{}, err
	}
	if m.ScopeOrAll() == ScopeWorkspace {
		return restoreOne(ctx, dataDir, staging, m, opt)
	}
	return restoreAll(ctx, dataDir, staging, m, opt)
}

// checkEntries 校验清单里的工作空间：id 合法且不重复；完整备份必须有默认空间；单空间备份恰好一个。
func checkEntries(m Manifest) error {
	seen := map[string]bool{}
	for _, e := range m.Entries() {
		if !workspace.ValidID(e.ID) {
			return fmt.Errorf("备份清单里有不合法的工作空间 id: %q", e.ID)
		}
		if seen[e.ID] {
			return fmt.Errorf("备份清单里的工作空间 id 重复: %q", e.ID)
		}
		seen[e.ID] = true
		if e.External && e.ID == workspace.DefaultID {
			return errors.New("备份清单有误：默认工作空间不能是外部目录")
		}
	}
	if m.ScopeOrAll() == ScopeWorkspace {
		if len(m.Workspaces) != 1 {
			return errors.New("单个工作空间的备份清单里必须恰好有一个工作空间")
		}
		return nil
	}
	if !seen[workspace.DefaultID] {
		return errors.New("备份清单里没有默认工作空间")
	}
	return nil
}

// checkStagedWorkspace 校验解包后的非默认工作空间：vault 目录在，索引库完好且不比当前程序新。
func checkStagedWorkspace(ctx context.Context, staging string, e WorkspaceEntry) error {
	root := filepath.Join(staging, wsDirName, e.ID)
	if st, err := os.Stat(filepath.Join(root, "vault")); err != nil || !st.IsDir() {
		return fmt.Errorf("备份不完整：没有工作空间 %s 的 vault 目录", e.ID)
	}
	idx := filepath.Join(root, indexName)
	if _, err := os.Stat(idx); err != nil {
		return nil // 备份时还没打开过，恢复后重新对账
	}
	if err := checkDB(ctx, idx); err != nil {
		return fmt.Errorf("备份里工作空间 %s 的索引库无效: %w", e.ID, err)
	}
	if v, err := dbVersion(ctx, idx); err != nil || v > db.LatestVersion() {
		return fmt.Errorf("备份里工作空间 %s 的索引库来自更新的 Lode，请先升级", e.ID)
	}
	return nil
}

func restoreAll(ctx context.Context, dataDir, staging string, m Manifest, opt RestoreOptions) (Result, error) {
	res := Result{Scope: ScopeAll}
	stagedDB := filepath.Join(staging, dbName)
	if err := checkDB(ctx, stagedDB); err != nil {
		return res, fmt.Errorf("备份里的数据库无效: %w", err)
	}
	if st, err := os.Stat(filepath.Join(staging, "vault")); err != nil || !st.IsDir() {
		return res, errors.New("备份不完整：没有 vault/ 目录")
	}
	entries := m.Entries()
	for _, e := range entries {
		if e.ID != workspace.DefaultID {
			if err := checkStagedWorkspace(ctx, staging, e); err != nil {
				return res, err
			}
		}
	}
	if len(m.Workspaces) > 0 {
		// 清单必须和打包的 app.db 里的登记表一致
		d, err := openRO(stagedDB)
		if err != nil {
			return res, err
		}
		reg, err := listWorkspaces(ctx, d)
		d.Close()
		if err != nil {
			return res, err
		}
		if err := sameRegistry(entries, reg); err != nil {
			return res, err
		}
	}

	dests, err := planExternal(dataDir, entries, opt.ExternalTo, nil)
	if err != nil {
		return res, err
	}
	changed := map[string]string{}
	for _, e := range entries {
		if e.External && dests[e.ID] != e.VaultDir {
			changed[e.ID] = dests[e.ID]
		}
	}
	if len(changed) > 0 {
		if err := setVaultDirs(ctx, stagedDB, changed); err != nil {
			return res, fmt.Errorf("更新登记的外部目录路径: %w", err)
		}
	}

	t := newTxn(dataDir, staging)
	// 外部目录先放到位（数据目录里的替换失败时一并回滚）
	for _, e := range entries {
		if !e.External {
			continue
		}
		src := filepath.Join(staging, wsDirName, e.ID, "vault")
		if err := t.placeExternal(src, dests[e.ID]); err != nil {
			return t.rollbackResult(res, fmt.Errorf("恢复工作空间 %s 的笔记到 %s: %w", e.ID, dests[e.ID], err))
		}
		os.RemoveAll(src) // 复制过去的情况下，临时区里的那份不要再放进 workspaces/<id>/
	}

	asideNames := []string{dbName + "-wal", dbName + "-shm"}
	placeNames := []string{dbName, "vault", "trash", wsDirName}
	if _, err := os.Stat(filepath.Join(staging, secretName)); err == nil {
		placeNames = append(placeNames, secretName) // 备份带了主密钥才替换现有的
	} else if protectedDB(ctx, stagedDB) {
		// 备份里的 API key 由通行密钥保护（#29）：现有的 secret.key 对它没用，启动时还会被当作残留删除，
		// 所以和原有数据一起移走保留
		asideNames = append(asideNames, secretName)
	}
	for _, name := range append(asideNames, placeNames...) {
		if err := t.aside(name); err != nil {
			return t.rollbackResult(res, fmt.Errorf("移走原有的 %s: %w", name, err))
		}
	}
	for _, name := range placeNames {
		if err := t.place(name); err != nil {
			return t.rollbackResult(res, fmt.Errorf("放入 %s: %w", name, err))
		}
	}
	res.Kept = t.keptDir()
	res.Workspaces = resolved(entries, dests)
	return res, nil
}

func restoreOne(ctx context.Context, dataDir, staging string, m Manifest, opt RestoreOptions) (Result, error) {
	res := Result{Scope: ScopeWorkspace}
	e := m.Workspaces[0]
	livePath := filepath.Join(dataDir, dbName)
	if _, err := os.Stat(livePath); err != nil {
		return res, errors.New("数据目录里没有数据库：单个工作空间的备份只能恢复到已有的 Lode 数据目录（先启动一次 Lode，或先恢复一份完整备份）")
	}
	live, err := db.Open(ctx, livePath)
	if err != nil {
		return res, err
	}
	defer live.Close()
	reg, err := listWorkspaces(ctx, live)
	if err != nil {
		return res, err
	}
	var cur *WorkspaceEntry
	for i := range reg {
		if reg[i].ID == e.ID {
			cur = &reg[i]
		}
	}
	t := newTxn(dataDir, staging)

	if e.ID == workspace.DefaultID {
		if opt.ExternalTo != "" {
			return res, errors.New("默认工作空间的笔记在数据目录里，--external-to 不适用")
		}
		stagedDB := filepath.Join(staging, dbName)
		if err := checkDB(ctx, stagedDB); err != nil {
			return res, fmt.Errorf("备份里的数据库无效: %w", err)
		}
		if st, err := os.Stat(filepath.Join(staging, "vault")); err != nil || !st.IsDir() {
			return res, errors.New("备份不完整：没有 vault/ 目录")
		}
		sdb, err := db.Open(ctx, stagedDB) // 比当前旧的备份先升级到当前版本（只改临时区里的副本）
		if err != nil {
			return res, fmt.Errorf("备份里的数据库无法升级: %w", err)
		}
		sdb.Close()
		// 默认工作空间的索引和全局数据在同一个 app.db 里：把现有的整库快照留一份，再只替换属于它的表
		if err := t.mkKept(); err != nil {
			return res, err
		}
		if err := db.Snapshot(ctx, live, filepath.Join(t.kept, dbName)); err != nil {
			return t.rollbackResult(res, fmt.Errorf("保留现有数据库的快照: %w", err))
		}
		t.undo = append(t.undo, func() error { return os.Remove(filepath.Join(t.kept, dbName)) })
		for _, name := range []string{"vault", "trash"} {
			if err := t.aside(name); err != nil {
				return t.rollbackResult(res, fmt.Errorf("移走原有的 %s: %w", name, err))
			}
		}
		for _, name := range []string{"vault", "trash"} {
			if err := t.place(name); err != nil {
				return t.rollbackResult(res, fmt.Errorf("放入 %s: %w", name, err))
			}
		}
		if err := replaceDefaultIndex(ctx, live, stagedDB); err != nil {
			return t.rollbackResult(res, fmt.Errorf("替换默认工作空间的索引: %w", err))
		}
		res.Kept = t.keptDir()
		res.Workspaces = []WorkspaceEntry{e}
		return res, nil
	}

	if err := checkStagedWorkspace(ctx, staging, e); err != nil {
		return res, err
	}
	// 笔记放哪里：已登记的空间沿用现在的登记（内置还是外部、路径），没登记的按备份里的
	external, base := e.External, e.VaultDir
	if cur != nil {
		external, base = cur.External, cur.VaultDir
	}
	dest := ""
	if external {
		var others []string
		for _, r := range reg {
			if r.ID != e.ID && r.External {
				others = append(others, r.VaultDir)
			}
		}
		ent := e
		ent.External, ent.VaultDir = true, base
		dests, err := planExternal(dataDir, []WorkspaceEntry{ent}, opt.ExternalTo, others)
		if err != nil {
			return res, err
		}
		dest = dests[e.ID]
	} else if opt.ExternalTo != "" {
		return res, errors.New("这个工作空间的笔记在数据目录里，--external-to 不适用")
	}

	rel := wsDirName + "/" + e.ID
	if err := os.MkdirAll(filepath.Join(dataDir, filepath.FromSlash(rel)), 0o755); err != nil {
		return res, err
	}
	if external {
		src := filepath.Join(staging, wsDirName, e.ID, "vault")
		if err := t.placeExternal(src, dest); err != nil {
			return t.rollbackResult(res, fmt.Errorf("恢复笔记到 %s: %w", dest, err))
		}
		os.RemoveAll(src)
	}
	names := []string{rel + "/" + indexName + "-wal", rel + "/" + indexName + "-shm", rel + "/" + indexName, rel + "/trash"}
	places := []string{rel + "/" + indexName, rel + "/trash"}
	if !external {
		names = append(names, rel+"/vault")
		places = append(places, rel+"/vault")
	}
	for _, name := range names {
		if err := t.aside(name); err != nil {
			return t.rollbackResult(res, fmt.Errorf("移走原有的 %s: %w", name, err))
		}
	}
	for _, name := range places {
		if err := t.place(name); err != nil {
			return t.rollbackResult(res, fmt.Errorf("放入 %s: %w", name, err))
		}
	}
	// 登记：新空间追加到最后；已登记且笔记目录换了位置时更新路径
	vaultDir := ""
	if external {
		vaultDir = dest
	}
	switch {
	case cur == nil:
		err = registerWorkspace(ctx, live, e, vaultDir)
	case external && dest != cur.VaultDir:
		_, err = live.ExecContext(ctx, `UPDATE workspaces SET vault_dir = ? WHERE id = ?`, dest, e.ID)
	}
	if err != nil {
		return t.rollbackResult(res, fmt.Errorf("更新工作空间登记: %w", err))
	}
	res.Kept = t.keptDir()
	out := e
	out.External, out.VaultDir = external, vaultDir
	if cur != nil {
		out.Name = cur.Name
	}
	res.Workspaces = []WorkspaceEntry{out}
	return res, nil
}

func resolved(entries []WorkspaceEntry, dests map[string]string) []WorkspaceEntry {
	out := make([]WorkspaceEntry, len(entries))
	copy(out, entries)
	for i := range out {
		if out[i].External {
			out[i].VaultDir = dests[out[i].ID]
		}
	}
	return out
}

// sameRegistry 比较清单和打包的 app.db 里的登记表（id、是否外部、路径）。
func sameRegistry(manifest, registry []WorkspaceEntry) error {
	byID := map[string]WorkspaceEntry{}
	for _, r := range registry {
		byID[r.ID] = r
	}
	if len(byID) != len(manifest) {
		return errors.New("备份清单与数据库里的工作空间登记不一致")
	}
	for _, e := range manifest {
		r, ok := byID[e.ID]
		if !ok || r.External != e.External || r.VaultDir != e.VaultDir {
			return fmt.Errorf("备份清单与数据库里的工作空间登记不一致（%s）", e.ID)
		}
	}
	return nil
}

// planExternal 确定外部目录工作空间恢复到哪里并逐个校验，返回 id → 目标路径。
// entries 里 VaultDir 是默认位置（备份记录的原路径，或已登记的路径）；override 非空时改为 <override>/<id>。
// others 是已登记的其他外部目录（不能与目标相同或嵌套）。目标已存在且非空时返回 ErrExternalNotEmpty。
func planExternal(dataDir string, entries []WorkspaceEntry, override string, others []string) (map[string]string, error) {
	dests := map[string]string{}
	taken := append([]string(nil), others...)
	for _, e := range entries {
		if !e.External {
			continue
		}
		dest := ExternalTarget(e, override)
		if err := checkDest(dataDir, e, dest, taken); err != nil {
			return nil, err
		}
		dests[e.ID] = filepath.Clean(dest)
		taken = append(taken, dest)
	}
	if override != "" && len(dests) == 0 {
		return nil, errors.New("备份里没有外部目录的工作空间，--external-to 不适用")
	}
	return dests, nil
}

func checkDest(dataDir string, e WorkspaceEntry, dest string, taken []string) error {
	if !filepath.IsAbs(dest) {
		return fmt.Errorf("工作空间「%s」记录的笔记目录 %q 不是绝对路径，请用 --external-to 指定恢复位置", e.Name, dest)
	}
	dest = filepath.Clean(dest)
	if filepath.Dir(dest) == dest {
		return fmt.Errorf("工作空间「%s」的笔记目录不能是根目录，请用 --external-to 指定恢复位置", e.Name)
	}
	data, err := filepath.Abs(dataDir)
	if err != nil {
		return err
	}
	if r, err := filepath.EvalSymlinks(data); err == nil {
		data = r
	}
	cmp := dest
	if r, err := filepath.EvalSymlinks(dest); err == nil {
		cmp = r
	}
	switch {
	case workspace.SamePath(data, cmp), workspace.Within(data, cmp), workspace.Within(cmp, data):
		return fmt.Errorf("工作空间「%s」的笔记目录 %s 与 Lode 数据目录重叠，请用 --external-to 指定恢复位置", e.Name, dest)
	}
	for _, o := range taken {
		if workspace.SamePath(o, cmp) || workspace.Within(o, cmp) || workspace.Within(cmp, o) {
			return fmt.Errorf("工作空间「%s」的笔记目录 %s 与另一个工作空间的笔记目录相同或互相嵌套，请用 --external-to 指定恢复位置", e.Name, dest)
		}
	}
	st, err := os.Stat(dest)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil
	case err != nil:
		return err
	case !st.IsDir():
		return fmt.Errorf("%w：工作空间「%s」的笔记目录 %s 是一个文件", ErrExternalNotEmpty, e.Name, dest)
	}
	list, err := os.ReadDir(dest)
	if err != nil {
		return err
	}
	if len(list) > 0 {
		return fmt.Errorf("%w：工作空间「%s」的笔记目录 %s 已存在且不是空的，不会覆盖。请清空它，或用 --external-to <目录> 恢复到新位置"+
			"（每个外部工作空间会放进该目录下以 id 命名的子目录，登记的路径随之更新）", ErrExternalNotEmpty, e.Name, dest)
	}
	return nil
}

// setVaultDirs 改解包后的 app.db 里登记的外部目录路径。
func setVaultDirs(ctx context.Context, dbPath string, dirs map[string]string) error {
	d, err := db.Connect(ctx, dbPath)
	if err != nil {
		return err
	}
	defer d.Close()
	for id, dir := range dirs {
		res, err := d.ExecContext(ctx, `UPDATE workspaces SET vault_dir = ? WHERE id = ?`, dir, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return fmt.Errorf("数据库里没有工作空间 %s 的登记", id)
		}
	}
	_, err = d.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`)
	return err
}

// registerWorkspace 登记一个备份里有、当前数据目录没有的工作空间，排在最后。
func registerWorkspace(ctx context.Context, d *sql.DB, e WorkspaceEntry, vaultDir string) error {
	created := e.CreatedAt
	if created == 0 {
		created = time.Now().UnixMilli()
	}
	name := e.Name
	if name == "" {
		name = e.ID
	}
	_, err := d.ExecContext(ctx, `INSERT INTO workspaces(id, name, vault_dir, sort, created_at)
		VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM workspaces), ?)`, e.ID, name, vaultDir, created)
	return err
}

// replaceDefaultIndex 在一个事务里用备份库（staged）里的内容替换 live 库中属于默认工作空间的表。
// 两个库都已迁移到当前版本，表结构相同；变更序号计数跟着备份回到备份时的值（和整库恢复一致）。
func replaceDefaultIndex(ctx context.Context, live *sql.DB, staged string) error {
	conn, err := live.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `ATTACH DATABASE ? AS bk`, staged); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), `DETACH DATABASE bk`)

	cols := map[string]string{}
	for _, t := range defaultIndexTables {
		main, err := tableColumns(ctx, conn, "main", t)
		if err != nil {
			return err
		}
		bk, err := tableColumns(ctx, conn, "bk", t)
		if err != nil {
			return err
		}
		if main != bk {
			return fmt.Errorf("表 %s 的结构与备份不同", t)
		}
		if t == "notes_fts" {
			main = "rowid, " + main // FTS 的 rowid 就是 notes.num
		}
		cols[t] = main
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for i := len(defaultIndexTables) - 1; i >= 0; i-- {
		if _, err := tx.ExecContext(ctx, `DELETE FROM main.`+defaultIndexTables[i]); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM main.sqlite_sequence WHERE name IN ('changes', 'agent_messages')`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM main.settings WHERE key = ?`, changesFloorKey); err != nil {
		return err
	}
	for _, t := range defaultIndexTables {
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`INSERT INTO main.%s(%s) SELECT %s FROM bk.%s`, t, cols[t], cols[t], t)); err != nil {
			return fmt.Errorf("%s: %w", t, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO main.settings(key, value) SELECT key, value FROM bk.settings WHERE key = ?`, changesFloorKey); err != nil {
		return err
	}
	return tx.Commit()
}

// tableColumns 返回表的列名（逗号分隔）。
func tableColumns(ctx context.Context, conn *sql.Conn, schema, table string) (string, error) {
	rows, err := conn.QueryContext(ctx, fmt.Sprintf(`PRAGMA %s.table_info(%s)`, schema, table))
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var cid, notnull, pk int
		var name, typ string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return "", err
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(names) == 0 {
		return "", fmt.Errorf("没有表 %s.%s", schema, table)
	}
	return strings.Join(names, ", "), nil
}
