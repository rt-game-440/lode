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
	"sync"
	"syscall"
	"time"

	"github.com/rt-game-440/lode/server/internal/agent"
	"github.com/rt-game-440/lode/server/internal/api"
	"github.com/rt-game-440/lode/server/internal/audit"
	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/config"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/keyprotect"
	"github.com/rt-game-440/lode/server/internal/mcpserver"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/ops"
	"github.com/rt-game-440/lode/server/internal/passkey"
	"github.com/rt-game-440/lode/server/internal/secret"
	"github.com/rt-game-440/lode/server/internal/vault"
	"github.com/rt-game-440/lode/server/internal/webui"
	"github.com/rt-game-440/lode/server/internal/workspace"
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
		err = runResetPassword(cfg, args)
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
	// 默认工作空间：索引在 app.db，vault 在 data/vault。其他工作空间登记在 app.db 的 workspaces 表里，
	// 放在 data/workspaces/<id>/，由 Manager 在第一次访问时打开，保持到退出。
	workspaces := workspace.New(workspace.Options{
		Default: notes.New(notes.Options{DB: database, Vault: v, TrashDir: cfg.TrashDir(), Logger: log}),
		DB:      database,
		DataDir: cfg.DataDir,
		Logger:  log,
	})
	def := workspaces.Default()
	authSvc := auth.New(database)

	auditLog := audit.New(database)
	// MCP 按 token 绑定的工作空间取工具（工作空间按需打开）。
	mcpHandler := mcpserver.Handler(mcpserver.Options{Workspaces: workspaces, Auth: authSvc, Audit: auditLog, Version: version, Log: log})

	protected, err := keyprotect.Enabled(ctx, database)
	if err != nil {
		return fmt.Errorf("读取 API key 保护设置: %w", err)
	}
	keys, keySrc, err := secret.OpenKeeper(cfg.SecretKey, cfg.DataDir, protected)
	if err != nil {
		return fmt.Errorf("加载主密钥: %w", err)
	}
	switch keySrc {
	case secret.SourceNew:
		log.Info("已生成助手 API key 的主密钥", "file", secret.FileName)
	case secret.SourceEnv:
		log.Info("使用环境变量 LODE_SECRET_KEY 作为助手 API key 的主密钥")
		if protected {
			log.Warn("数据库里的 API key 由通行密钥保护，但设置了 LODE_SECRET_KEY：环境变量里的主密钥解不开它们；去掉 LODE_SECRET_KEY 重启后用通行密钥登录即可解锁")
		}
	case secret.SourcePasskey, secret.SourcePasskeyStale:
		log.Info("API key 由通行密钥保护，当前处于锁定状态：用加入保护的通行密钥登录一次即可解锁", "removed_stale_secret_key", keySrc == secret.SourcePasskeyStale)
	}
	store := agent.NewStore(database, keys)
	agentSvc := &agent.Service{Store: store, Tools: def.Tools, Notes: def.Notes, Log: log}
	defer agentSvc.Close() // 在关闭数据库之前停止生成（defer 逆序执行）

	passkeys := passkey.New(database, log)
	keyProtect, err := keyprotect.New(ctx, database, keys, passkeys, store, log)
	if err != nil {
		return fmt.Errorf("初始化 API key 保护: %w", err)
	}
	passkeys.PRFSalt = keyProtect.LoginSalt

	srv := &api.Server{Workspaces: workspaces, Auth: authSvc, Version: version, Web: webui.Handler(), Log: log, TrustedProxies: cfg.TrustedProxies,
		Audit: auditLog, MCP: mcpHandler, Agent: agentSvc, Passkeys: passkeys, KeyProtect: keyProtect}
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	httpSrv.RegisterOnShutdown(srv.Close) // 让 WebSocket 连接随关闭退出

	// 后台任务：每个已打开的工作空间（启动时只有默认工作空间，其他的在第一次访问时打开）先建立文件监听，
	// 再全量对账（中间的外部修改由监听事件补上），并定期清理历史版本；会话清理是全局的。HTTP 服务立即可用。
	// 退出时先停掉所有已打开工作空间的后台任务并等它们结束、关闭它们的索引库，再关闭 app.db（defer 逆序执行）。
	bgCtx, cancelBg := context.WithCancel(ctx)
	var bg sync.WaitGroup
	defer func() {
		cancelBg()
		bg.Wait()
		workspaces.Close()
	}()
	workspaces.Start(bgCtx)
	bg.Go(func() {
		session := time.NewTicker(6 * time.Hour)
		defer session.Stop()
		for {
			select {
			case <-bgCtx.Done():
				return
			case <-session.C:
				_ = authSvc.PurgeExpired(bgCtx)
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
