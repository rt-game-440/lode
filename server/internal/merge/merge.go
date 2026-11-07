// Package merge 实现按行的三方合并（diff3），用于多端同时编辑同一篇笔记。
package merge

import "strings"

// maxCells 是 LCS 表的单元格上限（uint16，约 4MB）。去掉公共前后缀后中间部分仍超过上限时，
// 整段当作一处改动：只会让冲突判定更保守，不会丢内容。
const maxCells = 2_000_000

// Merge3 以 base 为共同祖先合并 ours 与 theirs。
// 两边的改动在 base 中的范围不重叠也不相邻时返回合并结果和 true；
// 两边改动重叠或相邻且结果不同，返回 false。
func Merge3(base, ours, theirs string) (string, bool) {
	switch {
	case ours == theirs:
		return ours, true
	case base == ours:
		return theirs, true
	case base == theirs:
		return ours, true
	}
	b := splitLines(base)
	ho := diff(b, splitLines(ours))
	ht := diff(b, splitLines(theirs))

	var out []string
	pos, i, j := 0, 0, 0
	for i < len(ho) || j < len(ht) {
		// 从起点最靠前的改动开始，吸收所有与当前范围重叠或相邻的改动，组成一个改动簇
		var fromO, fromT []hunk
		next := func() (hunk, bool) {
			switch {
			case i < len(ho) && (j >= len(ht) || ho[i].start <= ht[j].start):
				i++
				return ho[i-1], true
			case j < len(ht):
				j++
				return ht[j-1], false
			}
			panic("unreachable")
		}
		h, isO := next()
		start, end := h.start, h.end
		for {
			if isO {
				fromO = append(fromO, h)
			} else {
				fromT = append(fromT, h)
			}
			if h.end > end {
				end = h.end
			}
			if !(i < len(ho) && ho[i].start <= end) && !(j < len(ht) && ht[j].start <= end) {
				break
			}
			h, isO = next()
		}
		out = append(out, b[pos:start]...)
		switch {
		case len(fromT) == 0:
			out = append(out, apply(b, start, end, fromO)...)
		case len(fromO) == 0:
			out = append(out, apply(b, start, end, fromT)...)
		default:
			ro, rt := apply(b, start, end, fromO), apply(b, start, end, fromT)
			if !equal(ro, rt) {
				return "", false
			}
			out = append(out, ro...)
		}
		pos = end
	}
	out = append(out, b[pos:]...)
	return strings.Join(out, ""), true
}

// hunk 表示把 base[start:end] 替换为 lines。
type hunk struct {
	start, end int
	lines      []string
}

// splitLines 按行切分并保留行尾（\n 或 \r\n），拼接后与原文完全一致。
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	ls := strings.SplitAfter(s, "\n")
	if ls[len(ls)-1] == "" {
		ls = ls[:len(ls)-1]
	}
	return ls
}

func apply(base []string, start, end int, hs []hunk) []string {
	var out []string
	p := start
	for _, h := range hs {
		out = append(out, base[p:h.start]...)
		out = append(out, h.lines...)
		p = h.end
	}
	return append(out, base[p:end]...)
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// diff 返回把 a 变成 b 的改动列表（按起点升序、互不相邻）。
func diff(a, b []string) []hunk {
	pre := 0
	for pre < len(a) && pre < len(b) && a[pre] == b[pre] {
		pre++
	}
	suf := 0
	for suf < len(a)-pre && suf < len(b)-pre && a[len(a)-1-suf] == b[len(b)-1-suf] {
		suf++
	}
	am, bm := a[pre:len(a)-suf], b[pre:len(b)-suf]
	n, m := len(am), len(bm)
	if n == 0 && m == 0 {
		return nil
	}
	if n == 0 || m == 0 || n*m > maxCells {
		return []hunk{{start: pre, end: pre + n, lines: bm}}
	}

	// 把行映射为整数，加快比较
	ids := map[string]int{}
	intern := func(ls []string) []int {
		out := make([]int, len(ls))
		for k, l := range ls {
			id, ok := ids[l]
			if !ok {
				id = len(ids)
				ids[l] = id
			}
			out[k] = id
		}
		return out
	}
	x, y := intern(am), intern(bm)

	// lcs[i*(m+1)+j] = x[i:] 与 y[j:] 的最长公共子序列长度
	w := m + 1
	lcs := make([]uint16, (n+1)*w)
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if x[i] == y[j] {
				lcs[i*w+j] = lcs[(i+1)*w+j+1] + 1
			} else {
				lcs[i*w+j] = max(lcs[(i+1)*w+j], lcs[i*w+j+1])
			}
		}
	}

	var out []hunk
	var cur *hunk
	i, j := 0, 0
	for i < n || j < m {
		if i < n && j < m && x[i] == y[j] {
			if cur != nil {
				out = append(out, *cur)
				cur = nil
			}
			i++
			j++
			continue
		}
		if cur == nil {
			cur = &hunk{start: pre + i, end: pre + i}
		}
		if j < m && (i == n || lcs[i*w+j+1] >= lcs[(i+1)*w+j]) {
			cur.lines = append(cur.lines, bm[j])
			j++
		} else {
			i++
			cur.end = pre + i
		}
	}
	if cur != nil {
		out = append(out, *cur)
	}
	return out
}
