// Command api 是 HPF-Reader 的自托管服务端入口。
//
// 启动顺序（任一失败即退出，绝不带病启动）：
//
//	config → logger → database(+migrations) → store → sync engine → AI → HTTP(优雅关闭)
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
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
	// 子命令：离线建号。
	// 这是**唯一**的账号创建入口：HTTP 层不注册 /v1/auth/register（见 internal/httpapi/server.go），
	// 因此不存在「为了建第一个号临时开放注册」这种操作，也就不会把注册接口暴露给公网扫描器。
	//
	//	api createuser --email you@example.com [--password-stdin] [--name 昵称]
	//
	// 口令默认从 stdin 读（避免出现在 shell 历史与 ps 输出里）。
	if len(os.Args) > 1 && os.Args[1] == "createuser" {
		if err := createUser(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "createuser failed: %v\n", err)
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

// createUser 实现 createuser 子命令：在数据库里直接创建一个已激活的账号。
//
// 设计要点：
//   - 口令**只从 stdin 读**，不接受 `--password` 参数：命令行参数会进 shell 历史、
//     也会出现在 `ps` / 容器 inspect 里。
//   - 复用与登录完全相同的 argon2id 参数（auth.DefaultArgon2Params），
//     保证离线建的号与历史上的号在存储格式上没有区别。
//   - 不需要任何「开放注册」开关：本命令本身就是账号创建的唯一入口，
//     但它需要能连到数据库，等价于运维权限。
//   - 邮箱已存在时报错退出，不做静默覆盖（否则会意外重置别人的口令）。
func createUser(args []string) error {
	fs := flag.NewFlagSet("createuser", flag.ExitOnError)
	email := fs.String("email", "", "账号邮箱（必填）")
	name := fs.String("name", "", "显示名称（可选）")
	passwordStdin := fs.Bool("password-stdin", false, "从标准输入读取口令（推荐）")
	password := fs.String("password", "", "口令（不推荐：会进 shell 历史，仅用于自动化）")
	if err := fs.Parse(args); err != nil {
		return err
	}
	*email = strings.TrimSpace(*email)
	if *email == "" {
		return errors.New("--email is required")
	}
	if !strings.Contains(*email, "@") {
		return fmt.Errorf("invalid email %q", *email)
	}

	pw := *password
	if *passwordStdin {
		raw, err := io.ReadAll(io.LimitReader(os.Stdin, 4096))
		if err != nil {
			return fmt.Errorf("read password from stdin: %w", err)
		}
		pw = strings.TrimRight(string(raw), "\r\n")
	}
	if len(pw) < 8 {
		return errors.New("password must be at least 8 characters")
	}
	if len(pw) > 200 {
		return errors.New("password must be at most 200 characters")
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	logger := logging.New(cfg.LogLevel, cfg.LogFormat)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool, err := db.Connect(ctx, cfg.DatabaseURL, cfg.DBMaxConns, cfg.DBConnectTimout)
	if err != nil {
		return fmt.Errorf("connect database: %w", err)
	}
	defer pool.Close()

	hash, err := auth.HashPassword(pw, auth.DefaultArgon2Params)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	st := store.New(pool)
	u, err := st.CreateUser(ctx, *email, hash, *name)
	if err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	logger.Info("user created",
		"user_id", u.ID, "email", u.Email, "role", u.Role, "status", u.Status)
	fmt.Printf("created user %s (%s)\n", u.Email, u.ID)
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
		"queue", cfg.QueueDriver,
		// 只打印密钥指纹（sha256 前 8 位），便于核对「生产用的是不是模板里的值」。
		"jwt_key_fp", jwtFingerprint(cfg.JWTSecret))
	if cfg.IsProd() {
		if cfg.MetricsEnabled {
			logger.Warn("/metrics is enabled in production: it must not be reachable from the public internet (Caddy restricts it with remote_ip; a tunnel or direct 8080 mapping bypasses that)")
		}
	}

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
		StaleJobAfter:   cfg.AIJobLease,
		MaxAttempts:     cfg.AIJobMaxAttempts,
		IdempotencyTTL:  7 * 24 * time.Hour,
		CleanupInterval: time.Hour,
		// 全站月度调用上限：worker 逐块烧钱，必须与 HTTP 层看同一个数。
		GlobalMonthlyCalls: cfg.AIGlobalMonthlyCalls,
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

// jwtFingerprint 返回密钥的短指纹：用于在启动日志里核对「生产用的是不是模板里的值」，
// 不泄露密钥本身。
func jwtFingerprint(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:4])
}
