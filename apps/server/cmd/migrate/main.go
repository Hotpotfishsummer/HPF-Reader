// Command migrate 只执行数据库迁移（供部署时独立的 migration job 使用）。
//
//	go run ./cmd/migrate            # 执行全部未应用的迁移
//	go run ./cmd/migrate -status    # 只打印已应用记录
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/config"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/db"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/logging"
)

func main() {
	status := flag.Bool("status", false, "只打印已应用的迁移，不执行任何变更")
	flag.Parse()

	// 迁移只需要数据库配置：不校验 API 专属密钥（见 config.LoadMigrate 注释）。
	cfg, err := config.LoadMigrate()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		os.Exit(1)
	}
	logger := logging.New(cfg.LogLevel, cfg.LogFormat)
	slog.SetDefault(logger)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	pool, err := db.Connect(ctx, cfg.DatabaseURL, 1, cfg.DBConnectTimout)
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect database: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	if *status {
		rows, err := db.AppliedMigrations(ctx, pool)
		if err != nil {
			fmt.Fprintf(os.Stderr, "read migrations: %v\n", err)
			os.Exit(1)
		}
		if len(rows) == 0 {
			fmt.Println("no migrations applied")
			return
		}
		for _, r := range rows {
			fmt.Printf("%-40s %s  %s\n", r.Version, r.AppliedAt.UTC().Format(time.RFC3339), r.Checksum[:12])
		}
		return
	}

	if err := db.Migrate(ctx, pool, logger); err != nil {
		fmt.Fprintf(os.Stderr, "migrate: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("migrations up to date")
}
