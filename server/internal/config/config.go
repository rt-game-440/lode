// Package config 从环境变量读取服务配置。
package config

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// Config 是服务运行所需的全部配置。
type Config struct {
	Addr      string // LODE_ADDR，默认 127.0.0.1:8787
	DataDir   string // LODE_DATA_DIR，默认 ./data
	SecretKey string // LODE_SECRET_KEY，阶段 5 用于加密 API key
	LogLevel  slog.Level
}

// Load 读取环境变量并填充默认值。
func Load() Config {
	c := Config{
		Addr:      env("LODE_ADDR", "127.0.0.1:8787"),
		DataDir:   env("LODE_DATA_DIR", "./data"),
		SecretKey: os.Getenv("LODE_SECRET_KEY"),
		LogLevel:  ParseLevel(os.Getenv("LODE_LOG_LEVEL")),
	}
	if abs, err := filepath.Abs(c.DataDir); err == nil {
		c.DataDir = abs
	}
	return c
}

// VaultDir 是笔记文件所在目录。
func (c Config) VaultDir() string { return filepath.Join(c.DataDir, "vault") }

// TrashDir 是回收站文件所在目录（不在 vault 内，避免被 Obsidian 看到）。
func (c Config) TrashDir() string { return filepath.Join(c.DataDir, "trash") }

// DBPath 是 SQLite 数据库路径。
func (c Config) DBPath() string { return filepath.Join(c.DataDir, "app.db") }

// ParseLevel 把 debug/info/warn/error 转成 slog.Level，无法识别时为 info。
func ParseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
