// Command bench 测量 Lode 的性能基准，输出 Markdown 表格（docs/benchmark.md 用）。
//
// 对每个笔记数量：生成笔记 → 首次启动并记录全量索引耗时 → 重启、保持 2 个 WebSocket 连接、
// 空闲一段时间后读取常驻内存 → 测搜索和保存的延迟（p50 / p95）。
//
//	cd server && go run ./cmd/bench -bin ../bin/lode -n 1000,10000
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// 搜索用的查询：中文三字词、英文词、两个词 AND、中文两字词（走短词回退）。
var queries = []string{"编辑器", "数据库", "markdown", "trigram", "同步 搜索", "性能", "golang 复盘", "灵感"}

func main() {
	bin := flag.String("bin", "../bin/lode"+exeSuffix(), "lode 二进制")
	counts := flag.String("n", "1000,10000", "笔记数量，逗号分隔")
	port := flag.Int("port", 18791, "测试实例端口")
	idle := flag.Duration("idle", 15*time.Second, "测内存前的空闲时间")
	searches := flag.Int("searches", 200, "搜索请求次数")
	saves := flag.Int("saves", 200, "保存请求次数")
	keep := flag.Bool("keep", false, "保留数据目录")
	flag.Parse()

	var rows []result
	for _, s := range strings.Split(*counts, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(s))
		if err != nil {
			fail(err)
		}
		fmt.Fprintf(os.Stderr, "== %d 篇笔记\n", n)
		r, err := run(*bin, n, *port, *idle, *searches, *saves, *keep)
		if err != nil {
			fail(err)
		}
		rows = append(rows, r)
	}
	fmt.Println(machine())
	fmt.Println()
	fmt.Println("| 笔记数 | 首次全量索引 | 重启对账 | 空闲 RSS（2 个 WebSocket） | 搜索 p50 / p95 | 保存 p50 / p95 |")
	fmt.Println("|---:|---:|---:|---:|---:|---:|")
	for _, r := range rows {
		fmt.Printf("| %d | %s | %s | %.1f MB | %s / %s | %s / %s |\n", r.n, r.index, r.reconcile, r.rssMB,
			ms(r.search[0]), ms(r.search[1]), ms(r.save[0]), ms(r.save[1]))
	}
}

type result struct {
	n                int
	index, reconcile time.Duration
	rssMB            float64
	search, save     [2]time.Duration // p50, p95
}

func run(bin string, n, port int, idle time.Duration, searches, saves int, keep bool) (result, error) {
	res := result{n: n}
	dir, err := os.MkdirTemp("", fmt.Sprintf("lode-bench-%d-*", n))
	if err != nil {
		return res, err
	}
	if !keep {
		defer os.RemoveAll(dir)
	}
	gen := exec.Command("go", "run", "./cmd/gennotes", "-dir", filepath.Join(dir, "vault"), "-n", strconv.Itoa(n))
	gen.Stderr = os.Stderr
	if err := gen.Run(); err != nil {
		return res, fmt.Errorf("生成笔记：%w", err)
	}
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	password := fmt.Sprintf("bench-%d-%d", time.Now().UnixNano(), os.Getpid())

	// 首次启动：空数据库，全量建立索引
	p, err := start(bin, dir, port)
	if err != nil {
		return res, err
	}
	res.index, err = p.indexed(5 * time.Minute)
	if err != nil {
		p.stop()
		return res, err
	}
	c := newClient(base)
	if err := c.post("/api/auth/setup", map[string]string{"password": password}, nil); err != nil {
		p.stop()
		return res, err
	}
	p.stop()

	// 重启：对账，然后测内存和延迟
	p, err = start(bin, dir, port)
	if err != nil {
		return res, err
	}
	defer p.stop()
	res.reconcile, err = p.indexed(5 * time.Minute)
	if err != nil {
		return res, err
	}
	c = newClient(base)
	if err := c.post("/api/auth/login", map[string]string{"password": password}, nil); err != nil {
		return res, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for i := 0; i < 2; i++ {
		ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/api/ws", &websocket.DialOptions{HTTPClient: c.hc})
		if err != nil {
			return res, fmt.Errorf("WebSocket：%w", err)
		}
		defer ws.CloseNow()
		go func() { // 读走推送，保持连接
			for {
				if _, _, err := ws.Read(ctx); err != nil {
					return
				}
			}
		}()
	}
	time.Sleep(idle)
	res.rssMB, err = rssMB(p.cmd.Process.Pid)
	if err != nil {
		return res, err
	}

	// 搜索延迟
	var lat []time.Duration
	for i := 0; i < searches; i++ {
		q := queries[i%len(queries)]
		t := time.Now()
		var out struct {
			Results []any `json:"results"`
		}
		if err := c.get("/api/search?q="+url.QueryEscape(q), &out); err != nil {
			return res, err
		}
		lat = append(lat, time.Since(t))
	}
	res.search = percentiles(lat)

	// 保存延迟：轮流修改不同的笔记
	var tree struct {
		Notes []struct {
			ID string `json:"id"`
		} `json:"notes"`
	}
	if err := c.get("/api/tree", &tree); err != nil {
		return res, err
	}
	lat = lat[:0]
	for i := 0; i < saves; i++ {
		id := tree.Notes[(i*7919)%len(tree.Notes)].ID
		var note struct {
			Rev     int64  `json:"rev"`
			Content string `json:"content"`
		}
		if err := c.get("/api/notes/"+id, &note); err != nil {
			return res, err
		}
		body := map[string]any{"base_rev": note.Rev, "content": note.Content + fmt.Sprintf("\n基准测试保存 %d\n", i)}
		t := time.Now()
		if err := c.do("PUT", "/api/notes/"+id, body, nil); err != nil {
			return res, err
		}
		lat = append(lat, time.Since(t))
	}
	res.save = percentiles(lat)
	return res, nil
}

// ---- 被测进程 ----

type proc struct {
	cmd   *exec.Cmd
	ready chan time.Duration
	errc  chan error
}

var readyLine = regexp.MustCompile(`索引就绪.*dur=(\S+)`)

func start(bin, dir string, port int) (*proc, error) {
	cmd := exec.Command(bin, "serve")
	cmd.Env = append(os.Environ(), "LODE_DATA_DIR="+dir, fmt.Sprintf("LODE_ADDR=127.0.0.1:%d", port), "LODE_LOG_LEVEL=info")
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &proc{cmd: cmd, ready: make(chan time.Duration, 1), errc: make(chan error, 1)}
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			line := sc.Text()
			if m := readyLine.FindStringSubmatch(line); m != nil {
				d, err := time.ParseDuration(strings.Trim(m[1], `"`))
				if err != nil {
					p.errc <- err
				} else {
					p.ready <- d
				}
			} else if strings.Contains(line, "level=ERROR") {
				fmt.Fprintln(os.Stderr, line)
			}
		}
		io.Copy(io.Discard, stderr)
	}()
	return p, nil
}

// indexed 等服务日志里的“索引就绪”，返回其中记录的耗时。
func (p *proc) indexed(timeout time.Duration) (time.Duration, error) {
	select {
	case d := <-p.ready:
		return d, nil
	case err := <-p.errc:
		return 0, err
	case <-time.After(timeout):
		return 0, errors.New("等待索引超时")
	}
}

func (p *proc) stop() {
	if runtime.GOOS == "windows" {
		p.cmd.Process.Kill()
	} else {
		p.cmd.Process.Signal(os.Interrupt)
	}
	done := make(chan struct{})
	go func() { p.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		p.cmd.Process.Kill()
		<-done
	}
}

// ---- HTTP ----

type client struct {
	base string
	hc   *http.Client
}

func newClient(base string) *client {
	jar, _ := cookiejar.New(nil)
	return &client{base: base, hc: &http.Client{Jar: jar, Timeout: 30 * time.Second}}
}

func (c *client) get(path string, out any) error { return c.do("GET", path, nil, out) }

func (c *client) post(path string, body, out any) error { return c.do("POST", path, body, out) }

func (c *client) do(method, path string, body, out any) error {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	var resp *http.Response
	var err error
	for i := 0; i < 50; i++ { // 服务刚启动时可能还没开始监听
		req, _ := http.NewRequest(method, c.base+path, r)
		req.Header.Set("Content-Type", "application/json")
		resp, err = c.hc.Do(req)
		if err == nil || body != nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%s %s：%s %s", method, path, resp.Status, b)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// ---- 统计与环境 ----

func percentiles(d []time.Duration) [2]time.Duration {
	s := slices.Clone(d)
	slices.Sort(s)
	at := func(p float64) time.Duration { return s[min(len(s)-1, int(float64(len(s))*p))] }
	return [2]time.Duration{at(0.50), at(0.95)}
}

func ms(d time.Duration) string { return fmt.Sprintf("%.1f ms", float64(d.Microseconds())/1000) }

func exeSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "bench:", err)
	os.Exit(1)
}

// machine 返回测试机的描述。
func machine() string {
	cpu := cpuModel()
	return fmt.Sprintf("测试机：%s/%s，%d 个逻辑 CPU%s，测试时间 %s", runtime.GOOS, runtime.GOARCH, runtime.NumCPU(), cpu, time.Now().Format("2006-01-02 15:04"))
}

func cpuModel() string {
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if k, v, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(k) == "model name" {
				return "，" + strings.TrimSpace(v)
			}
		}
	}
	if runtime.GOOS == "windows" {
		if v := os.Getenv("PROCESSOR_IDENTIFIER"); v != "" {
			return "，" + v
		}
	}
	return ""
}
