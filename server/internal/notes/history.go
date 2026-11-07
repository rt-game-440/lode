package notes

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"
)

// 历史版本与变更事件的保留策略。
const (
	// KeepVersions 是每篇笔记最多保留的历史版本数。
	KeepVersions = 50
	// KeepFor 是历史版本和变更事件的保留时长。超过的历史版本只保留每篇的最新一版（三方合并需要它作为 base）。
	KeepFor = 30 * 24 * time.Hour
)

// changesFloorKey 记录已清理的最大变更序号；since 小于它的增量请求返回 ErrGone。
const changesFloorKey = "changes_floor"

// versionContent 返回某篇笔记某个 rev 的历史版本正文；不存在（已被清理）时 ok 为 false。
func (s *Service) versionContent(ctx context.Context, id string, rev int64) (content string, ok bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT content FROM versions WHERE note_id = ? AND rev = ?`, id, rev).Scan(&content)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return content, err == nil, err
}

// PruneStats 是一次清理的结果。
type PruneStats struct {
	Versions int64 // 删除的历史版本数
	Changes  int64 // 删除的变更事件数
}

// PruneHistory 清理历史版本和变更事件：
//   - 每篇笔记保留最近 KeepVersions 版；超过 KeepFor 的版本除最新一版外都删除；
//   - 删除超过 KeepFor 的变更事件，并记下已清理到的序号。
func (s *Service) PruneHistory(ctx context.Context) (PruneStats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := s.now().Add(-KeepFor).UnixMilli()
	var st PruneStats
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `
			DELETE FROM versions WHERE (note_id, rev) IN (
				SELECT note_id, rev FROM (
					SELECT note_id, rev, created_at,
					       ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY rev DESC) AS rn
					FROM versions
				) WHERE rn > ? OR (rn > 1 AND created_at < ?)
			)`, KeepVersions, cutoff)
		if err != nil {
			return err
		}
		st.Versions, _ = res.RowsAffected()

		var maxSeq sql.NullInt64
		if err := tx.QueryRowContext(ctx, `SELECT MAX(seq) FROM changes WHERE created_at < ?`, cutoff).Scan(&maxSeq); err != nil {
			return err
		}
		if !maxSeq.Valid {
			return nil
		}
		res, err = tx.ExecContext(ctx, `DELETE FROM changes WHERE seq <= ?`, maxSeq.Int64)
		if err != nil {
			return err
		}
		st.Changes, _ = res.RowsAffected()
		_, err = tx.ExecContext(ctx, `INSERT INTO settings(key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`, changesFloorKey, strconv.FormatInt(maxSeq.Int64, 10))
		return err
	})
	return st, err
}

// changesFloor 返回已清理到的变更序号（没清理过时为 0）。
func (s *Service) changesFloor(ctx context.Context) (int64, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, changesFloorKey).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(v, 10, 64)
}
