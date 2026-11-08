package ops

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// txn 记录恢复过程中对文件系统做的移动，失败时按相反顺序撤销。
// 数据目录里的替换分两步：aside 把现有的移到 pre-restore-<时间>/，place 把解包好的放进来；
// 外部目录用 placeExternal（只放进空位，绝不移走用户现有的文件）。
type txn struct {
	dataDir, staging string
	kept             string // pre-restore-<时间>/，第一次移走东西时才创建
	moved            int    // 放进 kept 的东西的数量
	undo             []func() error
}

func newTxn(dataDir, staging string) *txn {
	// 同一秒内连续恢复时目录名会重复，加序号区分（否则后一次移走的东西会撞上前一次留下的）
	base := filepath.Join(dataDir, "pre-restore-"+time.Now().Format("20060102-150405"))
	kept := base
	for i := 2; ; i++ {
		if _, err := os.Lstat(kept); err != nil {
			break
		}
		kept = fmt.Sprintf("%s-%d", base, i)
	}
	return &txn{dataDir: dataDir, staging: staging, kept: kept}
}

// mkKept 创建 kept 目录并计为“有东西保留”。
func (t *txn) mkKept() error {
	if err := os.MkdirAll(t.kept, 0o700); err != nil {
		return err
	}
	t.moved++
	t.undo = append(t.undo, func() error { return nil })
	return nil
}

// keptDir 返回 kept；什么都没移走时返回空串。
func (t *txn) keptDir() string {
	if t.moved == 0 {
		return ""
	}
	return t.kept
}

// aside 把 dataDir/rel 移到 kept/rel（不存在则跳过）。
func (t *txn) aside(rel string) error {
	src := filepath.Join(t.dataDir, filepath.FromSlash(rel))
	if _, err := os.Lstat(src); err != nil {
		return nil
	}
	dst := filepath.Join(t.kept, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	t.moved++
	t.undo = append(t.undo, func() error { return os.Rename(dst, src) })
	return nil
}

// place 把 staging/rel 移到 dataDir/rel（临时区里没有则跳过）。
func (t *txn) place(rel string) error {
	src := filepath.Join(t.staging, filepath.FromSlash(rel))
	if _, err := os.Lstat(src); err != nil {
		return nil
	}
	dst := filepath.Join(t.dataDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	t.undo = append(t.undo, func() error { return os.Rename(dst, src) })
	return nil
}

// placeExternal 把 src 目录的内容放到外部目录 dst。dst 必须不存在或是空目录（调用前已校验）：
// 不存在时先尝试直接重命名；已存在的空目录、或者跨磁盘无法重命名时逐个文件复制。
// 撤销时清掉放进去的内容（dst 本来是空的或不存在，所以不会伤到用户的文件）。
func (t *txn) placeExternal(src, dst string) error {
	existed := true
	if _, err := os.Stat(dst); err != nil {
		existed = false
	}
	clean := func() error {
		if existed {
			list, err := os.ReadDir(dst)
			if err != nil {
				return err
			}
			for _, e := range list {
				if err := os.RemoveAll(filepath.Join(dst, e.Name())); err != nil {
					return err
				}
			}
			return nil
		}
		return os.RemoveAll(dst)
	}
	if !existed {
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.Rename(src, dst); err == nil {
			t.undo = append(t.undo, clean)
			return nil
		}
	}
	if err := copyTree(src, dst); err != nil {
		clean()
		return err
	}
	t.undo = append(t.undo, clean)
	return nil
}

// rollbackResult 撤销已做的移动并返回带说明的错误。
func (t *txn) rollbackResult(res Result, cause error) (Result, error) {
	var failed []error
	for i := len(t.undo) - 1; i >= 0; i-- {
		if err := t.undo[i](); err != nil {
			failed = append(failed, err)
		}
	}
	if len(failed) > 0 {
		res.Kept = t.kept
		return res, fmt.Errorf("%w；回滚也失败了（%v），原有数据在 %s", cause, errors.Join(failed...), t.kept)
	}
	pruneEmptyDirs(t.kept)
	return res, fmt.Errorf("%w；已回滚，数据目录没有改动", cause)
}

// pruneEmptyDirs 删除 root 下的空目录（含 root 自己），非空的保留。
func pruneEmptyDirs(root string) {
	var dirs []string
	filepath.WalkDir(root, func(p string, e fs.DirEntry, err error) error {
		if err == nil && e.IsDir() {
			dirs = append(dirs, p)
		}
		return nil
	})
	sort.Sort(sort.Reverse(sort.StringSlice(dirs)))
	for _, d := range dirs {
		os.Remove(d)
	}
}

// copyTree 把目录 src 里的内容复制到 dst（dst 不存在则创建），保留修改时间。
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		switch {
		case e.IsDir():
			return os.MkdirAll(target, 0o755)
		case e.Type().IsRegular():
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			defer f.Close()
			st, err := f.Stat()
			if err != nil {
				return err
			}
			return writeEntry(f, target, st.ModTime())
		}
		return nil
	})
}
