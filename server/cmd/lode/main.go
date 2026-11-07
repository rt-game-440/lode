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
	"syscall"
	"time"

	"github.com/rt-game-440/lode/server/internal/api"
	"github.com/rt-game-440/lode/server/internal/auth"
	"github.com/rt-game-440/lode/server/internal/config"
	"github.com/rt-game-440/lode/server/internal/db"
	"github.com/rt-game-440/lode/server/internal/notes"
	"github.com/rt-game-440/lode/server/internal/vault"
	"github.com/rt-game-440/lode/server/internal/webui"
)

// 构建时通过 -ldflags "-X main.version=... -X main.commit=..." 注入。
var (
	version = "dev"
	commit  = "none"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version", "-v", "version":
			fmt.Printf("lode %s (%s)\n", version, commit)
			return
		case "serve":
		case "-h", "--help", "help":
			fmt.Println("用法: lode [serve | --version]\n\n环境变量: LODE_ADDR, LODE_DATA_DIR, LODE_SECRET_KEY, LODE_LOG_LEVEL")
			return
		default:
			fmt.Fprintf(os.Stderr, "未知命令: %s\n", os.Args[1])
			os.Exit(2)
		}
	}
	cfg := config.Load()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(log)
	if err := serve(cfg, log); err != nil {
		log.Error("服务退出", "err", err)
		os.Exit(1)
	}
}

func serve(cfg config.Config, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return err
	}
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

	srv := &api.Server{Notes: svc, Auth: authSvc, Version: version, Web: webui.Handler(), Log: log}
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// 启动对账与文件监听在后台进行，HTTP 服务立即可用。
	go func() {
		start := time.Now()
		st, err := svc.Reconcile(ctx)
		if err != nil {
			log.Error("启动对账失败", "err", err)
		} else {
			log.Info("索引就绪", "added", st.Added, "updated", st.Updated, "moved", st.Moved, "removed", st.Removed, "dur", time.Since(start).Round(time.Millisecond))
		}
		debug.FreeOSMemory()
		if err := svc.Watch(ctx, 300*time.Millisecond); err != nil {
			log.Error("文件监听失败", "err", err)
		}
	}()
	go func() {
		t := time.NewTicker(6 * time.Hour)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = authSvc.PurgeExpired(ctx)
			}
		}
	}()

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
