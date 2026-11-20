package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/auth"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/config"
)

// newTestServer 构造一个只依赖内存组件的最小 Server。
// 需要数据库的端点不在这些测试范围内（由 compose 冒烟测试覆盖）。
func newTestServer(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	cfg := config.Config{
		Env:            "dev",
		RateLimitAPI:   1000,
		RateLimitAuth:  1000,
		MetricsEnabled: true,
		CORSOrigins:    []string{"*"},
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	tokens, err := auth.NewTokenIssuer("test-secret-that-is-long-enough-32b", "hpf-reader", time.Minute)
	if err != nil {
		t.Fatalf("NewTokenIssuer: %v", err)
	}
	srv, handler := New(Deps{Config: cfg, Logger: logger, Tokens: tokens})
	return srv, handler
}

func TestHealthzAlwaysOK(t *testing.T) {
	_, h := newTestServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%s)", err, rec.Body.String())
	}
	if body["status"] != "ok" {
		t.Fatalf("status field = %v", body["status"])
	}
	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("request id header missing")
	}
}

func TestReadyzFailsWithoutDatabase(t *testing.T) {
	_, h := newTestServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz without a database = %d, want 503", rec.Code)
	}
}

func TestMetricsEndpointExposesPrometheusText(t *testing.T) {
	_, h := newTestServer(t)
	// 先打两个请求产生指标。
	for _, path := range []string{"/healthz", "/healthz"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"# TYPE hpf_http_requests_total counter",
		`hpf_http_requests_total{method="GET",route="GET /healthz",status="200"}`,
		`hpf_sync_ops_total{result="applied"}`,
		"hpf_uptime_seconds",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics output missing %q\n%s", want, body)
		}
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("content type = %q", ct)
	}
}

func TestProtectedRoutesRequireBearerToken(t *testing.T) {
	_, h := newTestServer(t)
	for _, tc := range []struct {
		method, path string
	}{
		{http.MethodGet, "/v1/me"},
		{http.MethodGet, "/v1/devices"},
		{http.MethodGet, "/v1/books"},
		{http.MethodPost, "/v1/books"},
		{http.MethodPost, "/v1/sync/push"},
		{http.MethodGet, "/v1/sync/pull?cursor=0"},
		{http.MethodGet, "/v1/sync/snapshot"},
		{http.MethodGet, "/v1/sources/search?q=x"},
		{http.MethodPost, "/v1/ai/translate"},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}")))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s = %d, want 401", tc.method, tc.path, rec.Code)
		}
		var body errorBody
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s %s body not JSON: %v", tc.method, tc.path, err)
		}
		if body.Code != codeUnauthorized {
			t.Fatalf("%s %s code = %q", tc.method, tc.path, body.Code)
		}
	}
}

func TestMalformedBearerTokenRejected(t *testing.T) {
	_, h := newTestServer(t)
	for _, header := range []string{"", "Bearer", "Bearer ", "Basic abc", "Bearer not.a.jwt"} {
		req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
		if header != "" {
			req.Header.Set("Authorization", header)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("Authorization=%q -> %d, want 401", header, rec.Code)
		}
	}
}

func TestCORSPreflight(t *testing.T) {
	_, h := newTestServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/v1/books", nil)
	req.Header.Set("Origin", "https://app.example")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example" {
		t.Fatalf("allow-origin = %q", got)
	}
	if !strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatal("allow-headers must include Authorization")
	}
}

func TestRateLimitReturns429(t *testing.T) {
	cfg := config.Config{Env: "dev", RateLimitAuth: 1, RateLimitAPI: 1, CORSOrigins: []string{"*"}}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	tokens, _ := auth.NewTokenIssuer("test-secret-that-is-long-enough-32b", "hpf-reader", time.Minute)
	_, h := New(Deps{Config: cfg, Logger: logger, Tokens: tokens})

	// 用未认证的受保护路由触发限流（不需要数据库）。
	first := httptest.NewRecorder()
	h.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/v1/me", nil))
	second := httptest.NewRecorder()
	h.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/v1/me", nil))
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second request = %d, want 429", second.Code)
	}
	if second.Header().Get("Retry-After") == "" {
		t.Fatal("Retry-After header missing")
	}
}

func TestUnknownRouteIs404(t *testing.T) {
	_, h := newTestServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestDecodeJSONRejectsUnknownFields(t *testing.T) {
	_, h := newTestServer(t)
	// 未认证时先被 401 拦下，因此这里直接测 decodeJSON 的行为。
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/login", strings.NewReader(`{"email":"a@b.c","password":"x","surprise":1}`))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown field must be rejected: status = %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestClientIPHonoursTrustedProxiesOnly(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.9:1234"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")

	if got := ClientIP(req, nil); got != "203.0.113.9" {
		t.Fatalf("untrusted: got %q, want the socket address", got)
	}
	if got := ClientIP(req, []string{"203.0.113.9"}); got != "1.2.3.4" {
		t.Fatalf("trusted: got %q, want the forwarded address", got)
	}
	if got := ClientIP(req, []string{"10.0.0.1"}); got != "203.0.113.9" {
		t.Fatalf("unlisted proxy: got %q, want the socket address", got)
	}
}

// 关键回归：XFF 最左侧是**客户端可伪造**的。真实客户端必须从右往左
// 跳过可信跳后取第一个不可信地址，否则前置代理一追加就能让每个请求
// 换一个假 IP，把 20 次/分的登录限流彻底绕过。
func TestClientIPTakesFirstUntrustedHopFromTheRight(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "172.18.0.5:4000" // Caddy 容器
	// 攻击者伪造了最左侧的 9.9.9.9；真实客户端 203.0.113.7 是 Caddy 写入的最后一跳。
	req.Header.Set("X-Forwarded-For", "9.9.9.9, 203.0.113.7")

	if got := ClientIP(req, []string{"172.16.0.0/12"}); got != "203.0.113.7" {
		t.Fatalf("got %q, want the right-most untrusted hop 203.0.113.7", got)
	}
	// 支持 CIDR 形式的可信代理（单个 IP 也仍然可用）。
	if got := ClientIP(req, []string{"172.16.0.0/12", "10.0.0.0/8"}); got != "203.0.113.7" {
		t.Fatalf("got %q with mixed trusted list", got)
	}
}

func TestClientIPAllTrustedTakesLeftmost(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "172.18.0.5:4000"
	req.Header.Set("X-Forwarded-For", "192.168.1.10")
	if got := ClientIP(req, []string{"172.16.0.0/12", "192.168.0.0/16"}); got != "192.168.1.10" {
		t.Fatalf("got %q, want the left-most hop when the whole chain is trusted", got)
	}
}

// 安全头必须由应用本身提供：一旦部署拓扑绕过 Caddy（直连 8080 / 前置代理），
// 这些基线保护不能凭空消失。
func TestSecurityHeadersPresentOnErrorResponses(t *testing.T) {
	_, h := newTestServer(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/me", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	checks := map[string]string{
		"Strict-Transport-Security": "max-age=31536000",
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":           "SAMEORIGIN",
		"Referrer-Policy":           "no-referrer",
	}
	for name, want := range checks {
		if got := rec.Header().Get(name); !strings.Contains(got, want) {
			t.Fatalf("%s = %q, want to contain %q", name, got, want)
		}
	}
}

// 通配来源 + Allow-Credentials 是非法组合：通配时必须拒绝携带凭据。
func TestCORSWildcardDoesNotAllowCredentials(t *testing.T) {
	_, h := newTestServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/v1/books", nil)
	req.Header.Set("Origin", "https://app.example")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("wildcard origin must not allow credentials, got %q", got)
	}
}
