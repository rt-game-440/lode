// Package webui 内嵌前端构建产物（web 构建时输出到 dist/），并提供 SPA 回退。
package webui

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

func init() {
	// PWA manifest 需要正确的类型；Go 的内置表里没有 .webmanifest
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

// Handler 返回静态文件处理器：存在的文件直接返回，其余路径回退到 index.html。
// /assets/ 下的文件名带哈希，可长期缓存；index.html 不缓存。
func Handler() http.Handler {
	sub, _ := fs.Sub(distFS, "dist")
	files := http.FileServerFS(sub)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p != "" && p != "index.html" {
			if info, err := fs.Stat(sub, p); err == nil && !info.IsDir() {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "no-cache")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		index, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("前端尚未构建：请先运行 scripts/build（或 pnpm -C web build）。"))
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(index)
	})
}
