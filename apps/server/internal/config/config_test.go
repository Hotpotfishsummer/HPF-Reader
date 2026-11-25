package config

import (
	"os"
	"testing"
	"time"
)

func TestLoadDefaultsDev(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Addr != ":8080" {
		t.Fatalf("Addr = %q", cfg.Addr)
	}
	if cfg.AccessTokenTTL != 15*time.Minute {
		t.Fatalf("AccessTokenTTL = %v", cfg.AccessTokenTTL)
	}
	if cfg.RefreshTokenTTL != 30*24*time.Hour {
		t.Fatalf("RefreshTokenTTL = %v", cfg.RefreshTokenTTL)
	}
	if cfg.JWTSecret == "" {
		t.Fatal("dev mode must provide a fallback JWT secret")
	}
	if cfg.StorageDriver != "local" {
		t.Fatalf("StorageDriver = %q", cfg.StorageDriver)
	}
	if cfg.AIProvider != "fake" {
		t.Fatalf("AIProvider = %q", cfg.AIProvider)
	}
}

func TestLoadProdRequiresJWTSecret(t *testing.T) {
	clearEnv(t)
	t.Setenv("HPF_ENV", "prod")
	if _, err := Load(); err == nil {
		t.Fatal("prod without HPF_JWT_SECRET must fail")
	}
	t.Setenv("HPF_JWT_SECRET", "a-very-long-and-random-secret-value")
	if _, err := Load(); err != nil {
		t.Fatalf("Load with secret: %v", err)
	}
}

func TestLoadRejectsUnknownEnums(t *testing.T) {
	clearEnv(t)
	t.Setenv("HPF_STORAGE_DRIVER", "ftp")
	if _, err := Load(); err == nil {
		t.Fatal("unknown storage driver must fail")
	}
	clearEnv(t)
	t.Setenv("HPF_AI_PROVIDER", "gpt5")
	if _, err := Load(); err == nil {
		t.Fatal("unknown AI provider must fail")
	}
	clearEnv(t)
	t.Setenv("HPF_QUEUE_DRIVER", "asynq")
	if _, err := Load(); err == nil {
		t.Fatal("asynq without REDIS_URL must fail")
	}
	clearEnv(t)
	t.Setenv("HPF_QUEUE_DRIVER", "asynq")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	if _, err := Load(); err != nil {
		t.Fatalf("asynq with REDIS_URL should load: %v", err)
	}
}

func TestLoadParsesOverrides(t *testing.T) {
	clearEnv(t)
	t.Setenv("HPF_ADDR", "127.0.0.1:9999")
	t.Setenv("HPF_ACCESS_TOKEN_TTL", "5m")
	t.Setenv("HPF_LOGIN_MAX_FAILURES", "9")
	t.Setenv("HPF_CORS_ORIGINS", "https://a.example, https://b.example")
	t.Setenv("HPF_TRUSTED_PROXIES", "10.0.0.1")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Addr != "127.0.0.1:9999" || cfg.AccessTokenTTL != 5*time.Minute || cfg.LoginMaxFailures != 9 {
		t.Fatalf("overrides not applied: %+v", cfg)
	}
	if len(cfg.CORSOrigins) != 2 || cfg.CORSOrigins[1] != "https://b.example" {
		t.Fatalf("CORSOrigins = %v", cfg.CORSOrigins)
	}
	if len(cfg.TrustedProxies) != 1 {
		t.Fatalf("TrustedProxies = %v", cfg.TrustedProxies)
	}
}

func TestLoadProdRejectsPublishedJWTSecret(t *testing.T) {
	clearEnv(t)
	t.Setenv("HPF_ENV", "prod")
	t.Setenv("HPF_JWT_SECRET", "CHANGE_ME_generate_with_openssl_rand_base64_32")
	if _, err := Load(); err == nil {
		t.Fatal("prod must refuse a JWT secret that ships in deploy/.env.example")
	}
}

func TestLoadProdRejectsShortJWTSecret(t *testing.T) {
	clearEnv(t)
	t.Setenv("HPF_ENV", "prod")
	t.Setenv("HPF_JWT_SECRET", "short-but-16plus")
	if _, err := Load(); err == nil {
		t.Fatal("prod must require at least 32 bytes of secret material")
	}
}

func TestLoadProdRejectsTemplatePlaceholder(t *testing.T) {
	clearEnv(t)
	t.Setenv("HPF_ENV", "prod")
	t.Setenv("HPF_JWT_SECRET", "CHANGE_ME_please_generate_a_random_secret_value")
	if _, err := Load(); err == nil {
		t.Fatal("prod must refuse the CHANGE_ME template placeholder")
	}
}

// 生产默认必须「安全失败」：指标关闭、不吃任何跨域来源。
//
// 注册开关本身已经不存在了（账号只能由 `api createuser` 创建），
// 因此这里不再断言 RegisterOpen —— 那个字段被删掉就是「不提供公开注册」的保证。
func TestProdDefaultsAreClosed(t *testing.T) {
	clearEnv(t)
	t.Setenv("HPF_ENV", "prod")
	t.Setenv("HPF_JWT_SECRET", "a-random-production-secret-with-enough-entropy")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.MetricsEnabled {
		t.Fatal("HPF_METRICS_ENABLED must default to false in prod")
	}
	if len(cfg.CORSOrigins) != 0 {
		t.Fatalf("CORSOrigins must default to empty, got %v", cfg.CORSOrigins)
	}
}

// dev 仍然开箱即用：指标开启，方便本地联调。
func TestDevDefaultsStayOpen(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.MetricsEnabled {
		t.Fatal("dev should default to metrics enabled")
	}
	if cfg.HashConcurrency <= 0 {
		t.Fatalf("HashConcurrency = %d", cfg.HashConcurrency)
	}
}

// 全站 AI 月度调用上限：默认必须「不限」（0），负数必须报错。
//
// 默认值语义极其重要：它决定升级后是否立刻全站故障。
// 若默认非 0，所有既有部署升级后 AI 会在额度用尽时静默停摆。
func TestAIGlobalMonthlyCallsDefaultsToUnlimited(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AIGlobalMonthlyCalls != 0 {
		t.Fatalf("AIGlobalMonthlyCalls = %d, want 0 (unlimited)", cfg.AIGlobalMonthlyCalls)
	}
}

func TestAIGlobalMonthlyCallsParsesEnv(t *testing.T) {
	clearEnv(t)
	t.Setenv("HPF_AI_GLOBAL_MONTHLY_CALLS", "50000")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AIGlobalMonthlyCalls != 50000 {
		t.Fatalf("AIGlobalMonthlyCalls = %d, want 50000", cfg.AIGlobalMonthlyCalls)
	}
}

// 负数必须报错而不是静默当 0：
// 静默当 0 会让「我明明设了上限却完全没生效」变成一个查不出的谜。
func TestAIGlobalMonthlyCallsRejectsNegative(t *testing.T) {
	clearEnv(t)
	t.Setenv("HPF_AI_GLOBAL_MONTHLY_CALLS", "-1")
	if _, err := Load(); err == nil {
		t.Fatal("负数的 HPF_AI_GLOBAL_MONTHLY_CALLS 必须报错")
	}
}

func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"HPF_ENV", "HPF_ADDR", "HPF_LOG_LEVEL", "HPF_LOG_FORMAT", "DATABASE_URL",
		"HPF_DB_MAX_CONNS", "HPF_DB_CONNECT_TIMEOUT", "HPF_AUTO_MIGRATE",
		"HPF_STORAGE_DRIVER", "HPF_STORAGE_DIR", "HPF_MAX_UPLOAD_BYTES",
		"HPF_JWT_SECRET", "HPF_ACCESS_TOKEN_TTL", "HPF_REFRESH_TOKEN_TTL", "HPF_JWT_ISSUER",
		"HPF_LOGIN_MAX_FAILURES", "HPF_LOGIN_LOCK_WINDOW",
		"HPF_LOGIN_ACCOUNT_LOCK_FAILURES", "HPF_HASH_CONCURRENCY",
		"HPF_RATE_LIMIT_AUTH", "HPF_RATE_LIMIT_API", "HPF_TRUSTED_PROXIES",
		"HPF_AI_PROVIDER", "HPF_AI_BASE_URL", "HPF_AI_API_KEY", "HPF_AI_MODEL", "HPF_AI_TIMEOUT", "HPF_AI_DAILY_QUOTA",
		"HPF_AI_GLOBAL_MONTHLY_CALLS",
		"HPF_SOURCES_TIMEOUT", "HPF_GUTENDEX_URL",
		"HPF_QUEUE_DRIVER", "REDIS_URL",
		"HPF_METRICS_ENABLED", "HPF_CORS_ORIGINS",
	} {
		_ = os.Unsetenv(k)
	}
}
