package workspace

import (
	"context"
	"errors"
	"fmt"

	"github.com/rt-game-440/lode/server/internal/notes"
)

// TargetError 表示传输的目标工作空间有问题（不存在或笔记目录不可用），Err 是 ErrNotFound 或 ErrVaultUnavailable。
// 和来源工作空间的同类错误分开，免得调用方把“目标不存在”当成“当前工作空间不存在”。
type TargetError struct {
	ID  string
	Err error
}

func (e *TargetError) Error() string { return fmt.Sprintf("目标工作空间 %s: %v", e.ID, e.Err) }
func (e *TargetError) Unwrap() error { return e.Err }

// Transfer 把 src 里的笔记、文件夹移动或复制到工作空间 targetID（#72），详见 notes.Transfer。
// 目标不存在返回 *TargetError（包着 ErrNotFound）；任一方的笔记目录不可用（外部目录被移走、卷未挂载）
// 返回包着 ErrVaultUnavailable 的错误，目标方用 *TargetError 包装。
func (m *Manager) Transfer(ctx context.Context, src *Workspace, targetID string, opts notes.TransferOptions) (notes.TransferResult, error) {
	if targetID == src.ID {
		return notes.TransferResult{}, fmt.Errorf("%w: 目标工作空间与来源相同", notes.ErrInvalid)
	}
	dst, err := m.Get(ctx, targetID)
	if err != nil {
		if errorsIsAny(err, ErrNotFound, ErrVaultUnavailable) {
			return notes.TransferResult{}, &TargetError{ID: targetID, Err: err}
		}
		return notes.TransferResult{}, err
	}
	if err := vaultPresent(src); err != nil {
		return notes.TransferResult{}, err
	}
	if err := vaultPresent(dst); err != nil {
		return notes.TransferResult{}, &TargetError{ID: targetID, Err: err}
	}
	return notes.Transfer(ctx, src.Notes, dst.Notes, opts)
}

// vaultPresent 确认已打开的工作空间的笔记目录还在（外部目录可能在打开之后被移走）。
func vaultPresent(w *Workspace) error {
	return checkVaultPresent(w.Notes.Vault().Root())
}

func errorsIsAny(err error, targets ...error) bool {
	for _, t := range targets {
		if errors.Is(err, t) {
			return true
		}
	}
	return false
}
