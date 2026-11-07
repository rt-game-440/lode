// wsprobe 供内存测量使用：登录后保持 N 个 WebSocket 连接（相当于 N 台在线设备），直到进程被结束。
//
//	wsprobe -base http://127.0.0.1:18788 -login data-rss/login.json -n 2
//
// -login 是登录请求体文件（{"password": "..."}），口令不出现在命令行里。
// 全部连接收到服务器的 hello 后在标准输出打印一行“已建立 N 个 WebSocket 连接”。
package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func main() {
	base := flag.String("base", "http://127.0.0.1:8787", "服务地址")
	login := flag.String("login", "", "登录请求体文件（JSON）")
	n := flag.Int("n", 2, "连接数")
	flag.Parse()
	if err := run(*base, *login, *n); err != nil {
		fmt.Fprintln(os.Stderr, "wsprobe:", err)
		os.Exit(1)
	}
}

func run(base, loginFile string, n int) error {
	body, err := os.ReadFile(loginFile)
	if err != nil {
		return err
	}
	jar, _ := cookiejar.New(nil)
	httpc := &http.Client{Jar: jar, Timeout: 10 * time.Second}
	resp, err := httpc.Post(base+"/api/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("登录失败：%s", resp.Status)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// websocket.Dial 要求 HTTPClient 不设超时（用 ctx 控制），共用同一个 cookie jar
	wsc := &http.Client{Jar: jar}
	url := "ws" + strings.TrimPrefix(base, "http") + "/api/ws"
	for i := 0; i < n; i++ {
		dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		c, _, err := websocket.Dial(dialCtx, url, &websocket.DialOptions{HTTPClient: wsc})
		if err != nil {
			cancel()
			return fmt.Errorf("第 %d 个连接：%w", i+1, err)
		}
		var hello struct {
			Type string `json:"type"`
		}
		err = wsjson.Read(dialCtx, c, &hello)
		cancel()
		if err != nil || hello.Type != "hello" {
			return fmt.Errorf("第 %d 个连接没有收到 hello：%v", i+1, err)
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		// 持续读取（心跳和变更通知），保持连接活跃
		go func() {
			for {
				if _, _, err := c.Read(ctx); err != nil {
					return
				}
			}
		}()
	}
	fmt.Printf("已建立 %d 个 WebSocket 连接\n", n)
	<-ctx.Done()
	return nil
}
