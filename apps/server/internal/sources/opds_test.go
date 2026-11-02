package sources

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ★ 这些 fixture 是**真实抓取**的公开 OPDS 源响应，不是手写的。
//
//	$ curl -sS -A 'HPF-Reader/0.1' 'https://standardebooks.org/feeds/opds/all?query=austen' \
//	    > testdata/standardebooks-opds-austen.xml
//	$ curl -sS -A 'HPF-Reader/0.1' 'https://www.gutenberg.org/ebooks/1342.opds' \
//	    > testdata/gutenberg-ebook-acquisition.opds.xml
//	$ curl -sS -A 'HPF-Reader/0.1' 'https://www.gutenberg.org/ebooks/search.opds/?query=austen' \
//	    > testdata/gutenberg-search-navigation.opds.xml
//	$ curl -sS -A 'HPF-Reader/0.1' 'https://standardebooks.org/feeds/atom/all?query=austen' \
//	    > testdata/standardebooks-atom-austen.xml
//
// 用真实响应而不是手写 XML，是因为**手写 fixture 只会验证我以为的格式**，
// 而真实源的命名空间、relation 写法、缺失字段才是要对付的东西。
func loadFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return b
}

// loadFixtureText 是 loadFixture 的 string 版本，避免多层括号嵌套写错。
func loadFixtureText(t *testing.T, name string) string {
	t.Helper()
	return string(loadFixture(t, name))
}

// ★ 核心正确性：open-access relation 被正确识别，且能选出 EPUB。
func TestParseOPDSStandardEbooksOpenAccess(t *testing.T) {
	items, err := ParseOPDS(strings.NewReader(loadFixtureText(t, "standardebooks-opds-austen.xml")))
	if err != nil {
		t.Fatalf("ParseOPDS: %v", err)
	}
	if len(items) == 0 {
		t.Fatal("expected items from real Standard Ebooks OPDS feed")
	}
	// 真实 feed 有 7 个 entry，每个都有多个 open-access 链接。
	if len(items) != 7 {
		t.Fatalf("items = %d, want 7 (entries in real fixture)", len(items))
	}
	for _, it := range items {
		if it.DownloadURL == "" {
			t.Fatalf("open-access entry must have downloadUrl: %+v", it)
		}
		if !strings.HasPrefix(it.DownloadURL, "https://standardebooks.org/") {
			t.Fatalf("unexpected downloadUrl host: %q", it.DownloadURL)
		}
		// 必须选 EPUB 而不是 XHTML/网页正文
		if !strings.HasSuffix(strings.Split(it.DownloadURL, "?")[0], ".epub") {
			t.Fatalf("expected .epub download, got %q", it.DownloadURL)
		}
		if it.License != "open-access" {
			t.Fatalf("license = %q, want open-access", it.License)
		}
		if it.Title == "" {
			t.Fatalf("title missing: %+v", it)
		}
	}
}

// ★ 核心正确性：**非** open-access 的条目必须**不给**下载链。
//
// 用真实 Gutenberg OPDS：它有 6 个 acquisition 链接，但**全是裸 acquisition**，
// 一个 open-access 都没有 → 必须全部被过滤掉。
func TestParseOPDSGutenbergBareAcquisitionIsRejected(t *testing.T) {
	items, err := ParseOPDS(strings.NewReader(loadFixtureText(t, "gutenberg-ebook-acquisition.opds.xml")))
	if err != nil {
		t.Fatalf("ParseOPDS: %v", err)
	}
	// 该 entry 有 6 个 acquisition 链接但无一 open-access → 0 条可下载。
	if len(items) != 0 {
		for _, it := range items {
			t.Errorf("unexpected downloadable item (bare acquisition must NOT be downloadable): %+v", it)
		}
		t.Fatalf("items = %d, want 0: bare `acquisition` must not be treated as open-access", len(items))
	}
}

// 导航型 feed（只有 subsection，没有 acquisition）→ 0 条。
func TestParseOPDSNavigationFeedYieldsNoItems(t *testing.T) {
	items, err := ParseOPDS(strings.NewReader(loadFixtureText(t, "gutenberg-search-navigation.opds.xml")))
	if err != nil {
		t.Fatalf("ParseOPDS: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("navigation feed must yield 0 downloadable items, got %d", len(items))
	}
}

// 普通 Atom 订阅源（用 enclosure，不是 OPDS acquisition）→ 0 条。
func TestParseOPDSAtomEnclosureIsNotOPDS(t *testing.T) {
	items, err := ParseOPDS(strings.NewReader(loadFixtureText(t, "standardebooks-atom-austen.xml")))
	if err != nil {
		t.Fatalf("ParseOPDS: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("Atom `enclosure` is not OPDS acquisition; want 0 items, got %d", len(items))
	}
}

// IsOpenAccess 必须是**精确**匹配，不能前缀放行。
func TestIsOpenAccessIsExactMatch(t *testing.T) {
	yes := []string{
		RelAcquisitionOpenAccess,
		"http://opds-spec.org/acquisition/open-access",
	}
	for _, r := range yes {
		if !IsOpenAccess(r) {
			t.Fatalf("IsOpenAccess(%q) = false, want true", r)
		}
	}
	no := []string{
		RelAcquisition, // 裸 acquisition
		"http://opds-spec.org/acquisition/borrow",            // 借阅
		"http://opds-spec.org/acquisition/sample",            // 试读
		"http://opds-spec.org/acquisition/subscribe",         // 订阅
		"http://opds-spec.org/acquisition/open-access-extra", // 前缀但不是它
		RelEnclosure, // Atom 附件
		"",
	}
	for _, r := range no {
		if IsOpenAccess(r) {
			t.Fatalf("IsOpenAccess(%q) = true, want false", r)
		}
	}
}

// 借阅/试读/订阅都必须被归为 acquisition 但**非**开放获取。
func TestAcquisitionSubtypesAreNotOpenAccess(t *testing.T) {
	for _, r := range []string{RelAcquisitionBorrow, RelAcquisitionSample, RelAcquisitionSubscribe} {
		if !IsAcquisition(r) {
			t.Fatalf("IsAcquisition(%q) = false, want true", r)
		}
		if IsOpenAccess(r) {
			t.Fatalf("%q must NOT be open-access", r)
		}
	}
	if IsAcquisition(RelEnclosure) {
		t.Fatal("enclosure is not an OPDS acquisition relation")
	}
}

// 合成 fixture：同一 entry 里同时有 borrow 和 open-access，必须只选 open-access。
func TestMixedRelationsPickOnlyOpenAccess(t *testing.T) {
	const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>mixed</title>
  <entry>
    <title>Mixed Book</title>
    <author><name>Some Author</name></author>
    <link rel="http://opds-spec.org/acquisition/borrow" href="https://example.org/borrow.epub" type="application/epub+zip"/>
    <link rel="http://opds-spec.org/acquisition/sample" href="https://example.org/sample.epub" type="application/epub+zip"/>
    <link rel="http://opds-spec.org/acquisition/open-access" href="https://example.org/free.epub" type="application/epub+zip"/>
  </entry>
  <entry>
    <title>Borrow Only</title>
    <link rel="http://opds-spec.org/acquisition/borrow" href="https://example.org/only-borrow.epub" type="application/epub+zip"/>
  </entry>
</feed>`
	items, err := ParseOPDS(strings.NewReader(feed))
	if err != nil {
		t.Fatalf("ParseOPDS: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1 (borrow-only must be dropped)", len(items))
	}
	if items[0].DownloadURL != "https://example.org/free.epub" {
		t.Fatalf("must pick open-access link, got %q", items[0].DownloadURL)
	}
	if items[0].Author != "Some Author" {
		t.Fatalf("author = %q", items[0].Author)
	}
}

// 只有 XHTML（网页正文）的 open-access 条目不能当成"可下载电子书"。
func TestOpenAccessXHTMLIsNotADownloadableBook(t *testing.T) {
	const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Web Only</title>
    <link rel="http://opds-spec.org/acquisition/open-access" href="https://example.org/page" type="application/xhtml+xml"/>
  </entry>
</feed>`
	items, err := ParseOPDS(strings.NewReader(feed))
	if err != nil {
		t.Fatalf("ParseOPDS: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("xhtml-only entry must not produce a download; got %+v", items)
	}
}

// 畸形 XML 必须报错，不能静默返回空。
func TestParseOPDSMalformedXML(t *testing.T) {
	if _, err := ParseOPDS(strings.NewReader("<not-a-feed")); err == nil {
		t.Fatal("malformed XML must be an error")
	}
}

// 空 feed 合法：返回 0 条，不报错。
func TestParseOPDSEmptyFeed(t *testing.T) {
	items, err := ParseOPDS(strings.NewReader(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>empty</title></feed>`))
	if err != nil {
		t.Fatalf("empty feed must not error: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("items = %d, want 0", len(items))
	}
}

// ★ SSRF：内网/回环地址必须被拒（比内置源更严：OPDS 强制 https）。
func TestOPDSSourceRejectsPrivateHosts(t *testing.T) {
	for _, u := range []string{
		"https://127.0.0.1/feed",
		"https://localhost/feed",
		"https://10.0.0.5/feed",
		"https://192.168.1.1/feed",
		"https://169.254.169.254/feed", // 云元数据服务
		"https://172.16.0.1/feed",
	} {
		src := NewOPDSSource("test", u+"?query={query}", "public-domain")
		if _, err := src.Search(context.Background(), "x"); err == nil {
			t.Fatalf("private host %s must be rejected (SSRF guard)", u)
		}
	}
}

// ★ SSRF：明文 http 必须被拒（OPDS 源强制 https）。
func TestOPDSSourceRejectsPlainHTTP(t *testing.T) {
	src := NewOPDSSource("test", "http://example.org/feed?query={query}", "public-domain")
	if _, err := src.Search(context.Background(), "x"); err == nil {
		t.Fatal("plain http must be rejected in production (https only)")
	}
}

// ★ SSRF：重定向到内网必须被拒（CheckRedirect 逐跳校验）。
//
// 攻击形态：给一个**公网** URL，它 302 到 127.0.0.1 或 169.254.169.254
// （云元数据服务）。若只在首次请求前校验主机，重定向就绕过了检查。
// 这里直接单测 CheckRedirect 的行为（比端到端更精确）。
func TestOPDSSourceRejectsRedirectToPrivateHost(t *testing.T) {
	inner := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<feed xmlns="http://www.w3.org/2005/Atom"><title>inner</title></feed>`))
	})

	c := newOPDSClient(0) // 生产配置：allowPrivateHosts=false, allowPlainHTTP=false

	// 跳到内网（httptest 监听 127.0.0.1）→ 必须拒绝
	req, err := http.NewRequest(http.MethodGet, inner.URL, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if err := c.checkRedirect(req, nil); err == nil {
		t.Fatal("CheckRedirect must reject redirect to private host (SSRF via 302)")
	}

	// 跳到云元数据服务（经典 SSRF 目标）→ 必须拒绝
	meta, err := http.NewRequest(http.MethodGet, "https://169.254.169.254/latest/meta-data/", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if err := c.checkRedirect(meta, nil); err == nil {
		t.Fatal("CheckRedirect must reject link-local metadata endpoint")
	}

	// 跳到明文 http 的公网地址 → 也必须拒绝（OPDS 强制 https）
	plain, err := http.NewRequest(http.MethodGet, "http://example.org/feed", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if err := c.checkRedirect(plain, nil); err == nil {
		t.Fatal("CheckRedirect must reject plain http")
	}

	// 反向：跳到公网 https 必须允许（否则正常重定向被误杀）
	pub, err := http.NewRequest(http.MethodGet, "https://standardebooks.org/feeds/opds/all", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if err := c.checkRedirect(pub, nil); err != nil {
		t.Fatalf("public https redirect must be allowed: %v", err)
	}
}

// 用 httptest 验证：Search 能端到端跑通（放开私网仅限测试）。
func TestOPDSSourceSearchEndToEnd(t *testing.T) {
	fixture := string(loadFixture(t, "standardebooks-opds-austen.xml"))
	var gotQuery string
	srv := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("query")
		w.Header().Set("Content-Type", "application/atom+xml;profile=opds-catalog")
		_, _ = w.Write([]byte(fixture))
	})
	src := NewOPDSSource("standard-ebooks", srv.URL+"/feed?query={query}", "public-domain").
		AllowPrivateHostsForTest()

	items, err := src.Search(context.Background(), "austen")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if gotQuery != "austen" {
		t.Fatalf("query not forwarded: %q", gotQuery)
	}
	if len(items) != 7 {
		t.Fatalf("items = %d, want 7", len(items))
	}
	for _, it := range items {
		if it.Source != "standard-ebooks" {
			t.Fatalf("source not stamped: %+v", it)
		}
		if it.License != "public-domain" {
			t.Fatalf("license = %q, want public-domain (built-in source)", it.License)
		}
	}
}

// 上游非 200 → 报错。
func TestOPDSSourceHandlesUpstreamErrors(t *testing.T) {
	srv := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	src := NewOPDSSource("x", srv.URL+"/feed?query={query}", "public-domain").AllowPrivateHostsForTest()
	if _, err := src.Search(context.Background(), "q"); err == nil {
		t.Fatal("non-200 must be an error")
	}
}

// 超时 → 报错。
func TestOPDSSourceTimeout(t *testing.T) {
	srv := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte("<feed/>"))
	})
	src := NewOPDSSource("x", srv.URL+"/feed?query={query}", "public-domain").AllowPrivateHostsForTest()
	src.client.client.Timeout = 50 * time.Millisecond
	if _, err := src.Search(context.Background(), "q"); err == nil {
		t.Fatal("timeout must surface as error")
	}
}

// 缺 {query} 占位 → 明确报错（防止配错 URL 后静默打到列表页）。
func TestOPDSSourceRequiresQueryPlaceholder(t *testing.T) {
	src := NewOPDSSource("x", "https://example.org/feed", "public-domain")
	if _, err := src.Search(context.Background(), "q"); err == nil {
		t.Fatal("missing {query} placeholder must error")
	}
}
