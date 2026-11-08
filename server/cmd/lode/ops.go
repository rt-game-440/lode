package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/config"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/ops"
	"golang.org/x/term"
)

const usage = `用法：
  lode serve                     启动服务（不带参数时同样启动）
  lode backup <输出文件.tar.gz> [--no-secret]
                                 备份数据库、全部笔记文件和助手 API key 的主密钥 secret.key，
                                 服务运行中也可以执行；备份文件等同于含有你的 API key，请妥善保管。
                                 --no-secret 不包含 secret.key
  lode restore <备份文件> [-y]    从备份恢复，必须先停止服务；-y 跳过确认
  lode reset-password            重置登录密码（从终端输入，或从标准输入读一行）
  lode healthcheck               检查本机服务是否正常（容器健康检查用）
  lode --version                 显示版本

环境变量：LODE_ADDR、LODE_DATA_DIR、LODE_SECRET_KEY（可选，不设置则自动生成 secret.key）、LODE_LOG_LEVEL、LODE_TRUSTED_PROXIES
详见 README 和 docs/deploy.md。`

// runBackup 实现 lode backup。
func runBackup(cfg config.Config, args []string) error {
	var opts ops.BackupOptions
	var rest []string
	for _, a := range args {
		if a == "--no-secret" {
			opts.ExcludeSecret = true
		} else {
			rest = append(rest, a)
		}
	}
	args = rest
	if len(args) != 1 {
		return errors.New("用法：lode backup <输出文件.tar.gz> [--no-secret]")
	}
	if _, err := os.Stat(cfg.DBPath()); err != nil {
		return fmt.Errorf("数据目录 %s 里没有数据库：%w", cfg.DataDir, err)
	}
	if _, err := os.Stat(args[0]); err == nil {
		return fmt.Errorf("%s 已存在，不覆盖", args[0])
	}
	ctx := context.Background()
	// 不执行迁移：备份的是当前状态，运行中的服务可能是旧版本
	d, err := db.Connect(ctx, cfg.DBPath())
	if err != nil {
		return err
	}
	defer d.Close()
	if err := ops.Backup(ctx, d, cfg.DataDir, args[0], opts); err != nil {
		return err
	}
	st, _ := os.Stat(args[0])
	fmt.Printf("已备份到 %s（%.1f MB）\n", args[0], float64(st.Size())/(1<<20))
	if !opts.ExcludeSecret {
		fmt.Println("备份文件包含助手 API key 的主密钥，等同于含有你的 API key，请妥善保管。")
	}
	return nil
}

// runRestore 实现 lode restore。
func runRestore(cfg config.Config, args []string, in io.Reader) error {
	yes := false
	var files []string
	for _, a := range args {
		if a == "-y" || a == "--yes" {
			yes = true
		} else {
			files = append(files, a)
		}
	}
	if len(files) != 1 {
		return errors.New("用法：lode restore <备份文件> [-y]")
	}
	fmt.Fprintf(os.Stderr, `从 %s 恢复到数据目录 %s。
注意：
  - 必须先停止 lode 服务；服务运行中会拒绝恢复。
  - 数据库和全部笔记文件会被备份里的内容替换，备份之后的修改都会丢失。
    现有数据会移到数据目录下的 pre-restore-<时间>/，确认无误后可以手动删除。
  - 备份里的 secret.key 会一并恢复，已保存的助手 API key 恢复后直接可用；
    如果备份时没包含它，或你用环境变量 LODE_SECRET_KEY 提供主密钥，则需要使用同一个密钥，否则 API key 需要重新填写。
  - 登录密码、登录会话和 API token 都回到备份时的状态，备份之后创建的 token 会失效；
    各设备上尚未同步的离线修改会与恢复后的版本合并，合并不了时生成冲突副本。
`, files[0], cfg.DataDir)
	if !yes {
		fmt.Fprint(os.Stderr, "输入 yes 继续：")
		line, _ := bufio.NewReader(in).ReadString('\n')
		if strings.TrimSpace(line) != "yes" {
			return errors.New("已取消")
		}
	}
	kept, err := ops.Restore(context.Background(), cfg.DataDir, files[0])
	if errors.Is(err, ops.ErrLocked) {
		return errors.New("lode 服务正在运行，请先停止服务再恢复")
	}
	if err != nil {
		return err
	}
	fmt.Println("恢复完成。启动服务后会自动对账笔记文件。")
	if kept != "" {
		fmt.Printf("原有数据保存在 %s\n", kept)
	}
	return nil
}

// runResetPassword 实现 lode reset-password：终端上输入两次（不回显），否则从标准输入读一行。
func runResetPassword(cfg config.Config) error {
	var pw string
	if fd := int(os.Stdin.Fd()); term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, "新密码（至少 8 位）：")
		a, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return err
		}
		fmt.Fprint(os.Stderr, "再输入一次：")
		b, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return err
		}
		if string(a) != string(b) {
			return errors.New("两次输入的密码不一致")
		}
		pw = string(a)
	} else {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			return errors.New("没有从标准输入读到密码")
		}
		pw = strings.TrimRight(line, "\r\n")
	}
	ctx := context.Background()
	// 不新建数据库：LODE_DATA_DIR 写错时应报错，而不是在别处建一个空库并提示成功
	if _, err := os.Stat(cfg.DBPath()); err != nil {
		return fmt.Errorf("数据目录 %s 里没有数据库，请检查 LODE_DATA_DIR：%w", cfg.DataDir, err)
	}
	d, err := db.Open(ctx, cfg.DBPath())
	if err != nil {
		return err
	}
	defer d.Close()
	if err := auth.New(d).SetPassword(ctx, pw); err != nil {
		if errors.Is(err, auth.ErrWeakPassword) {
			return fmt.Errorf("密码至少需要 %d 位", auth.MinPasswordLen)
		}
		return err
	}
	fmt.Println("密码已重置，所有设备需要重新登录。")
	return nil
}

// runHealthcheck 实现 lode healthcheck：请求本机的 /api/health，供容器 HEALTHCHECK 使用（镜像里没有 curl）。
func runHealthcheck(cfg config.Config) error {
	host, port, err := net.SplitHostPort(cfg.Addr)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + net.JoinHostPort(host, port) + "/api/health")
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("健康检查返回 %d", resp.StatusCode)
	}
	return nil
}
