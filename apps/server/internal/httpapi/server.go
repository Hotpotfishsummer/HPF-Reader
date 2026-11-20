// Package httpapi 是用标准库 net/http（Go 1.22+ 的增强路由）实现的 HTTP 层。
//
// 契约来源：api/openapi.yaml（单一权威）。路由注册集中在 routes() 里，
// 与 openapi.yaml 的 paths 一一对应，便于评审时逐条比对。
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/ai"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/auth"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/config"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/sources"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/storage"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
	syncengine "github.com/hpf-reader/hpf-reader/apps/server/internal/sync"
)

// Server 持有全部依赖并暴露 http.Handler。
type Server struct {
	cfg        config.Config
	log        *slog.Logger
	store      *store.Store
	syncEngine *syncengine.Engine
	syncStore  *store.SyncStore
	tokens     *auth.TokenIssuer
	storage    storage.Store
	translator ai.Translator
	sources    *sources.Registry
	metrics    *Metrics

	authLimiter *auth.RateLimiter
	apiLimiter  *auth.RateLimiter

	// argon2 参数（测试中可调小以加速）
	argon auth.Argon2Params
	// hashSem 限制并发口令哈希（每次 ~64MiB 内存）。没有闸门时，
	// 20 个并发登录就是 1.2GB 常驻内存，容器直接被 OOM 打死。
	hashSem chan struct{}
	// loginFailLimiter 按「账号 + 来源 IP」限制失败次数，避免单个 IP
	// 反复把同一账号锁死（账号级锁定不再阻断口令正确的登录）。
	loginFailLimiter *auth.RateLimiter

	now func() time.Time
}

// Deps 是构造 Server 所需的依赖。
type Deps struct {
	Config     config.Config
	Logger     *slog.Logger
	Store      *store.Store
	SyncEngine *syncengine.Engine
	SyncStore  *store.SyncStore
	Tokens     *auth.TokenIssuer
	Storage    storage.Store
	Translator ai.Translator
	Sources    *sources.Registry
}

// New 构造 Server 与它的路由 Handler。
func New(d Deps) (*Server, http.Handler) {
	s := &Server{
		cfg:         d.Config,
		log:         d.Logger,
		store:       d.Store,
		syncEngine:  d.SyncEngine,
		syncStore:   d.SyncStore,
		tokens:      d.Tokens,
		storage:     d.Storage,
		translator:  d.Translator,
		sources:     d.Sources,
		metrics:     NewMetrics(),
		authLimiter: auth.NewRateLimiter(d.Config.RateLimitAuth, time.Minute),
		apiLimiter:  auth.NewRateLimiter(d.Config.RateLimitAPI, time.Minute),
		argon:       auth.DefaultArgon2Params,
		now:         time.Now,
	}
	if n := d.Config.HashConcurrency; n > 0 {
		s.hashSem = make(chan struct{}, n)
	} else {
		s.hashSem = make(chan struct{}, 4)
	}
	lockWindow := d.Config.LoginLockWindow
	if lockWindow <= 0 {
		lockWindow = 15 * time.Minute
	}
	maxPerIP := d.Config.LoginMaxFailures
	if maxPerIP <= 0 {
		maxPerIP = 5
	}
	s.loginFailLimiter = auth.NewRateLimiter(maxPerIP, lockWindow)
	return s, s.routes()
}

// acquireHashSlot 申请一个口令哈希并发槽；返回的函数负责释放。
// ctx 取消（客户端断开）时也会返回 false，避免为已经没人等的请求烧 64MiB。
func (s *Server) acquireHashSlot(ctx context.Context) (func(), bool) {
	select {
	case s.hashSem <- struct{}{}:
		return func() { <-s.hashSem }, true
	default:
		// 槽位已满：排队等待，但与请求生命周期绑定。
		select {
		case s.hashSem <- struct{}{}:
			return func() { <-s.hashSem }, true
		case <-ctx.Done():
			return nil, false
		}
	}
}

// SetArgonParams 允许测试调整 argon2 代价（默认 64MB 内存，测试里太慢）。
func (s *Server) SetArgonParams(p auth.Argon2Params) { s.argon = p }

// SetClock 注入可控时钟（测试用）。
func (s *Server) SetClock(now func() time.Time) { s.now = now }

// Metrics 暴露指标注册表（供测试断言）。
func (s *Server) Metrics() *Metrics { return s.metrics }

// routes 注册全部路由。中间件顺序（从外到内）：
// requestID → recover → logging → cors → metrics → rateLimit → (auth) → handler。
func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	// ---- system ----
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /readyz", s.handleReadyz)
	if s.cfg.MetricsEnabled {
		mux.HandleFunc("GET /metrics", s.handleMetrics)
	}

	// ---- auth ----
	mux.HandleFunc("POST /v1/auth/register", s.handleRegister)
	mux.HandleFunc("POST /v1/auth/login", s.handleLogin)
	mux.HandleFunc("POST /v1/auth/refresh", s.handleRefresh)
	mux.HandleFunc("POST /v1/auth/logout", s.requireAuth(s.handleLogout))
	// 改密与「全部设备下线」都需要 bearer：它们是账号自救动作，
	// 必须建立在「当前持有有效会话」之上，而不是只凭 refresh token。
	mux.HandleFunc("POST /v1/auth/password", s.requireAuth(s.handleChangePassword))
	mux.HandleFunc("POST /v1/auth/logout-all", s.requireAuth(s.handleLogoutAll))
	mux.HandleFunc("GET /v1/me", s.requireAuth(s.handleMe))
	mux.HandleFunc("GET /v1/devices", s.requireAuth(s.handleListDevices))

	// ---- books ----
	mux.HandleFunc("GET /v1/books", s.requireAuth(s.handleListBooks))
	mux.HandleFunc("POST /v1/books", s.requireAuth(s.handleCreateBook))
	mux.HandleFunc("GET /v1/books/{bookId}", s.requireAuth(s.handleGetBook))
	mux.HandleFunc("PATCH /v1/books/{bookId}", s.requireAuth(s.handleUpdateBook))
	mux.HandleFunc("DELETE /v1/books/{bookId}", s.requireAuth(s.handleDeleteBook))
	mux.HandleFunc("PUT /v1/books/{bookId}/file", s.requireAuth(s.handlePutBookFile))
	mux.HandleFunc("GET /v1/books/{bookId}/file", s.requireAuth(s.handleGetBookFile))

	// ---- sync ----
	mux.HandleFunc("POST /v1/sync/push", s.requireAuth(s.handleSyncPush))
	mux.HandleFunc("GET /v1/sync/pull", s.requireAuth(s.handleSyncPull))
	mux.HandleFunc("GET /v1/sync/snapshot", s.requireAuth(s.handleSyncSnapshot))

	// ---- annotations ----
	mux.HandleFunc("GET /v1/books/{bookId}/annotations", s.requireAuth(s.handleListAnnotations))
	mux.HandleFunc("POST /v1/books/{bookId}/annotations", s.requireAuth(s.handleCreateAnnotation))
	mux.HandleFunc("PATCH /v1/annotations/{annotationId}", s.requireAuth(s.handleUpdateAnnotation))
	mux.HandleFunc("DELETE /v1/annotations/{annotationId}", s.requireAuth(s.handleDeleteAnnotation))

	// ---- ai ----
	mux.HandleFunc("POST /v1/ai/translate", s.requireAuth(s.handleTranslate))
	mux.HandleFunc("GET /v1/ai/usage", s.requireAuth(s.handleGetAIUsage))

	// 术语表（M5-3）：按书 + 目标语言读写，支持批量。
	mux.HandleFunc("GET /v1/books/{bookId}/glossary", s.requireAuth(s.handleGetGlossary))
	mux.HandleFunc("PUT /v1/books/{bookId}/glossary", s.requireAuth(s.handlePutGlossary))
	mux.HandleFunc("POST /v1/ai/jobs", s.requireAuth(s.handleCreateAIJob))
	mux.HandleFunc("GET /v1/ai/jobs", s.requireAuth(s.handleListAIJobs))
	mux.HandleFunc("GET /v1/ai/jobs/{jobId}", s.requireAuth(s.handleGetAIJob))
	mux.HandleFunc("GET /v1/ai/jobs/{jobId}/chunks", s.requireAuth(s.handleGetAIJobChunks))

	// ---- sources ----
	mux.HandleFunc("GET /v1/sources", s.requireAuth(s.handleSourceList))
	mux.HandleFunc("GET /v1/sources/search", s.requireAuth(s.handleSourceSearch))

	return s.chain(mux)
}

// chain 组装中间件。安全头放在最外层：即使后面某一层直接写错误响应
// （401/429/500），浏览器也仍然拿到 HSTS/nosniff 等基线保护。
func (s *Server) chain(next http.Handler) http.Handler {
	h := next
	h = s.rateLimitMiddleware(h)
	h = s.metricsMiddleware(h)
	h = s.corsMiddleware(h)
	h = s.loggingMiddleware(h)
	h = recoverMiddleware(s.log, h)
	h = securityHeadersMiddleware(h)
	h = requestIDMiddleware(h)
	return h
}
