package notes

import (
	"context"
	"errors"
	"os"
	"path"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/rt-game-440/lode/server/internal/vault"
)

// Watch 用 fsnotify 监听 vault 中的外部修改，并增量对账。阻塞直到 ctx 取消。
// 事件先按 debounce 合并，再对涉及的路径（及其父目录）对账。
// 所有目录加入监听后调用 ready（可为 nil）；调用方应在此之后再做全量对账，避免漏掉中间的修改。
func (s *Service) Watch(ctx context.Context, debounce time.Duration, ready func()) error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer w.Close()
	// 以下状态只在本 goroutine 中访问
	watched := map[string]bool{}
	addDirs := func(rel string) {
		_ = s.vault.Walk(rel, func(e vault.Entry) error {
			if e.IsDir && !watched[e.Path] {
				if err := w.Add(s.vault.Abs(e.Path)); err == nil {
					watched[e.Path] = true
				}
			}
			return nil
		})
	}
	addDirs("")
	if ready != nil {
		ready()
	}

	pending := map[string]bool{}
	var timer *time.Timer
	var timerC <-chan time.Time
	var first time.Time // 本批次第一个事件的时间；持续有事件时最多推迟 maxWait
	maxWait := 4 * debounce
	schedule := func() {
		now := time.Now()
		if timerC == nil {
			first = now
		} else if now.Sub(first) >= maxWait {
			return // 不再推迟，等已有的定时器触发
		}
		if timer == nil {
			timer = time.NewTimer(debounce)
		} else {
			timer.Stop()
			timer.Reset(debounce)
		}
		timerC = timer.C
	}
	flush := func() {
		scopes := make([]string, 0, len(pending))
		for p := range pending {
			scopes = append(scopes, p)
		}
		pending = map[string]bool{}
		timerC = nil
		if len(scopes) == 0 {
			return
		}
		// 先把新出现的目录加入监听再对账：之后在其中创建的文件会产生事件，之前创建的由对账发现
		for _, sc := range scopes {
			if info, err := os.Stat(s.vault.Abs(sc)); err == nil && info.IsDir() {
				addDirs(sc)
			}
		}
		for d := range watched {
			if _, err := os.Stat(s.vault.Abs(d)); errors.Is(err, os.ErrNotExist) {
				_ = w.Remove(s.vault.Abs(d))
				delete(watched, d)
			}
		}
		st, err := s.Reconcile(context.WithoutCancel(ctx), scopes...)
		if err != nil {
			s.log.Warn("增量对账失败", "err", err)
			return
		}
		if st != (ReconcileStats{}) {
			s.log.Debug("外部修改已同步", "added", st.Added, "updated", st.Updated, "moved", st.Moved, "removed", st.Removed)
		}
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-w.Events:
			if !ok {
				return nil
			}
			rel, ok := s.vault.Rel(ev.Name)
			if !ok || rel == "" || vault.IsIgnored(rel) {
				continue
			}
			if ev.Op == fsnotify.Chmod {
				continue
			}
			info, statErr := os.Stat(ev.Name)
			isDir := statErr == nil && info.IsDir()
			if !isDir && !vault.IsNote(rel) && statErr == nil {
				continue // 附件等非笔记文件
			}
			pending[rel] = true
			if ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename) {
				// 改名时父目录也要扫描，才能找到新路径（有些平台不报告新路径）
				if d := path.Dir(rel); d != "." {
					pending[d] = true
				}
			}
			schedule()
		case <-timerC:
			flush()
		case err, ok := <-w.Errors:
			if !ok {
				return nil
			}
			s.log.Warn("文件监听出错", "err", err)
			// 事件可能丢失（例如缓冲区溢出），做一次全量对账兜底
			pending[""] = true
			schedule()
		}
	}
}
