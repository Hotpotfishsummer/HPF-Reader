// OPDS 书源实现：把 OPDS 客户端接到 Searcher 接口上。
//
// 这里刻意只做"标准协议 + 已知合法源"，不含任何通用抓取规则。
package sources

import (
	"context"
	"fmt"
	"net/url"
	"strings"
)

// OPDSSource 是一个可搜索的 OPDS 源。
//
// SearchURL 里用 {query} 占位，避免把"拼 URL 规则"变成通用模板引擎 ——
// 我们只支持**一个**占位符，且 URL 由代码内置（用户不能导入）。
type OPDSSource struct {
	name      string
	searchURL string // 含 {query} 占位
	client    *opdsClient
	// license 是该源**整体**的授权标识（内置源由我们核实后写死）。
	license string
}

// 内置 OPDS 源的标识。
const (
	SourceStandardEbooks  = "standard-ebooks"
	SourceOpenLibrary     = "open-library"
	SourceInternetArchive = "internet-archive"
)

// NewOPDSSource 构造一个 OPDS 源。
//
// searchURL 必须含 {query} 占位符；license 是内置源的授权标识。
func NewOPDSSource(name, searchURL, license string) *OPDSSource {
	return &OPDSSource{
		name:      name,
		searchURL: searchURL,
		client:    newOPDSClient(0),
		license:   license,
	}
}

// AllowPrivateHostsForTest 放开 SSRF 白名单与明文 http，**仅供单元测试**
// （httptest 只能监听回环地址且是 http）。生产路径永远为 false。
func (o *OPDSSource) AllowPrivateHostsForTest() *OPDSSource {
	o.client.allowPrivateHosts = true
	o.client.allowPlainHTTP = true
	return o
}

// Name 实现 Searcher。
func (o *OPDSSource) Name() string { return o.name }

// Search 实现 Searcher：拼出搜索 URL、抓 feed、归一化。
func (o *OPDSSource) Search(ctx context.Context, query string) ([]Item, error) {
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("sources: %s: empty query", o.name)
	}
	if !strings.Contains(o.searchURL, "{query}") {
		return nil, fmt.Errorf("sources: %s: search url missing {query} placeholder", o.name)
	}
	raw := strings.ReplaceAll(o.searchURL, "{query}", url.QueryEscape(query))
	items, err := o.client.fetch(ctx, raw)
	if err != nil {
		return nil, err
	}
	for i := range items {
		items[i].Source = o.name
		// 内置源的授权标识由我们核实后写死；条目本身的 open-access
		// relation 已保证它是开放获取资源。
		if o.license != "" {
			items[i].License = o.license
		}
	}
	return items, nil
}

// DefaultOPDSSources 返回内置的合法 OPDS 源。
//
// # 核实状态（务必如实对待，不要假装都验证过）
//
// **standard-ebooks —— 已实测通过（2026-11-03）**
//
//	/feeds/opds/all?query=austen 返回 7 个 entry、35 个 acquisition/open-access 链接。
//	每条 rights 声明为公有领域（美国法域）+ CC0。
//	实测（HPF_LIVE_SOURCES=1 go test -run Live）拿到真实条目，例如
//	  "Northanger Abbey" by Jane Austen → .../jane-austen_northanger-abbey.epub
//	→ license = public-domain
//
// **open-library / internet-archive —— 已配置，但本机网络不可达，未实测**
//
//	当前开发网络下 openlibrary.org:443 与 archive.org:443 均不可达
//	（Test-NetConnection 返回 False，请求 context deadline exceeded）。
//	因此这两个源的**搜索地址与 relation 形态未经真实响应验证**。
//
//	已做的保守处理：
//	  1. 两者都标 mixed-open-access（源内混合公版与借阅），**不**预设它们全是公版；
//	  2. 合法性判据完全交给协议层的 open-access relation —— 即使 URL 或
//	     参数有偏差，最坏结果是"搜不到/返回空"，**不会**给出未经授权资源的下载链；
//	  3. 如需启用，可用 HPF_OPDS_OPEN_LIBRARY_URL / HPF_OPDS_INTERNET_ARCHIVE_URL
//	     覆盖为实际可用的 OPDS 地址。
//
//	⚠️ 接入前**必须**在真实网络下跑一遍 live test 并核对返回的 relation，
//	   确认不是把 HTML 页面当成 OPDS 解析。
func DefaultOPDSSources() []*OPDSSource {
	return []*OPDSSource{
		NewOPDSSource(
			SourceStandardEbooks,
			"https://standardebooks.org/feeds/opds/all?query={query}&per-page=25",
			"public-domain",
		),
		NewOPDSSource(
			SourceOpenLibrary,
			"https://openlibrary.org/feeds/opds/search?query={query}",
			"mixed-open-access",
		),
		NewOPDSSource(
			SourceInternetArchive,
			"https://archive.org/advancedsearch.php?q={query}&fl%5B%5D=identifier&output=atom",
			"mixed-open-access",
		),
	}
}
