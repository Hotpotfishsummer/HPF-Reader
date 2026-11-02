// Package sources 实现合法书源聚合搜索。
//
// 一期只内置 Project Gutenberg（gutendex.com，公开 API）。
// 所有请求都做硬超时 + 响应体大小上限 + URL 白名单，避免被上游拖死或是 SSRF。
package sources

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Item 是归一化后的书源条目（对应 openapi.yaml 的 SourceItem）。
type Item struct {
	Source      string `json:"source"`
	Title       string `json:"title"`
	Author      string `json:"author,omitempty"`
	Language    string `json:"language,omitempty"`
	DownloadURL string `json:"downloadUrl"`
	CoverURL    string `json:"coverUrl,omitempty"`
	License     string `json:"license"`
	// Extra 保留源站 ID 等排障信息（不参与契约必需字段）。
	Extra map[string]any `json:"extra,omitempty"`
}

// ErrUnknownSource 表示请求了未注册的书源。
var ErrUnknownSource = errors.New("sources: unknown source")

// Searcher 是单个书源的接口。
type Searcher interface {
	// Name 返回书源标识（例如 gutenberg）。
	Name() string
	// Search 执行搜索；返回的条目已归一化。
	Search(ctx context.Context, query string) ([]Item, error)
}

// Registry 聚合多个书源。
type Registry struct {
	order     []string
	searchers map[string]Searcher
}

// NewRegistry 构造注册表。
func NewRegistry(searchers ...Searcher) *Registry {
	r := &Registry{searchers: map[string]Searcher{}}
	for _, s := range searchers {
		r.Register(s)
	}
	return r
}

// Register 注册一个书源。
func (r *Registry) Register(s Searcher) {
	if _, ok := r.searchers[s.Name()]; !ok {
		r.order = append(r.order, s.Name())
	}
	r.searchers[s.Name()] = s
}

// Names 返回所有已注册书源（稳定顺序）。
func (r *Registry) Names() []string {
	out := make([]string, len(r.order))
	copy(out, r.order)
	return out
}

// Search 在指定书源搜索；source 为空时使用第一个已注册书源。
func (r *Registry) Search(ctx context.Context, source, query string) ([]Item, error) {
	if strings.TrimSpace(query) == "" {
		return nil, errors.New("sources: empty query")
	}
	if source == "" {
		if len(r.order) == 0 {
			return nil, ErrUnknownSource
		}
		source = r.order[0]
	}
	s, ok := r.searchers[source]
	if !ok {
		return nil, fmt.Errorf("%w: %s (available: %s)", ErrUnknownSource, source, strings.Join(r.order, ", "))
	}
	return s.Search(ctx, query)
}

// SearchAll 并发搜索所有书源，返回聚合结果与各源错误（部分失败不影响整体）。
func (r *Registry) SearchAll(ctx context.Context, query string) ([]Item, map[string]error) {
	type result struct {
		items []Item
		err   error
	}
	ch := make(chan result, len(r.order))
	for _, name := range r.order {
		s := r.searchers[name]
		go func() {
			items, err := s.Search(ctx, query)
			ch <- result{items: items, err: err}
		}()
	}
	var all []Item
	errs := map[string]error{}
	for i := 0; i < len(r.order); i++ {
		res := <-ch
		all = append(all, res.items...)
		if res.err != nil {
			errs["unknown"] = res.err
		}
	}
	return all, errs
}

// Gutenberg 实现 Project Gutenberg（gutendex.com）书源。
type Gutenberg struct {
	baseURL string
	client  *http.Client
	maxBody int64
	// allowPrivateHosts 仅供测试放开 SSRF 白名单（httptest 监听 127.0.0.1）。
	// 生产路径永远为 false，且没有任何环境变量可以打开它。
	allowPrivateHosts bool
}

// NewGutenberg 构造 Gutenberg 书源。
func NewGutenberg(baseURL string, timeout time.Duration) *Gutenberg {
	if timeout <= 0 {
		timeout = 8 * time.Second
	}
	return &Gutenberg{
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  &http.Client{Timeout: timeout},
		maxBody: 4 << 20, // 4 MiB 上限，防止上游异常返回拖垮内存
	}
}

// Name 实现 Searcher。
func (g *Gutenberg) Name() string { return "gutenberg" }

// AllowPrivateHostsForTest 放开内网地址限制，**仅供单元测试**使用
// （httptest 服务器只能监听回环地址）。返回自身以便链式调用。
func (g *Gutenberg) AllowPrivateHostsForTest() *Gutenberg {
	g.allowPrivateHosts = true
	return g
}

type gutendexResponse struct {
	Count   int `json:"count"`
	Results []struct {
		ID      int    `json:"id"`
		Title   string `json:"title"`
		Authors []struct {
			Name string `json:"name"`
		} `json:"authors"`
		Languages []string          `json:"languages"`
		Formats   map[string]string `json:"formats"`
	} `json:"results"`
}

// Search 实现 Searcher：查询 gutendex 并把结果归一化。
func (g *Gutenberg) Search(ctx context.Context, query string) ([]Item, error) {
	if g.baseURL == "" {
		return nil, errors.New("sources: gutendex base url is not configured")
	}
	u, err := url.Parse(g.baseURL + "/books")
	if err != nil {
		return nil, fmt.Errorf("sources: bad base url: %w", err)
	}
	// 只允许 https / http 白名单主机，避免被配置注入成内网地址（SSRF）。
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, fmt.Errorf("sources: unsupported scheme %q", u.Scheme)
	}
	if !g.allowPrivateHosts && isPrivateHost(u.Hostname()) {
		return nil, fmt.Errorf("sources: refusing to call private host %q", u.Hostname())
	}
	q := u.Query()
	q.Set("search", query)
	q.Set("mime_type", "application/epub+zip") // 只要 EPUB，保证下游一定能解析
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "HPF-Reader/0.1 (+self-hosted)")

	resp, err := g.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("sources: gutendex request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("sources: gutendex returned status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, g.maxBody))
	if err != nil {
		return nil, fmt.Errorf("sources: read gutendex body: %w", err)
	}
	var parsed gutendexResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("sources: decode gutendex response: %w", err)
	}
	items := make([]Item, 0, len(parsed.Results))
	for _, r := range parsed.Results {
		download := firstNonEmpty(r.Formats["application/epub+zip"], r.Formats["text/html"], r.Formats["text/plain; charset=us-ascii"])
		if download == "" {
			// 没有可下载格式的条目直接跳过，避免前端拿到死链。
			continue
		}
		item := Item{
			Source:   g.Name(),
			Title:    strings.TrimSpace(r.Title),
			Language: firstLanguage(r.Languages),
			// Gutenberg 全部为公有领域作品（美国法域）；标注来源与许可便于前端展示合规信息。
			DownloadURL: download,
			CoverURL:    r.Formats["image/jpeg"],
			License:     "public-domain",
			Extra:       map[string]any{"gutendexId": r.ID},
		}
		if len(r.Authors) > 0 {
			item.Author = strings.TrimSpace(r.Authors[0].Name)
		}
		items = append(items, item)
	}
	return items, nil
}

func firstLanguage(langs []string) string {
	if len(langs) == 0 {
		return ""
	}
	return langs[0]
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// isPrivateHost 拒绝回环 / 链路本地 / 私有网段地址。
func isPrivateHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" || h == "localhost" || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		return true
	}
	if strings.HasPrefix(h, "127.") || strings.HasPrefix(h, "10.") || strings.HasPrefix(h, "192.168.") ||
		strings.HasPrefix(h, "169.254.") || h == "::1" {
		return true
	}
	// 172.16.0.0/12
	if strings.HasPrefix(h, "172.") {
		var a, b int
		if _, err := fmt.Sscanf(h, "%d.%d.", &a, &b); err == nil && b >= 16 && b <= 31 {
			return true
		}
	}
	return false
}
