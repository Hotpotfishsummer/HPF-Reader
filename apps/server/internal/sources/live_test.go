package sources

import (
	"context"
	"testing"
	"time"
)

// ★ 真实网络测试：默认 **skip**，需显式开启。
//
//	$env:HPF_LIVE_SOURCES='1'; go test ./internal/sources -run Live -v
//
// 为什么默认 skip：CI / 离线环境不该因为上游挂掉而红。
// 为什么仍要写：**离线 fixture 只能验证我以为的格式**，真实源的
// Content-Type、重定向、命名空间、限流才是真正要对付的东西。
func TestLiveOPDSSources(t *testing.T) {
	if testing.Short() {
		t.Skip("live network test skipped in -short")
	}
	if !liveEnabled() {
		t.Skip("set HPF_LIVE_SOURCES=1 to run live network tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	for _, src := range DefaultOPDSSources() {
		items, err := src.Search(ctx, "austen")
		if err != nil {
			t.Logf("[%s] FAILED: %v", src.Name(), err)
			continue
		}
		t.Logf("[%s] %d items", src.Name(), len(items))
		for i, it := range items {
			if i >= 3 {
				break
			}
			t.Logf("   - %q / %q / %s / %s", it.Title, it.Author, it.License, it.DownloadURL)
		}
		// 关键断言：凡是返回的条目，必须有下载链（没链的已被过滤）。
		for _, it := range items {
			if it.DownloadURL == "" {
				t.Fatalf("[%s] item without downloadUrl leaked through: %+v", src.Name(), it)
			}
		}
	}
}

// 单独验证 Standard Ebooks（已知可用，有 open-access relation）。
func TestLiveStandardEbooksOpenAccess(t *testing.T) {
	if !liveEnabled() {
		t.Skip("set HPF_LIVE_SOURCES=1 to run live network tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	src := NewOPDSSource(SourceStandardEbooks,
		"https://standardebooks.org/feeds/opds/all?query={query}&per-page=25", "public-domain")
	items, err := src.Search(ctx, "austen")
	if err != nil {
		t.Fatalf("live Standard Ebooks search failed: %v", err)
	}
	if len(items) == 0 {
		t.Fatal("expected live items from Standard Ebooks")
	}
	t.Logf("live Standard Ebooks: %d items", len(items))
	for i, it := range items {
		if i >= 5 {
			break
		}
		t.Logf("   %q by %q -> %s (%s)", it.Title, it.Author, it.DownloadURL, it.License)
	}
}
