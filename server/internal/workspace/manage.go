package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
)

// 工作空间的改名、排序和删除，见 docs/workspaces.md 第 9 节。

// TrashDirName 是数据目录下存放已删除工作空间的子目录名。
const TrashDirName = "trash-workspaces"

// Info 返回登记的工作空间 id；没有时返回 ErrNotFound。不会打开它。
func (m *Manager) Info(ctx context.Context, id string) (Info, error) {
	list, err := m.List(ctx)
	if err != nil {
		return Info{}, err
	}
	for _, in := range list {
		if in.ID == id {
			return in, nil
		}
	}
	return Info{}, ErrNotFound
}

// Exists 判断工作空间 id 是否已登记。
func (m *Manager) Exists(ctx context.Context, id string) (bool, error) {
	if m.global == nil {
		return id == DefaultID, nil
	}
	var n int
	if err := m.global.QueryRowContext(ctx, `SELECT count(*) FROM workspaces WHERE id = ?`, id).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// Rename 修改工作空间名称（默认工作空间也可以改名）。
func (m *Manager) Rename(ctx context.Context, id, name string) (Info, error) {
	if m.global == nil {
		return Info{}, ErrNoRegistry
	}
	name, err := cleanName(name)
	if err != nil {
		return Info{}, err
	}
	m.adminMu.Lock()
	res, err := m.global.ExecContext(ctx, `UPDATE workspaces SET name = ? WHERE id = ?`, name, id)
	m.adminMu.Unlock()
	if err != nil {
		return Info{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Info{}, ErrNotFound
	}
	return m.Info(ctx, id)
}

// Reorder 把工作空间 id 移到第 pos 位（从 0 开始，超出范围按两端处理），并把所有工作空间的 sort
// 重新编号为 0、1、2…（所以 sort 就是列表里的位置）。
func (m *Manager) Reorder(ctx context.Context, id string, pos int) (Info, error) {
	if m.global == nil {
		return Info{}, ErrNoRegistry
	}
	m.adminMu.Lock()
	defer m.adminMu.Unlock()
	tx, err := m.global.BeginTx(ctx, nil)
	if err != nil {
		return Info{}, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id FROM workspaces ORDER BY sort, created_at, id`)
	if err != nil {
		return Info{}, err
	}
	var ids []string
	for rows.Next() {
		var x string
		if err := rows.Scan(&x); err != nil {
			rows.Close()
			return Info{}, err
		}
		ids = append(ids, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Info{}, err
	}
	i := slices.Index(ids, id)
	if i < 0 {
		return Info{}, ErrNotFound
	}
	ids = slices.Delete(ids, i, i+1)
	ids = slices.Insert(ids, min(max(pos, 0), len(ids)), id)
	for n, x := range ids {
		if _, err := tx.ExecContext(ctx, `UPDATE workspaces SET sort = ? WHERE id = ?`, n, x); err != nil {
			return Info{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Info{}, err
	}
	return m.Info(ctx, id)
}

// RemoveResult 是 Remove 的结果。
type RemoveResult struct {
	// Trash 是工作空间目录被移到的位置，相对数据目录（trash-workspaces/<id>-<时间>，斜杠分隔）。
	Trash string
	// RevokedTokens 是随之作废的 MCP token 数。
	RevokedTokens int
}

// Remove 删除工作空间：先停掉它的后台任务、关闭索引库，再把整个目录移到
// data/trash-workspaces/<id>-<时间>/（不直接删除），从登记表移除，并作废绑定它的 MCP token。
// 默认工作空间返回 ErrProtected，没有登记的返回 ErrNotFound。
// 登记表和 token 的修改在一个事务里，目录移动失败时整体回滚（工作空间下次访问时重新打开）。
func (m *Manager) Remove(ctx context.Context, id string) (RemoveResult, error) {
	if id == DefaultID {
		return RemoveResult{}, ErrProtected
	}
	if m.global == nil || !ValidID(id) {
		return RemoveResult{}, ErrNotFound
	}
	m.adminMu.Lock()
	defer m.adminMu.Unlock()
	var vaultDir string
	err := m.global.QueryRowContext(ctx, `SELECT vault_dir FROM workspaces WHERE id = ?`, id).Scan(&vaultDir)
	if errors.Is(err, sql.ErrNoRows) {
		return RemoveResult{}, ErrNotFound
	}
	if err != nil {
		return RemoveResult{}, err
	}

	// 拦住新的 Get，等正在进行的打开结束，再停掉后台任务、关库
	m.mu.Lock()
	m.removing[id] = true
	opening := m.opening[id]
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.removing, id)
		m.mu.Unlock()
	}()
	if opening != nil {
		select {
		case <-opening:
		case <-ctx.Done():
			return RemoveResult{}, ctx.Err()
		}
	}
	m.mu.Lock()
	w := m.open[id]
	delete(m.open, id)
	m.order = slices.DeleteFunc(m.order, func(x string) bool { return x == id })
	m.mu.Unlock()
	if w != nil {
		if w.cancel != nil {
			w.cancel()
		}
		w.bg.Wait()
		w.closeDB()
		close(w.gone)
	}

	tx, err := m.global.BeginTx(ctx, nil)
	if err != nil {
		return RemoveResult{}, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM api_tokens WHERE workspace_id = ?`, id)
	if err != nil {
		return RemoveResult{}, err
	}
	n, _ := res.RowsAffected()
	out := RemoveResult{RevokedTokens: int(n)}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspaces WHERE id = ?`, id); err != nil {
		return RemoveResult{}, err
	}

	// 处理磁盘上的文件。#60 的外部目录（vaultDir != ""）在 disposeFiles 里加分支：
	// 只清掉 data/workspaces/<id>/（索引、回收站、对话），外部的笔记文件一个都不动。
	trash, undo, err := m.disposeFiles(id, vaultDir)
	if err != nil {
		return RemoveResult{}, err
	}
	out.Trash = trash
	if err := tx.Commit(); err != nil {
		undo()
		return RemoveResult{}, err
	}
	m.log.Info("已删除工作空间", "workspace", id, "trash", out.Trash, "revoked_tokens", out.RevokedTokens)
	return out, nil
}

// disposeFiles 处理被删除工作空间在磁盘上的文件，返回它们去了哪里（相对数据目录，可为空）和撤销函数
// （事务提交失败时调用）。内置目录：整个 data/workspaces/<id>/ 移到 data/trash-workspaces/<id>-<时间>/。
func (m *Manager) disposeFiles(id, vaultDir string) (trash string, undo func(), err error) {
	p := PathsFor(m.dataDir, id, vaultDir)
	trash, err = m.moveToTrash(id, p.Root)
	if err != nil {
		return "", nil, err
	}
	return trash, func() { _ = os.Rename(filepath.Join(m.dataDir, filepath.FromSlash(trash)), p.Root) }, nil
}

// moveToTrash 把目录 src 移到 data/trash-workspaces/<id>-<时间>/，返回相对数据目录的路径（斜杠分隔）。
// src 不存在（例如被手动清理）时只建一个空的占位目录，不报错。
func (m *Manager) moveToTrash(id, src string) (string, error) {
	base := fmt.Sprintf("%s-%s", id, m.now().Format("20060102-150405"))
	root := filepath.Join(m.dataDir, TrashDirName)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	name := base
	for i := 2; ; i++ {
		if _, err := os.Lstat(filepath.Join(root, name)); errors.Is(err, os.ErrNotExist) {
			break
		}
		name = fmt.Sprintf("%s-%d", base, i)
	}
	dst := filepath.Join(root, name)
	if _, err := os.Lstat(src); errors.Is(err, os.ErrNotExist) {
		return TrashDirName + "/" + name, os.Mkdir(dst, 0o755)
	}
	if err := os.Rename(src, dst); err != nil {
		return "", fmt.Errorf("移动工作空间目录: %w", err)
	}
	return TrashDirName + "/" + name, nil
}
