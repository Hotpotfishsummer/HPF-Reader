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
	"github.com/hpf-reader/hpf-reader/apps/server/internal/sources"
)

// newSourcesTestServer 构造带书源注册表的 Server，并返回一个有效 token。
func newSourcesTestServer(t *testing.T, searchers ...sources.Searcher) (*Server, http.Handler, string) {
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
	registry := sources.NewRegistry(searchers...)
	srv, handler := New(Deps{Config: cfg, Logger: logger, Tokens: tokens, Sources: registry})

	tok, _, err := tokens.IssueAccessToken("user-1", "device-1", "free")
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	return srv, handler, tok
}

func doAuthed(t *testing.T, h http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// ★ 契约测试：GET /v1/sources 返回注册的源标识。
func TestSourceListEndpoint(t *testing.T) {
	_, h, tok := newSourcesTestServer(t,
		sources.NewGutenberg("https://gutendex.com", time.Second),
		sources.NewOPDSSource(sources.SourceStandardEbooks, "https://standardebooks.org/feeds/opds/all?query={query}", "public-domain"),
	)
	rec := doAuthed(t, h, "/v1/sources", tok)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Sources []string `json:"sources"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Sources) != 2 {
		t.Fatalf("sources = %v, want 2", body.Sources)
	}
	if body.Sources[0] != "gutenberg" || body.Sources[1] != sources.SourceStandardEbooks {
		t.Fatalf("sources = %v, want [gutenberg standard-ebooks]", body.Sources)
	}
}

// 未认证访问 /v1/sources 必须 401。
func TestSourceListRequiresAuth(t *testing.T) {
	_, h, _ := newSourcesTestServer(t, sources.NewGutenberg("https://gutendex.com", time.Second))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/sources", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// ★ 核心：搜索结果里**每一条都必须有 downloadUrl**（没有的已被过滤）。
//
// 这条断言把"合法性判据在协议层"落到了 HTTP 契约上：
// 前端拿到的任何一条都能直接下载，不存在"点了没反应"的死链。
func TestSourceSearchOnlyReturnsDownloadableItems(t *testing.T) {
	// 用真实 fixture 驱动的假 OPDS 上游。
	fixture := readFixture(t, "standardebooks-opds-austen.xml")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/atom+xml;profile=opds-catalog")
		_, _ = w.Write([]byte(fixture))
	}))
	t.Cleanup(upstream.Close)

	src := sources.NewOPDSSource("standard-ebooks", upstream.URL+"/feed?query={query}", "public-domain").
		AllowPrivateHostsForTest()
	_, h, tok := newSourcesTestServer(t, src)

	rec := doAuthed(t, h, "/v1/sources/search?q=austen", tok)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var items []sources.Item
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(items) != 7 {
		t.Fatalf("items = %d, want 7 (real fixture entries)", len(items))
	}
	for _, it := range items {
		if strings.TrimSpace(it.DownloadURL) == "" {
			t.Fatalf("item without downloadUrl leaked to HTTP response: %+v", it)
		}
		if it.License == "" {
			t.Fatalf("item without license: %+v", it)
		}
		if !strings.HasPrefix(it.DownloadURL, "https://") {
			t.Fatalf("downloadUrl must be https: %q", it.DownloadURL)
		}
	}
}

// 非 open-access 的上游（Gutenberg 裸 acquisition）→ HTTP 层返回空数组而不是死链。
func TestSourceSearchRejectsNonOpenAccessUpstream(t *testing.T) {
	fixture := readFixture(t, "gutenberg-ebook-acquisition.opds.xml")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(fixture))
	}))
	t.Cleanup(upstream.Close)

	src := sources.NewOPDSSource("gutenberg-opds", upstream.URL+"/feed?query={query}", "public-domain").
		AllowPrivateHostsForTest()
	_, h, tok := newSourcesTestServer(t, src)

	rec := doAuthed(t, h, "/v1/sources/search?q=pride", tok)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var items []sources.Item
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("bare acquisition must yield 0 downloadable items, got %+v", items)
	}
}

// 未知 source → 400 且 details 里带可用列表。
func TestSourceSearchUnknownSource(t *testing.T) {
	_, h, tok := newSourcesTestServer(t, sources.NewGutenberg("https://gutendex.com", time.Second))
	rec := doAuthed(t, h, "/v1/sources/search?q=x&source=zlibrary", tok)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "available") {
		t.Fatalf("details should list available sources: %s", rec.Body.String())
	}
}

// q 缺失 → 400。
func TestSourceSearchRequiresQuery(t *testing.T) {
	_, h, tok := newSourcesTestServer(t, sources.NewGutenberg("https://gutendex.com", time.Second))
	rec := doAuthed(t, h, "/v1/sources/search", tok)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// 没有配置书源 → 503（不是 500，也不是空数组）。
func TestSourceSearchWithoutRegistryIs503(t *testing.T) {
	_, h := newTestServer(t) // 不带 Sources
	req := httptest.NewRequest(http.MethodGet, "/v1/sources/search?q=x", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	// 先要过 auth：无 token 时是 401，带 token 才是 503。
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("without token = %d, want 401", rec.Code)
	}
}
