// Command lode 是 Lode 笔记服务的单二进制入口。
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"sync"
	"syscall"
	"time"

	"github.com/rt-game-440/lode/server/internal/agent"
	"github.com/rt-game-440/lode/server/internal/api"
	"github.com/rt-game-440/lode/server/internal/audit"
	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/config"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/mcpserver"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/ops"
	"github.com/rt-game-440/lode/server/internal/secret"
	"github.com/rt-game-440/lode/server/internal/tools"
	"github.com/rt-game-440/lode/server/internal/vault"
	"github.com/rt-game-440/lode/server/internal/webui"
)

// 构建时通过 -ldflags "-X main.version=... -X main.commit=..." 注入。
var (
	version = "dev"
	commit  = "none"
)

func main() {
	ops.Version = version
	cmd, args := "serve", []string(nil)
	if len(os.Args) > 1 {
		cmd, args = os.Args[1], os.Args[2:]
	}
	switch cmd {
	case "--version", "-v", "version":
		fmt.Printf("lode %s (%s)\n", version, commit)
		return
	case "-h", "--help", "help":
		fmt.Println(usage)
		return
	case "serve", "backup", "restore", "reset-password", "healthcheck":
	default:
		fmt.Fprintf(os.Stderr, "未知命令: %s\n\n%s\n", cmd, usage)
		os.Exit(2)
	}
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "配置错误:", err)
		os.Exit(2)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(log)
	switch cmd {
	case "backup":
		err = runBackup(cfg, args)
	case "restore":
		err = runRestore(cfg, args, os.Stdin)
	case "reset-password":
		err = runResetPassword(cfg)
	case "healthcheck":
		err = runHealthcheck(cfg)
	default:
		if err = serve(cfg, log); err != nil {
			log.Error("服务退出", "err", err)
			os.Exit(1)
		}
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		os.Exit(1)
	}
}

func serve(cfg config.Config, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	unlock, err := ops.Lock(cfg.DataDir)
	if errors.Is(err, ops.ErrLocked) {
		return fmt.Errorf("数据目录 %s 正被另一个 lode 进程使用", cfg.DataDir)
	}
	if errors.Is(err, ops.ErrLockUnsupported) {
		log.Warn("无法锁定数据目录，请确保同一时间只有一个 lode 进程使用它", "err", err)
		err = nil
	}
	if err != nil {
		return err
	}
	defer unlock()
	database, err := db.Open(ctx, cfg.DBPath())
	if err != nil {
		return fmt.Errorf("打开数据库: %w", err)
	}
	defer database.Close()
	v, err := vault.New(cfg.VaultDir())
	if err != nil {
		return err
	}
	svc := notes.New(notes.Options{DB: database, Vault: v, TrashDir: cfg.TrashDir(), Logger: log})
	authSvc := auth.New(database)

	auditLog := audit.New(database)
	mcpHandler := mcpserver.Handler(mcpserver.Options{Tools: tools.New(svc), Auth: authSvc, Audit: auditLog, Version: version, Log: log})

	box, keySrc, err := secret.Load(cfg.SecretKey, cfg.DataDir)
	if err != nil {
		return fmt.Errorf("加载主密钥: %w", err)
	}
	switch keySrc {
	case secret.SourceNew:
		log.Info("已生成助手 API key 的主密钥", "file", secret.FileName)
	case secret.SourceEnv:
		log.Info("使用环境变量 LODE_SECRET_KEY 作为助手 API key 的主密钥")
	}
	agentSvc := &agent.Service{Store: agent.NewStore(database, box), Tools: tools.New(svc), Notes: svc, Log: log}
	defer agentSvc.Close() // 在关闭数据库之前停止生成（defer 逆序执行）

	srv := &api.Server{Notes: svc, Auth: authSvc, Version: version, Web: webui.Handler(), Log: log, TrustedProxies: cfg.TrustedProxies,
		Audit: auditLog, MCP: mcpHandler, Agent: agentSvc}
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	httpSrv.RegisterOnShutdown(srv.Close) // 让 WebSocket 连接随关闭退出

	// 后台任务：先建立文件监听，再全量对账（中间的外部修改由监听事件补上）。HTTP 服务立即可用。
	// 退出时先停掉后台任务并等它们结束，再关闭数据库（defer 逆序执行）。
	bgCtx, cancelBg := context.WithCancel(ctx)
	var bg sync.WaitGroup
	defer func() {
		cancelBg()
		bg.Wait()
	}()
	watching := make(chan struct{})
	bg.Go(func() {
		var once sync.Once
		markReady := func() { once.Do(func() { close(watching) }) }
		defer markReady() // 监听启动失败时也不要阻塞对账
		if err := svc.Watch(bgCtx, 300*time.Millisecond, markReady); err != nil {
			log.Error("文件监听失败", "err", err)
		}
	})
	bg.Go(func() {
		select {
		case <-watching:
		case <-bgCtx.Done():
			return
		}
		start := time.Now()
		st, err := svc.Reconcile(bgCtx)
		if err != nil {
			if bgCtx.Err() == nil {
				log.Error("启动对账失败", "err", err)
			}
			return
		}
		log.Info("索引就绪", "added", st.Added, "updated", st.Updated, "moved", st.Moved, "removed", st.Removed, "dur", time.Since(start).Round(time.Millisecond))
		debug.FreeOSMemory()
	})
	bg.Go(func() {
		session := time.NewTicker(6 * time.Hour)
		defer session.Stop()
		history := time.NewTicker(time.Hour)
		defer history.Stop()
		prune := func() {
			if st, err := svc.PruneHistory(bgCtx); err != nil {
				if bgCtx.Err() == nil {
					log.Error("清理历史版本失败", "err", err)
				}
			} else if st.Versions+st.Changes > 0 {
				log.Info("已清理历史", "versions", st.Versions, "changes", st.Changes)
			}
		}
		prune()
		for {
			select {
			case <-bgCtx.Done():
				return
			case <-session.C:
				_ = authSvc.PurgeExpired(bgCtx)
			case <-history.C:
				prune()
			}
		}
	})

	errCh := make(chan error, 1)
	go func() {
		log.Info("Lode 已启动", "addr", "http://"+cfg.Addr, "data", cfg.DataDir, "version", version)
		errCh <- httpSrv.ListenAndServe()
	}()
	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Info("正在关闭…")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}
	return nil
}
