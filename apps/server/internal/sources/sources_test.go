package sources

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const gutendexFixture = `{
  "count": 2,
  "results": [
    {
      "id": 1342,
      "title": "Pride and Prejudice",
      "authors": [{"name": "Austen, Jane"}],
      "languages": ["en"],
      "formats": {
        "application/epub+zip": "https://www.gutenberg.org/ebooks/1342.epub3.images",
        "image/jpeg": "https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg",
        "text/plain; charset=us-ascii": "https://www.gutenberg.org/files/1342/1342-0.txt"
      }
    },
    {
      "id": 9999,
      "title": "No Downloadable Format",
      "authors": [],
      "languages": ["fr"],
      "formats": {"application/x-mobipocket-ebook": "https://example.invalid/x.mobi"}
    }
  ]
}`

func newFixtureServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

func TestGutenbergSearchParsesAndFilters(t *testing.T) {
	var gotQuery string
	srv := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(gutendexFixture))
	})
	g := NewGutenberg(srv.URL, 3*time.Second).AllowPrivateHostsForTest()

	items, err := g.Search(context.Background(), "pride and prejudice")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if !strings.Contains(gotQuery, "search=pride") {
		t.Fatalf("query not forwarded: %q", gotQuery)
	}
	if !strings.Contains(gotQuery, "mime_type=application%2Fepub%2Bzip") {
		t.Fatalf("mime_type filter missing: %q", gotQuery)
	}
	// 第二条没有可下载格式，必须被过滤掉。
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	it := items[0]
	if it.Source != "gutenberg" || it.Title != "Pride and Prejudice" || it.Author != "Austen, Jane" {
		t.Fatalf("item = %+v", it)
	}
	if it.License != "public-domain" {
		t.Fatalf("license = %q", it.License)
	}
	if !strings.HasSuffix(it.DownloadURL, "1342.epub3.images") {
		t.Fatalf("downloadUrl = %q", it.DownloadURL)
	}
	if it.CoverURL == "" || it.Language != "en" {
		t.Fatalf("cover/language missing: %+v", it)
	}
}

func TestGutenbergHandlesUpstreamErrors(t *testing.T) {
	srv := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	g := NewGutenberg(srv.URL, time.Second).AllowPrivateHostsForTest()
	if _, err := g.Search(context.Background(), "x"); err == nil {
		t.Fatal("non-200 upstream must be an error")
	}

	// 超时：上游 sleep 超过客户端超时。
	slow := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte("{}"))
	})
	g2 := NewGutenberg(slow.URL, 50*time.Millisecond).AllowPrivateHostsForTest()
	if _, err := g2.Search(context.Background(), "x"); err == nil {
		t.Fatal("timeout must surface as an error")
	}

	// 非法 JSON。
	bad := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not json"))
	})
	g3 := NewGutenberg(bad.URL, time.Second).AllowPrivateHostsForTest()
	if _, err := g3.Search(context.Background(), "x"); err == nil {
		t.Fatal("invalid JSON must be an error")
	}
}

func TestGutenbergRejectsPrivateHosts(t *testing.T) {
	for _, base := range []string{"http://127.0.0.1:8080", "http://localhost:9", "http://10.0.0.5", "http://192.168.1.1", "http://169.254.169.254", "http://172.16.0.1"} {
		g := NewGutenberg(base, time.Second)
		if _, err := g.Search(context.Background(), "x"); err == nil {
			t.Fatalf("private host %s must be rejected (SSRF guard)", base)
		}
	}
}

func TestRegistryDispatch(t *testing.T) {
	srv := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(gutendexFixture))
	})
	reg := NewRegistry(NewGutenberg(srv.URL, time.Second).AllowPrivateHostsForTest())
	if names := reg.Names(); len(names) != 1 || names[0] != "gutenberg" {
		t.Fatalf("Names = %v", names)
	}
	// 不指定 source → 用第一个已注册源。
	items, err := reg.Search(context.Background(), "", "austen")
	if err != nil || len(items) != 1 {
		t.Fatalf("Search = %d items, %v", len(items), err)
	}
	// 未知 source → 明确报错。
	if _, err := reg.Search(context.Background(), "zlibrary", "x"); err == nil {
		t.Fatal("unknown source must error")
	}
	// 空查询 → 报错，不打上游。
	if _, err := reg.Search(context.Background(), "gutenberg", "   "); err == nil {
		t.Fatal("empty query must error")
	}
}
