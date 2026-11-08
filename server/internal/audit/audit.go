// Package audit 记录 MCP 工具调用（调用时间、token、工具、目标路径、结果），只保留最近的若干条。
package audit

import (
	"context"
	"database/sql"
	"time"
)

// Keep 是默认保留的记录条数。
const Keep = 1000

// Entry 是一条调用记录。
type Entry struct {
	ID         int64  `json:"id"`
	At         int64  `json:"at"` // unix 毫秒
	TokenID    string `json:"token_id"`
	TokenName  string `json:"token_name"`
	Workspace  string `json:"workspace"` // 调用发生的工作空间 id
	Tool       string `json:"tool"`
	Target     string `json:"target"` // 涉及的笔记路径或查询词，可为空
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	DurationMs int64  `json:"duration_ms"`
}

// Log 是调用记录表。
type Log struct {
	db   *sql.DB
	now  func() time.Time
	keep int64
}

// New 创建 Log。
func New(db *sql.DB) *Log { return &Log{db: db, now: time.Now, keep: Keep} }

// Record 写入一条记录（At 为零时取当前时间），并删除超出保留条数的旧记录。
func (l *Log) Record(ctx context.Context, e Entry) error {
	if e.At == 0 {
		e.At = l.now().UnixMilli()
	}
	if e.Workspace == "" {
		e.Workspace = "default"
	}
	res, err := l.db.ExecContext(ctx,
		`INSERT INTO audit_log(at, token_id, token_name, workspace_id, tool, target, ok, error, duration_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
		e.At, e.TokenID, e.TokenName, e.Workspace, e.Tool, e.Target, e.OK, e.Error, e.DurationMs)
	if err != nil {
		return err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return err
	}
	_, err = l.db.ExecContext(ctx, `DELETE FROM audit_log WHERE id <= ?`, id-l.keep)
	return err
}

// List 按时间倒序返回最近 limit 条记录。workspace 不为空时只返回该工作空间的记录。
func (l *Log) List(ctx context.Context, limit int, workspace string) ([]Entry, error) {
	rows, err := l.db.QueryContext(ctx,
		`SELECT id, at, token_id, token_name, workspace_id, tool, target, ok, error, duration_ms FROM audit_log
		 WHERE ? = '' OR workspace_id = ? ORDER BY id DESC LIMIT ?`, workspace, workspace, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.At, &e.TokenID, &e.TokenName, &e.Workspace, &e.Tool, &e.Target, &e.OK, &e.Error, &e.DurationMs); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
