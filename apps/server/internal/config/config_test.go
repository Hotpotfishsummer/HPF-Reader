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

func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"HPF_ENV", "HPF_ADDR", "HPF_LOG_LEVEL", "HPF_LOG_FORMAT", "DATABASE_URL",
		"HPF_DB_MAX_CONNS", "HPF_DB_CONNECT_TIMEOUT", "HPF_AUTO_MIGRATE",
		"HPF_STORAGE_DRIVER", "HPF_STORAGE_DIR", "HPF_MAX_UPLOAD_BYTES",
		"HPF_JWT_SECRET", "HPF_ACCESS_TOKEN_TTL", "HPF_REFRESH_TOKEN_TTL", "HPF_JWT_ISSUER",
		"HPF_LOGIN_MAX_FAILURES", "HPF_LOGIN_LOCK_WINDOW", "HPF_REGISTER_OPEN",
		"HPF_RATE_LIMIT_AUTH", "HPF_RATE_LIMIT_API", "HPF_TRUSTED_PROXIES",
		"HPF_AI_PROVIDER", "HPF_AI_BASE_URL", "HPF_AI_API_KEY", "HPF_AI_MODEL", "HPF_AI_TIMEOUT", "HPF_AI_DAILY_QUOTA",
		"HPF_SOURCES_TIMEOUT", "HPF_GUTENDEX_URL",
		"HPF_QUEUE_DRIVER", "REDIS_URL",
		"HPF_METRICS_ENABLED", "HPF_CORS_ORIGINS",
	} {
		_ = os.Unsetenv(k)
	}
}
