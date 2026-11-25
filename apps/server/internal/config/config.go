// Package config 从环境变量加载配置。
//
// 设计原则：默认值必须让服务在「本机 + docker compose」两种场景都能直接起来，
// 只有真正危险的东西（JWT 密钥、生产库密码）才强制要求显式配置。
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config 是服务端全部配置。
type Config struct {
	Env       string // dev | prod
	Addr      string // 监听地址，例如 :8080
	LogLevel  string // debug|info|warn|error
	LogFormat string // json|text

	DatabaseURL     string
	DBMaxConns      int32
	DBConnectTimout time.Duration
	AutoMigrate     bool

	// 存储
	StorageDriver string // local | s3（s3 预留，未实现时启动即报错）
	StorageDir    string
	MaxUploadSize int64

	// 认证
	JWTSecret       string
	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration
	Issuer          string
	// 登录失败保护
	//
	// LoginMaxFailures 是「同一账号 + 同一来源 IP」在窗口内允许的失败次数：
	// 超过后该 IP 对该账号的失败请求直接 429，避免单个 IP 把账号锁死。
	// LoginAccountLockFailures 是账号级锁定阈值（可跨 IP 累计），用于审计与
	// 分布式爆破兜底；它不再阻断「口令正确」的登录，因此不能被用来做 DoS。
	LoginMaxFailures         int
	LoginAccountLockFailures int
	LoginLockWindow          time.Duration
	// ★ 没有 RegisterOpen：本产品不提供公开注册，账号只能由运维在服务器上
	//   执行 `api createuser` 创建。HTTP 层连注册路由都不注册（见 httpapi/server.go），
	//   因此这里不需要、也不应该有一个「打开注册」的开关——
	//   那种开关一旦被误设成 true，就等于把建号能力重新暴露给公网。

	// HashConcurrency 是口令哈希（Argon2id，64MiB/次）的并发闸门。
	// 每个并发请求约占 64MiB 内存，必须设上限，否则少量并发就能把容器打爆。
	HashConcurrency int

	// 限流（每 IP 每分钟）
	RateLimitAuth  int
	RateLimitAPI   int
	TrustedProxies []string

	// AI
	AIProvider   string // fake | openai
	AIBaseURL    string
	AIAPIKey     string
	AIModel      string
	AITimeout    time.Duration
	AIMaxPerUser int
	// AIGlobalMonthlyCalls 是**全站**每月 AI 调用次数上限（0 = 不限）。
	//
	// 为什么需要它：每用户配额只防「单个账号烧钱」，防不住「多账号绕过」——
	// 注册开放时，攻击者注册 N 个账号就能拿到 N 份配额，账单按 N 倍增长。
	// 全站上限是最后一道成本闸门：它不区分账号，直接约束「这个月一共能调多少次」。
	// 默认 0（不限）是刻意的：自托管单用户场景下它没有意义，
	// 只有对外开放注册或多租户部署时才需要显式设置。
	AIGlobalMonthlyCalls int
	// AIJobLease 是后台任务的租约时长：worker 超过这么久没更新 locked_at，
	// 任务就被判定为卡死并退回 queued。
	// 太短会把「慢慢跑的长任务」误判成卡死（重复烧钱），太长则崩溃后要等很久才恢复。
	// 默认 15 分钟：整书翻译单块通常几秒，15 分钟足够覆盖任何单块；
	// 同时崩溃后最多等 15 分钟就能自动续跑。
	AIJobLease time.Duration
	// AIJobMaxAttempts 是后台任务重试上限：超过就不再退回 queued，
	// 避免毒任务（例如永远解析失败的坏 EPUB）无限重跑烧钱。
	AIJobMaxAttempts int
	// 书源
	SourcesTimeout time.Duration
	GutendexURL    string
	// OPDSSourcesEnabled 控制是否注册内置 OPDS 源（Standard Ebooks /
	// Open Library / Internet Archive）。默认开启；关闭后只剩 Gutenberg。
	OPDSSourcesEnabled bool
	// StandardEbooksOPDSURL 等三个内置 OPDS 源的搜索地址，便于测试/镜像替换。
	StandardEbooksOPDSURL  string
	OpenLibraryOPDSURL     string
	InternetArchiveOPDSURL string

	// 队列
	QueueDriver string // none | asynq
	RedisURL    string

	// 运维
	MetricsEnabled bool
	CORSOrigins    []string
}

// Load 读取环境变量并做完整校验（API 进程使用）。
func Load() (Config, error) {
	c := parse()
	if err := c.Validate(); err != nil {
		return c, err
	}
	return c, nil
}

// LoadMigrate 只加载迁移进程需要的配置。
//
// 迁移任务不需要 JWT 密钥、AI key、存储目录等应用级配置，因此这里不跑 Validate()。
// 否则「镜像里 ENV HPF_ENV=prod」会让迁移容器因为缺 JWT_SECRET 直接起不来 ——
// 迁移失败应该只与数据库有关。
func LoadMigrate() (Config, error) {
	c := parse()
	if strings.TrimSpace(c.DatabaseURL) == "" {
		return c, fmt.Errorf("DATABASE_URL is required")
	}
	if c.JWTSecret == "" {
		// 迁移进程不使用该值；填一个占位符避免下游误判为「已配置」。
		c.JWTSecret = "unused-by-migration"
	}
	return c, nil
}

// parse 从环境变量读出配置（不做跨字段校验）。
func parse() Config {
	env := getStr("HPF_ENV", "dev")
	prod := env == "prod"
	c := Config{
		Env:       env,
		Addr:      getStr("HPF_ADDR", ":8080"),
		LogLevel:  getStr("HPF_LOG_LEVEL", "info"),
		LogFormat: getStr("HPF_LOG_FORMAT", "json"),

		DatabaseURL:     getStr("DATABASE_URL", "postgres://hpf:hpf@127.0.0.1:5432/hpf_reader?sslmode=disable"),
		DBMaxConns:      int32(getInt("HPF_DB_MAX_CONNS", 10)),
		DBConnectTimout: getDur("HPF_DB_CONNECT_TIMEOUT", 10*time.Second),
		AutoMigrate:     getBool("HPF_AUTO_MIGRATE", true),

		StorageDriver: getStr("HPF_STORAGE_DRIVER", "local"),
		StorageDir:    getStr("HPF_STORAGE_DIR", "./data/files"),
		MaxUploadSize: int64(getInt("HPF_MAX_UPLOAD_BYTES", 512*1024*1024)),

		JWTSecret:       getStr("HPF_JWT_SECRET", ""),
		AccessTokenTTL:  getDur("HPF_ACCESS_TOKEN_TTL", 15*time.Minute),
		RefreshTokenTTL: getDur("HPF_REFRESH_TOKEN_TTL", 30*24*time.Hour),
		Issuer:          getStr("HPF_JWT_ISSUER", "hpf-reader"),

		// 账号创建没有 HTTP 入口（只有 `api createuser`），因此这里没有注册开关。
		LoginMaxFailures:         getInt("HPF_LOGIN_MAX_FAILURES", 5),
		LoginAccountLockFailures: getInt("HPF_LOGIN_ACCOUNT_LOCK_FAILURES", 20),
		LoginLockWindow:          getDur("HPF_LOGIN_LOCK_WINDOW", 15*time.Minute),
		HashConcurrency:          getInt("HPF_HASH_CONCURRENCY", 4),

		RateLimitAuth:  getInt("HPF_RATE_LIMIT_AUTH", 20),
		RateLimitAPI:   getInt("HPF_RATE_LIMIT_API", 600),
		TrustedProxies: getList("HPF_TRUSTED_PROXIES", nil),

		AIProvider:           getStr("HPF_AI_PROVIDER", "fake"),
		AIBaseURL:            getStr("HPF_AI_BASE_URL", "https://api.deepseek.com/v1"),
		AIAPIKey:             getStr("HPF_AI_API_KEY", ""),
		AIModel:              getStr("HPF_AI_MODEL", "deepseek-chat"),
		AITimeout:            getDur("HPF_AI_TIMEOUT", 60*time.Second),
		AIMaxPerUser:         getInt("HPF_AI_DAILY_QUOTA", 1000),
		AIGlobalMonthlyCalls: getInt("HPF_AI_GLOBAL_MONTHLY_CALLS", 0),
		AIJobLease:           getDur("HPF_AI_JOB_LEASE", 15*time.Minute),
		AIJobMaxAttempts:     getInt("HPF_AI_JOB_MAX_ATTEMPTS", 3),

		SourcesTimeout: getDur("HPF_SOURCES_TIMEOUT", 8*time.Second),
		GutendexURL:    getStr("HPF_GUTENDEX_URL", "https://gutendex.com"),

		OPDSSourcesEnabled: getBool("HPF_OPDS_ENABLED", true),
		StandardEbooksOPDSURL: getStr("HPF_OPDS_STANDARD_EBOOKS_URL",
			"https://standardebooks.org/feeds/opds/all?query={query}&per-page=25"),
		OpenLibraryOPDSURL: getStr("HPF_OPDS_OPEN_LIBRARY_URL",
			"https://openlibrary.org/feeds/opds/search?query={query}"),
		InternetArchiveOPDSURL: getStr("HPF_OPDS_INTERNET_ARCHIVE_URL",
			"https://archive.org/advancedsearch.php?q={query}&fl%5B%5D=identifier&output=atom"),

		QueueDriver: getStr("HPF_QUEUE_DRIVER", "none"),
		RedisURL:    getStr("REDIS_URL", ""),

		// 指标默认只在非生产开启：/metrics 会暴露路由与流量分布，
		// 一旦部署拓扑让 Caddy 的 remote_ip 规则失效（隧道/前置代理/直连 8080），
		// 它就是公网可读的。生产必须显式 opt-in。
		MetricsEnabled: getBool("HPF_METRICS_ENABLED", !prod),
		// 默认不放开任何跨域来源。桌面端是 wails:// 原生壳、Web 端与 API 同源，
		// 都不需要 CORS；关闭后即使未来出现 XSS 也拿不到跨域读能力。
		CORSOrigins: getList("HPF_CORS_ORIGINS", nil),
	}
	return c
}

// 仓库里出现过的固定密钥：任何人拿到公开仓库就能伪造 token，生产必须拒绝。
// 这类检查不能用「grep CHANGE_ME」代替 —— 示例里曾经放的就是一个形态合法的真实串。
var knownLeakedJWTSecrets = []string{
	"CHANGE_ME_generate_with_openssl_rand_base64_32", // deploy/.env.example 旧默认值（公开仓库）
	"dev-insecure-secret-change-me",                  // dev 兜底密钥（= 历史 "dev-" 开头的老值）
	"unused-by-migration",                            // 迁移进程占位符
}

// Validate 做跨字段校验。用户可在调用前自行设置 JWTSecret（测试用）。
func (c *Config) Validate() error {
	if c.JWTSecret == "" {
		if c.Env == "prod" {
			return fmt.Errorf("HPF_JWT_SECRET is required when HPF_ENV=prod")
		}
		// 开发环境给出固定密钥，保证重启后 token 不失效（仅限 dev）。
		c.JWTSecret = "dev-insecure-secret-change-me"
	}
	if c.Env == "prod" {
		// HS256 的安全性完全取决于密钥熵：16 字节的穷举空间不够，且示例值
		// 一旦被照抄就是公开密钥。
		if len(c.JWTSecret) < 32 {
			return fmt.Errorf("HPF_JWT_SECRET must be at least 32 bytes when HPF_ENV=prod (got %d)", len(c.JWTSecret))
		}
		if strings.Contains(strings.ToUpper(c.JWTSecret), "CHANGE_ME") {
			return fmt.Errorf("HPF_JWT_SECRET is still the template placeholder; generate one with: openssl rand -base64 48")
		}
		for _, known := range knownLeakedJWTSecrets {
			if c.JWTSecret == known {
				return fmt.Errorf("HPF_JWT_SECRET equals a value published in this repository; generate a new one with: openssl rand -base64 48")
			}
		}
	}
	switch c.StorageDriver {
	case "local":
	case "s3":
		return fmt.Errorf("HPF_STORAGE_DRIVER=s3 is not implemented yet; use local")
	default:
		return fmt.Errorf("unknown HPF_STORAGE_DRIVER %q", c.StorageDriver)
	}
	switch c.AIProvider {
	case "fake", "openai":
	default:
		return fmt.Errorf("unknown HPF_AI_PROVIDER %q (want fake|openai)", c.AIProvider)
	}
	switch c.QueueDriver {
	case "none", "asynq":
	default:
		return fmt.Errorf("unknown HPF_QUEUE_DRIVER %q (want none|asynq)", c.QueueDriver)
	}
	if c.QueueDriver == "asynq" && c.RedisURL == "" {
		return fmt.Errorf("REDIS_URL is required when HPF_QUEUE_DRIVER=asynq")
	}
	if c.MaxUploadSize <= 0 {
		return fmt.Errorf("HPF_MAX_UPLOAD_BYTES must be positive")
	}
	if c.HashConcurrency <= 0 {
		return fmt.Errorf("HPF_HASH_CONCURRENCY must be positive")
	}
	if c.AIGlobalMonthlyCalls < 0 {
		// 负数没有语义：它既不是「不限」（那是 0），也不是有效上限。
		// 静默当 0 处理会让「我明明设了值却完全没生效」变成一个查不出的谜。
		return fmt.Errorf("HPF_AI_GLOBAL_MONTHLY_CALLS must be >= 0 (0 means unlimited), got %d", c.AIGlobalMonthlyCalls)
	}
	if c.LoginMaxFailures > 0 && c.LoginAccountLockFailures < c.LoginMaxFailures {
		// 账号级阈值低于单 IP 阈值没有意义：按单 IP 阈值兜底。
		c.LoginAccountLockFailures = c.LoginMaxFailures
	}
	return nil
}

// IsProd 报告是否生产模式。
func (c Config) IsProd() bool { return c.Env == "prod" }

func getStr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func getInt(key string, def int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func getBool(key string, def bool) bool {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func getDur(key string, def time.Duration) time.Duration {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func getList(key string, def []string) []string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return def
	}
	return out
}
