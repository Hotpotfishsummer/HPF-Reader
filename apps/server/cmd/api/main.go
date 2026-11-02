// Command api 是 HPF-Reader 的自托管服务端入口。
//
// 启动顺序（任一失败即退出，绝不带病启动）：
//
//	config → logger → database(+migrations) → store → sync engine → AI → HTTP(优雅关闭)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/ai"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/auth"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/config"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/db"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/httpapi"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/logging"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/sources"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/storage"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
	syncengine "github.com/hpf-reader/hpf-reader/apps/server/internal/sync"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/worker"
)

// version 由构建参数注入（-ldflags "-X main.version=..."）。
var version = "dev"

func main() {
	// 子命令：容器健康检查。
	// distroless 镜像里没有 shell / curl / wget，所以让二进制自己做探针。
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		if err := healthcheck(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "healthcheck failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if err := run(); err != nil {
		// 启动失败时用 stderr 输出，保证容器日志一定看得到。
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

// healthcheck 实现 healthcheck 子命令：
//
//	api healthcheck --url http://127.0.0.1:8080/healthz
//
// 退出码 0 表示健康，非 0 表示不健康（供 Docker HEALTHCHECK / K8s 探针使用）。
func healthcheck(args []string) error {
	fs := flag.NewFlagSet("healthcheck", flag.ExitOnError)
	url := fs.String("url", "http://127.0.0.1:8080/healthz", "健康检查 URL")
	timeout := fs.Duration("timeout", 4*time.Second, "超时时间")
	if err := fs.Parse(args); err != nil {
		return err
	}
	client := &http.Client{Timeout: *timeout}
	resp, err := client.Get(*url)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d from %s", resp.StatusCode, *url)
	}
	return nil
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	logger := logging.New(cfg.LogLevel, cfg.LogFormat)
	slog.SetDefault(logger)
	logger.Info("starting hpf-reader api",
		"version", version,
		"env", cfg.Env,
		"addr", cfg.Addr,
		"storage", cfg.StorageDriver,
		"ai_provider", cfg.AIProvider,
		"queue", cfg.QueueDriver)

	// 根 context：收到 SIGINT/SIGTERM 时取消，触发优雅关闭。
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.DatabaseURL, cfg.DBMaxConns, cfg.DBConnectTimout)
	if err != nil {
		return fmt.Errorf("connect database: %w", err)
	}
	defer pool.Close()
	logger.Info("database connected")

	if cfg.AutoMigrate {
		if err := db.Migrate(ctx, pool, logger); err != nil {
			return fmt.Errorf("run migrations: %w", err)
		}
	}

	st := store.New(pool)
	syncStore := store.NewSyncStore(st)
	// 服务端 HLC 的设备前缀：每次进程启动随机生成；它只用于服务端自建实体，
	// 不参与客户端之间的合并，因此无需持久化。
	engine, err := syncengine.NewEngine(syncStore, idgen.DevicePrefix(idgen.NewUUID()), time.Now)
	if err != nil {
		return fmt.Errorf("create sync engine: %w", err)
	}
	tokens, err := auth.NewTokenIssuer(cfg.JWTSecret, cfg.Issuer, cfg.AccessTokenTTL)
	if err != nil {
		return fmt.Errorf("create token issuer: %w", err)
	}
	fileStore, err := storage.NewLocal(cfg.StorageDir)
	if err != nil {
		return fmt.Errorf("create storage: %w", err)
	}
	translator, err := ai.New(ai.Config{
		Provider: cfg.AIProvider,
		BaseURL:  cfg.AIBaseURL,
		APIKey:   cfg.AIAPIKey,
		Model:    cfg.AIModel,
		Timeout:  cfg.AITimeout,
	})
	if err != nil {
		return fmt.Errorf("create ai gateway: %w", err)
	}
	registry := buildSourceRegistry(&cfg)

	_, handler := httpapi.New(httpapi.Deps{
		Config:     cfg,
		Logger:     logger,
		Store:      st,
		SyncEngine: engine,
		SyncStore:  syncStore,
		Tokens:     tokens,
		Storage:    fileStore,
		Translator: translator,
		Sources:    registry,
	})

	// 后台任务：AI worker + 定期清理（幂等表 / 过期 token）。
	w := worker.New(worker.Deps{
		Logger:          logger,
		Store:           st,
		SyncStore:       syncStore,
		Translator:      translator,
		Storage:         fileStore,
		Interval:        5 * time.Second,
		IdempotencyTTL:  7 * 24 * time.Hour,
		CleanupInterval: time.Hour,
	})
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		w.Run(ctx)
	}()

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute, // 大文件上传
		WriteTimeout:      0,               // SSE 需要长连接，不能用 WriteTimeout
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("http server listening", "addr", cfg.Addr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("http server: %w", err)
	case <-ctx.Done():
		logger.Info("shutdown signal received; draining connections")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Warn("graceful shutdown incomplete", "error", err)
		_ = httpServer.Close()
	}
	select {
	case <-workerDone:
		logger.Info("background worker stopped")
	case <-time.After(10 * time.Second):
		logger.Warn("background worker did not stop in time")
	}
	logger.Info("shutdown complete")
	return nil
}

// buildSourceRegistry 组装书源注册表。
//
// 内置源全部是**合法公版/开放获取**资源：
//   - Project Gutenberg（gutendex.com，全公版）
//   - Standard Ebooks / Open Library / Internet Archive（OPDS）
//
// OPDS 源的合法性判据在协议层：**只对带
// `http://opds-spec.org/acquisition/open-access` relation 的链接启用下载**
// （见 internal/sources/opds.go）。没有该 relation 的条目不会给出下载链。
//
// 这里**不含**任何通用抓取规则引擎，也不预留第三方书源加载点 ——
// 详见 docs/M5-PLAN-LEGAL-CORRECTION.md §12。
func buildSourceRegistry(cfg *config.Config) *sources.Registry {
	searchers := []sources.Searcher{
		sources.NewGutenberg(cfg.GutendexURL, cfg.SourcesTimeout),
	}
	if cfg.OPDSSourcesEnabled {
		searchers = append(searchers,
			sources.NewOPDSSource(sources.SourceStandardEbooks, cfg.StandardEbooksOPDSURL, "public-domain"),
			sources.NewOPDSSource(sources.SourceOpenLibrary, cfg.OpenLibraryOPDSURL, "mixed-open-access"),
			sources.NewOPDSSource(sources.SourceInternetArchive, cfg.InternetArchiveOPDSURL, "mixed-open-access"),
		)
	}
	return sources.NewRegistry(searchers...)
}
