package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/auth"
)

type ctxKey string

const (
	ctxKeyClaims      ctxKey = "claims"
	ctxKeyRequest     ctxKey = "request_id"
	statusRecorderKey ctxKey = "status_recorder"
)

// requestIDMiddleware 为每个请求生成 request id，并回写响应头。
func requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" || len(id) > 64 {
			buf := make([]byte, 8)
			_, _ = rand.Read(buf)
			id = hex.EncodeToString(buf)
		}
		w.Header().Set("X-Request-Id", id)
		ctx := context.WithValue(r.Context(), ctxKeyRequest, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// recoverMiddleware 兜住 panic，避免单个请求打挂整个进程。
func recoverMiddleware(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Error("panic recovered",
					"error", rec,
					"path", r.URL.Path,
					"request_id", requestID(r.Context()),
					"stack", string(debug.Stack()))
				writeError(w, http.StatusInternalServerError, codeInternal, "internal error", nil)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// statusRecorder 记录响应状态码与字节数，供日志与指标使用。
type statusRecorder struct {
	http.ResponseWriter
	status  int
	written int64
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.written += int64(n)
	return n, err
}

// Flush 让 SSE 能真正逐块推送（http.Flusher 必须被透传）。
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap 支持 http.ResponseController 找到底层 writer。
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// loggingMiddleware 输出结构化访问日志（JSON）。
func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := s.now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		// /healthz 与 /metrics 太吵，降到 debug。
		level := slog.LevelInfo
		switch r.URL.Path {
		case "/healthz", "/metrics":
			level = slog.LevelDebug
		case "/readyz":
			if rec.status >= 400 {
				level = slog.LevelWarn
			}
		default:
			if rec.status >= 500 {
				level = slog.LevelError
			} else if rec.status >= 400 {
				level = slog.LevelWarn
			}
		}
		s.log.Log(r.Context(), level, "http request",
			"method", r.Method,
			"path", r.URL.Path,
			"route", routeLabel(r),
			"status", rec.status,
			"bytes", rec.written,
			"duration_ms", float64(s.now().Sub(start).Microseconds())/1000.0,
			"request_id", requestID(r.Context()),
			"ip", ClientIP(r, s.cfg.TrustedProxies),
		)
	})
}

// metricsMiddleware 记录指标。
func (s *Server) metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w}
		start := time.Now()
		next.ServeHTTP(rec, r)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		s.metrics.ObserveHTTP(r.Method, routeLabel(r), rec.status, time.Since(start))
	})
}

// securityHeadersMiddleware 补齐与传输层无关的安全响应头。
//
// 这些头原本只由 deploy/Caddyfile 提供，一旦部署拓扑里 API 不经过 Caddy
// （例如直接把域名映射到容器 8080），保护就全部消失。放在应用层后，
// 无论前面是 Caddy、Nginx、隧道还是直连，基线都在。
func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// 明文 HTTP 下浏览器会忽略 HSTS，因此无条件设置是安全的。
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// corsMiddleware 处理跨域。允许来源由 HPF_CORS_ORIGINS 配置（默认不放开）。
func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && s.originAllowed(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			// 只有明确的来源白名单才允许携带凭据；`*` + credentials
			// 是非法组合，回显任意来源更等于给未来的 CSRF 开绿灯。
			if !s.corsWildcard() {
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id")
			w.Header().Set("Access-Control-Expose-Headers", "X-Request-Id, ETag, Content-Range, Accept-Ranges")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) corsWildcard() bool {
	for _, o := range s.cfg.CORSOrigins {
		if o == "*" {
			return true
		}
	}
	return false
}

func (s *Server) originAllowed(origin string) bool {
	for _, o := range s.cfg.CORSOrigins {
		if o == "*" || strings.EqualFold(o, origin) {
			return true
		}
	}
	return false
}

// rateLimitMiddleware 做每 IP 的粗粒度限流；认证接口用更严格的桶。
func (s *Server) rateLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := ClientIP(r, s.cfg.TrustedProxies)
		limiter := s.apiLimiter
		if strings.HasPrefix(r.URL.Path, "/v1/auth/") {
			limiter = s.authLimiter
		}
		if ok, reset := limiter.Allow(ip); !ok {
			w.Header().Set("Retry-After", strconvItoa(int(time.Until(reset).Seconds())+1))
			writeError(w, http.StatusTooManyRequests, codeRateLimited, "too many requests", map[string]any{
				"retryAfter": reset.UTC().Format(time.RFC3339),
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireAuth 校验 Bearer token，并把 Claims 放进 context。
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := bearerToken(r)
		if raw == "" {
			writeError(w, http.StatusUnauthorized, codeUnauthorized, "missing bearer token", nil)
			return
		}
		claims, err := s.tokens.ParseAccessToken(raw)
		if err != nil {
			writeError(w, http.StatusUnauthorized, codeUnauthorized, "invalid or expired token", nil)
			return
		}
		ctx := context.WithValue(r.Context(), ctxKeyClaims, claims)
		next(w, r.WithContext(ctx))
	}
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}

// claimsFrom 取出当前请求的认证信息。
func claimsFrom(ctx context.Context) (auth.Claims, bool) {
	c, ok := ctx.Value(ctxKeyClaims).(auth.Claims)
	return c, ok
}

func requestID(ctx context.Context) string {
	v, _ := ctx.Value(ctxKeyRequest).(string)
	return v
}

// routeLabel 返回稳定的路由标签，避免把 /v1/books/<uuid> 打散成无限多指标。
func routeLabel(r *http.Request) string {
	if r.Pattern != "" {
		return r.Pattern
	}
	return "unmatched"
}

// ClientIP 解析客户端 IP。只有在受信代理后面才采信 X-Forwarded-For，
// 否则任何人都能伪造 IP 绕过限流。
//
// 解析方式是业界标准的「从右往左」：RemoteAddr 是不可伪造的 TCP 对端，
// 只有它落在可信网段时才读取 XFF；然后从最右侧开始跳过可信跳，
// 遇到的第一个不可信地址就是真实客户端。旧实现直接取 XFF 最左侧
// （客户端可以随便填），在前置代理使用 `$proxy_add_x_forwarded_for`
// 追加的情况下等于把限流键完全交给攻击者。
func ClientIP(r *http.Request, trusted []string) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if len(trusted) == 0 {
		return host
	}
	peer := net.ParseIP(host)
	if peer == nil || !trustedIP(peer, trusted) {
		return host
	}
	xff := r.Header.Get("X-Forwarded-For")
	if strings.TrimSpace(xff) == "" {
		return host
	}
	entries := make([]string, 0, 4)
	for _, p := range strings.Split(xff, ",") {
		if p = strings.TrimSpace(p); p != "" {
			entries = append(entries, p)
		}
	}
	if len(entries) == 0 {
		return host
	}
	for i := len(entries) - 1; i >= 0; i-- {
		ip := net.ParseIP(entries[i])
		if ip == nil {
			// 无法解析的条目：按「不可信」处理，直接用原串做限流键。
			return entries[i]
		}
		if trustedIP(ip, trusted) {
			continue
		}
		return entries[i]
	}
	// 整条链都是可信网段（例如内网反代 + 内网客户端）：最左侧最接近真实来源。
	return entries[0]
}

// trustedIP 判断 ip 是否落在可信代理列表内。列表元素可以是单个 IP，也可以是 CIDR。
func trustedIP(ip net.IP, trusted []string) bool {
	for _, t := range trusted {
		t = strings.TrimSpace(t)
		if t == "*" {
			return true
		}
		if strings.Contains(t, "/") {
			if _, n, err := net.ParseCIDR(t); err == nil && n.Contains(ip) {
				return true
			}
			continue
		}
		if parsed := net.ParseIP(t); parsed != nil && parsed.Equal(ip) {
			return true
		}
	}
	return false
}

func strconvItoa(n int) string {
	if n < 0 {
		n = 0
	}
	var buf [20]byte
	i := len(buf)
	if n == 0 {
		return "0"
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
