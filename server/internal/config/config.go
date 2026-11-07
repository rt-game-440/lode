// Package config 从环境变量读取服务配置。
package config

import (
	"fmt"
	"log/slog"
	"net/netip"
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
	// LODE_TRUSTED_PROXIES，逗号分隔的 IP 或 CIDR，默认只信任本机回环。
	// 反向代理不在本机时（例如 Docker 里的 Caddy）需要加上代理的地址。
	TrustedProxies []netip.Prefix
}

// Load 读取环境变量并填充默认值。
func Load() (Config, error) {
	c := Config{
		Addr:      env("LODE_ADDR", "127.0.0.1:8787"),
		DataDir:   env("LODE_DATA_DIR", "./data"),
		SecretKey: os.Getenv("LODE_SECRET_KEY"),
		LogLevel:  ParseLevel(os.Getenv("LODE_LOG_LEVEL")),
	}
	if abs, err := filepath.Abs(c.DataDir); err == nil {
		c.DataDir = abs
	}
	proxies, err := ParsePrefixes(env("LODE_TRUSTED_PROXIES", "127.0.0.0/8,::1"))
	if err != nil {
		return c, fmt.Errorf("LODE_TRUSTED_PROXIES: %w", err)
	}
	c.TrustedProxies = proxies
	return c, nil
}

// ParsePrefixes 解析逗号分隔的 IP 或 CIDR 列表。
func ParsePrefixes(s string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if strings.Contains(part, "/") {
			p, err := netip.ParsePrefix(part)
			if err != nil {
				return nil, err
			}
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(part)
		if err != nil {
			return nil, err
		}
		out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
	}
	return out, nil
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
