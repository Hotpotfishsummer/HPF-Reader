// Package logging 构造结构化日志器（JSON）。
package logging

import (
	"log/slog"
	"os"
	"strings"
)

// New 按配置创建 slog.Logger。
//
// 生产环境固定 JSON（便于 Loki/ELK 采集）；开发环境可用 text 看得更清楚。
func New(level, format string) *slog.Logger {
	var lv slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lv = slog.LevelDebug
	case "warn", "warning":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lv}
	var handler slog.Handler
	if strings.EqualFold(format, "text") {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}
	return slog.New(handler)
}
