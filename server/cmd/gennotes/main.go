// gennotes 生成用于压测的示例笔记：中英文混排正文、wikilink、标签和多级目录。
//
//	go run ./cmd/gennotes -dir ./data/vault -n 1000
package main

import (
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
)

var words = []string{
	"笔记", "同步", "搜索", "索引", "链接", "标签", "编辑器", "设计", "动画", "性能",
	"数据库", "文件", "目录", "会议", "计划", "读书", "灵感", "项目", "复盘", "周报",
	"markdown", "vault", "sqlite", "react", "golang", "trigram", "offline", "merge", "agent", "pwa",
}

var folders = []string{"", "项目", "项目/lode", "读书", "日记", "工作/会议", "工作/周报", "灵感", "archive"}

func main() {
	dir := flag.String("dir", "", "vault 目录（必填）")
	n := flag.Int("n", 1000, "生成的笔记数量")
	seed := flag.Uint64("seed", 1, "随机种子，相同种子生成相同内容")
	flag.Parse()
	if *dir == "" {
		fmt.Fprintln(os.Stderr, "用法：gennotes -dir <vault 目录> [-n 1000] [-seed 1]")
		os.Exit(2)
	}
	r := rand.New(rand.NewPCG(*seed, *seed^0x9e3779b97f4a7c15))
	titles := make([]string, *n)
	for i := range titles {
		titles[i] = fmt.Sprintf("%s %s %04d", words[r.IntN(20)], words[20+r.IntN(10)], i)
	}
	for i, title := range titles {
		folder := folders[r.IntN(len(folders))]
		path := filepath.Join(*dir, filepath.FromSlash(folder), title+".md")
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			fail(err)
		}
		if err := os.WriteFile(path, []byte(body(r, title, titles, i)), 0o644); err != nil {
			fail(err)
		}
	}
	fmt.Printf("已在 %s 生成 %d 篇笔记\n", *dir, *n)
}

func body(r *rand.Rand, title string, titles []string, self int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "---\ntags: [%s, %s]\n---\n# %s\n\n", words[r.IntN(len(words))], words[r.IntN(len(words))], title)
	paras := 3 + r.IntN(6)
	for p := 0; p < paras; p++ {
		sentences := 3 + r.IntN(5)
		for s := 0; s < sentences; s++ {
			k := 6 + r.IntN(10)
			for w := 0; w < k; w++ {
				b.WriteString(words[r.IntN(len(words))])
				if r.IntN(3) == 0 {
					b.WriteByte(' ')
				}
			}
			b.WriteString("。")
		}
		if r.IntN(2) == 0 {
			target := r.IntN(len(titles))
			if target != self {
				fmt.Fprintf(&b, " 参见 [[%s]]。", titles[target])
			}
		}
		if r.IntN(3) == 0 {
			fmt.Fprintf(&b, " #%s", words[r.IntN(len(words))])
		}
		b.WriteString("\n\n")
	}
	if r.IntN(4) == 0 {
		b.WriteString("- [ ] 待办一\n- [x] 待办二\n\n```go\nfmt.Println(\"hello\")\n```\n")
	}
	return b.String()
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
