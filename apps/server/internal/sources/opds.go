// OPDS 客户端：只解析开放标准（OPDS 1.2 / 2.0 的 Atom 形态），不做通用抓取。
//
// # 为什么是 OPDS 而不是"声明式书源引擎"
//
// 本项目曾规划"声明式 JSON 书源框架"，已按法律意见废弃：那个形态与
// 已被判刑的"书源指令包"同构（预设抓取规则 + 指向第三方站点）。
// OPDS 是**开放标准协议**，客户端实现协议本身不构成"提供侵权规则"。
// 详见 docs/M5-PLAN-LEGAL-CORRECTION.md §12。
//
// # 合法性判据落在协议层（这是本文件的核心设计）
//
// 我们**只对带** `http://opds-spec.org/acquisition/open-access` relation 的链接
// 启用下载。这是 OPDS 协议里可验证的事实，不是"我们觉得它合法"。
//
// 一个 feed 里通常同时存在多种 relation，必须区分：
//
//   - `acquisition/open-access` —— 开放获取，**唯一允许下载的 relation**
//   - `acquisition`（裸的）—— 表示"可获取"，但**不声明开放**。按严格判据不放行。
//   - `acquisition/borrow` / `acquisition/sample` / `acquisition/subscribe`
//     —— 借阅/试读/订阅，明确需要授权，不放行。
//   - `enclosure`（Atom 原生）—— 附件，**不携带 OPDS 授权语义**，不放行。
//
// # 实测发现（这决定了实现必须同时支持两种形态）
//
// 抓取真实源之后发现各源形态并不统一（fixture 见 testdata/）：
//
//   - **Standard Ebooks** 的 `/feeds/opds/all` 是规范 OPDS：35 个
//     `acquisition/open-access` 链接（EPUB / KEPUB / AZW3 / XHTML）。
//     → 走 open-access 判据，**可以下载**。
//   - **Project Gutenberg** 的 `/ebooks/1342.opds` 用的是**裸** `acquisition`
//     （6 个链接，0 个 open-access）。严格按 open-access 判据它**不会**给出下载链。
//     → 这是**故意**的：Gutenberg 的公版属性由我们内置源的 `License` 字段
//     声明（见 gutenberg.go 的 public-domain 标注），而不是靠 OPDS relation。
//     即：内置源的合法性来自**我们对源的核实**，OPDS relation 只对
//     "用户自行添加的 OPDS 地址"起判据作用。两者不混用。
//   - **Standard Ebooks** 的 Atom feed（`/feeds/atom/all`）用 `enclosure`，
//     **不是 OPDS**，也不带 open-access → 不放行（它只是普通 Atom 订阅源）。
//
// 这个区分是刻意的：**不能**因为"Gutenberg 是公版"就把裸 acquisition 也放行，
// 否则用户添加任意 OPDS 地址时，任何声明了 acquisition 的条目都会变成下载链。
package sources

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OPDS 的 acquisition relation 常量（协议字面量，不是我们发明的）。
const (
	// RelAcquisitionOpenAccess 是**唯一**允许下载的 relation。
	RelAcquisitionOpenAccess = "http://opds-spec.org/acquisition/open-access"
	// RelAcquisition 是裸的"可获取"，不声明开放获取。
	RelAcquisition = "http://opds-spec.org/acquisition"
	// RelAcquisitionBorrow 借阅（需要授权）。
	RelAcquisitionBorrow = "http://opds-spec.org/acquisition/borrow"
	// RelAcquisitionSample 试读。
	RelAcquisitionSample = "http://opds-spec.org/acquisition/sample"
	// RelAcquisitionSubscribe 订阅。
	RelAcquisitionSubscribe = "http://opds-spec.org/acquisition/subscribe"
	// RelEnclosure 是 Atom 原生附件，不携带 OPDS 授权语义。
	RelEnclosure = "enclosure"
	// RelImage 封面大图。
	RelImage = "http://opds-spec.org/image"
	// RelThumbnail 封面缩略图。
	RelThumbnail = "http://opds-spec.org/image/thumbnail"
)

// OPDS 相关错误。
var (
	// ErrOPDSNotOpenAccess 表示条目存在但没有任何 open-access 下载链。
	ErrOPDSNotOpenAccess = errors.New("sources: entry has no open-access acquisition link")
	// ErrOPDSNoAcquisition 表示条目完全没有 acquisition 链接。
	ErrOPDSNoAcquisition = errors.New("sources: entry has no acquisition link")
)

// atomFeed 是 OPDS 的 Atom 容器（只取我们需要的字段）。
type atomFeed struct {
	XMLName xml.Name    `xml:"feed"`
	ID      string      `xml:"id"`
	Title   string      `xml:"title"`
	Updated string      `xml:"updated"`
	Entries []atomEntry `xml:"entry"`
}

// atomEntry 是一条书目。
//
// 注意命名空间：OPDS 1.2 里语言既可能是 Atom 原生 <author><name>，
// 也可能是 Dublin Core 的 <dc:language> / <dcterms:language>。
// encoding/xml 对带前缀的元素需要用完整的 namespace URL 匹配。
type atomEntry struct {
	ID         string         `xml:"id"`
	Title      string         `xml:"title"`
	Updated    string         `xml:"updated"`
	Rights     string         `xml:"rights"`
	Authors    []atomName     `xml:"author"`
	Links      []atomLink     `xml:"link"`
	Language   string         `xml:"http://purl.org/dc/elements/1.1/ language"`
	DCLang     string         `xml:"http://purl.org/dc/terms/ language"`
	Categories []atomCategory `xml:"category"`
}

type atomName struct {
	Name string `xml:"name"`
}

type atomCategory struct {
	Term string `xml:"term,attr"`
}

type atomLink struct {
	Rel   string `xml:"rel,attr"`
	Href  string `xml:"href,attr"`
	Type  string `xml:"type,attr"`
	Title string `xml:"title,attr"`
}

// IsOpenAccess 判断该链接是否为开放获取下载链。
//
// 严格相等匹配：`acquisition/open-access` 必须**完整出现**。
// 不接受前缀匹配（否则 `acquisition` 会被误判成开放获取）。
func IsOpenAccess(rel string) bool {
	return strings.EqualFold(strings.TrimSpace(rel), RelAcquisitionOpenAccess)
}

// IsAcquisition 判断是否为任意 acquisition 类 relation（含裸的、借阅、试读等）。
func IsAcquisition(rel string) bool {
	r := strings.ToLower(strings.TrimSpace(rel))
	return r == RelAcquisition || strings.HasPrefix(r, RelAcquisition+"/")
}

// OpenAccessLink 从条目里挑出**唯一**允许下载的链接。
//
// 优先级：application/epub+zip > application/kepub+zip > 其它非文本格式。
// 明确排除 application/xhtml+xml 之类的"网页正文"（那是阅读页，不是可下载电子书）。
//
// 返回 ok=false 表示**没有任何 open-access 下载链**，调用方必须据此
// 拒绝给出 downloadUrl —— 这是整个合法性判据的落点。
func (e *atomEntry) OpenAccessLink() (link atomLink, ok bool) {
	var epub, kepub, other *atomLink
	for i := range e.Links {
		l := &e.Links[i]
		if !IsOpenAccess(l.Rel) {
			continue
		}
		if strings.TrimSpace(l.Href) == "" {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(l.Type)) {
		case "application/epub+zip":
			if epub == nil {
				epub = l
			}
		case "application/kepub+zip":
			if kepub == nil {
				kepub = l
			}
		case "application/xhtml+xml", "text/html", "":
			// 网页正文 / 未知类型：不作为可下载电子书
			continue
		default:
			if other == nil {
				other = l
			}
		}
	}
	switch {
	case epub != nil:
		return *epub, true
	case kepub != nil:
		return *kepub, true
	case other != nil:
		return *other, true
	}
	return atomLink{}, false
}

// CoverLink 挑封面：优先大图，其次缩略图。
func (e *atomEntry) CoverLink() string {
	var thumb string
	for _, l := range e.Links {
		href := strings.TrimSpace(l.Href)
		if href == "" {
			continue
		}
		switch strings.TrimSpace(l.Rel) {
		case RelImage:
			return href
		case RelThumbnail:
			if thumb == "" {
				thumb = href
			}
		}
	}
	return thumb
}

// AuthorName 返回第一个作者名。
func (e *atomEntry) AuthorName() string {
	for _, a := range e.Authors {
		if n := strings.TrimSpace(a.Name); n != "" {
			return n
		}
	}
	return ""
}

// Lang 返回语言（兼容 dc:language 与 dcterms:language）。
func (e *atomEntry) Lang() string {
	return firstNonEmpty(strings.TrimSpace(e.Language), strings.TrimSpace(e.DCLang))
}

// IsOpenAccessFeed 判断 feed 是否声明了 OPDS 目录（用于区分"普通 Atom 订阅源"）。
//
// OPDS 1.2 的 acquisition feed 通常带
// `application/atom+xml;profile=opds-catalog;kind=acquisition`。
// 我们不强求这个 Content-Type（真实源并不总是设置），
// 而是以"条目里是否真的存在 open-access 链接"为准 —— 这是更硬的判据。
func IsOpenAccessFeed(entries []atomEntry) bool {
	for i := range entries {
		if _, ok := entries[i].OpenAccessLink(); ok {
			return true
		}
	}
	return false
}

// ParseOPDS 解析 OPDS/Atom XML 为条目列表。
//
// 纯函数：不碰网络、不碰文件，便于单测直接喂 fixture。
func ParseOPDS(r io.Reader) ([]Item, error) {
	var feed atomFeed
	dec := xml.NewDecoder(r)
	// 真实 feed 里偶尔有未声明实体或非 UTF-8 编码；charset.Reader 由调用方保证。
	if err := dec.Decode(&feed); err != nil {
		return nil, fmt.Errorf("sources: decode OPDS feed: %w", err)
	}
	items := make([]Item, 0, len(feed.Entries))
	for i := range feed.Entries {
		item, ok := feed.Entries[i].toItem()
		if !ok {
			// 没有 open-access 下载链的条目**跳过**（而不是给一个空 downloadUrl）。
			// 这样前端拿到的每一条都可下载，不会出现点了没反应的死链。
			continue
		}
		items = append(items, item)
	}
	return items, nil
}

// toItem 把 Atom 条目归一化成 Item。
//
// **关键**：ok=false 时不返回任何可下载 URL。
func (e *atomEntry) toItem() (Item, bool) {
	link, ok := e.OpenAccessLink()
	if !ok {
		return Item{}, false
	}
	title := strings.TrimSpace(e.Title)
	if title == "" {
		return Item{}, false
	}
	return Item{
		Source:      "", // 由调用方填（不同源标识不同）
		Title:       title,
		Author:      e.AuthorName(),
		Language:    e.Lang(),
		DownloadURL: strings.TrimSpace(link.Href),
		CoverURL:    e.CoverLink(),
		// open-access relation 是协议层的开放获取声明，直接映射成 license。
		License: "open-access",
		Extra: map[string]any{
			"rel":  RelAcquisitionOpenAccess,
			"type": strings.TrimSpace(link.Type),
		},
	}, true
}

// opdsClient 是 OPDS 抓取用的 HTTP 客户端封装。
//
// 安全措施与 Gutenberg 一致并**更严**：
//   - 硬超时（由 http.Client.Timeout 提供）
//   - 响应体大小上限（防止上游异常返回拖垮内存）
//   - 强制 https（OPDS 源不接受明文 http）
//   - SSRF 白名单（禁内网/回环/链路本地）
//   - **重定向也逐跳校验**（防止 302 跳到内网）
type opdsClient struct {
	client            *http.Client
	maxBody           int64
	allowPrivateHosts bool
	allowPlainHTTP    bool
}

func newOPDSClient(timeout time.Duration) *opdsClient {
	if timeout <= 0 {
		timeout = 8 * time.Second
	}
	c := &opdsClient{maxBody: 8 << 20}
	c.client = &http.Client{
		Timeout: timeout,
		// 每一跳重定向都校验目标主机，避免"公网 URL 302 到 127.0.0.1"。
		CheckRedirect: c.checkRedirect,
		// ★ DNS 重绑定防护：**在真正建立连接时**校验解析出来的 IP。
		//
		// 只检查主机名字面量是不够的：攻击者可以注册 evil.example 让它解析到
		// 127.0.0.1 或 169.254.169.254，主机名本身看起来完全"公网"。
		// 在 DialContext 里校验 **解析后的 IP**，能覆盖这种重绑定。
		//
		// 注意：这里仍然存在 TOCTOU 窗口（校验用的解析结果与实际连接的 IP
		// 理论上可能不同），但因为我们在同一个 DialContext 里先解析再拨号，
		// 拨号用的就是我们校验过的那个 IP，窗口被消除。
		Transport: c.newTransport(),
	}
	return c
}

// newTransport 构造带 DNS 重绑定防护的 Transport。
func (c *opdsClient) newTransport() *http.Transport {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, fmt.Errorf("sources: bad dial address %q: %w", addr, err)
			}
			// 解析所有候选 IP
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, fmt.Errorf("sources: resolve %q: %w", host, err)
			}
			if len(ips) == 0 {
				return nil, fmt.Errorf("sources: %q resolved to no address", host)
			}
			// 只要**任何一个**候选 IP 是内网就拒绝整个主机：
			// 否则攻击者可以用"一个公网 IP + 一个内网 IP"的轮询 DNS 绕过。
			for _, ip := range ips {
				if !c.allowPrivateHosts && isPrivateIP(ip.IP) {
					return nil, fmt.Errorf("sources: refusing to connect to private address %s (host %q)", ip.IP, host)
				}
			}
			// 用校验过的第一个 IP 拨号，避免"校验后重新解析"的 TOCTOU。
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		MaxIdleConns:          16,
		IdleConnTimeout:       60 * time.Second,
	}
}

// isPrivateIP 判断解析出来的 IP 是否属于内网/回环/链路本地/保留段。
//
// 比 isPrivateHost（只看主机名字面量）更可靠：这是 DNS 重绑定防护的落点。
func isPrivateIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsInterfaceLocalMulticast() {
		return true
	}
	// IPv4 映射到 IPv6 的情况（例如 ::ffff:127.0.0.1）要还原后再判断。
	if v4 := ip.To4(); v4 != nil {
		// 云元数据服务 169.254.169.254 已被 IsLinkLocalUnicast 覆盖，
		// 但有些实现把 100.64.0.0/10（CGNAT）也算内网，这里一并拒绝。
		if v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
			return true
		}
	}
	return false
}

// checkURL 校验 scheme 与主机是否允许。
func (c *opdsClient) checkURL(u *url.URL) error {
	sch := strings.ToLower(u.Scheme)
	if sch != "https" && !(c.allowPlainHTTP && sch == "http") {
		return fmt.Errorf("sources: refusing non-https scheme %q", u.Scheme)
	}
	if !c.allowPrivateHosts && isPrivateHost(u.Hostname()) {
		return fmt.Errorf("sources: refusing to call private host %q", u.Hostname())
	}
	return nil
}

// checkRedirect 是 http.Client.CheckRedirect：**每一跳**都重新校验目标。
//
// 这是防 SSRF 的关键：只在首次请求前校验主机是不够的，
// 攻击者可以让公网 URL 302 到 127.0.0.1 / 169.254.169.254 绕过检查。
// 独立成方法（而不是内联闭包）是为了能直接单测。
func (c *opdsClient) checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("sources: too many redirects")
	}
	return c.checkURL(req.URL)
}

// fetch 取一个 OPDS feed 并解析。
func (c *opdsClient) fetch(ctx context.Context, rawURL string) ([]Item, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("sources: bad OPDS url: %w", err)
	}
	if err := c.checkURL(u); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	// 明确声明我们接受 OPDS 目录；有些源按 Accept 决定返回 OPDS 还是 HTML。
	req.Header.Set("Accept", "application/atom+xml;profile=opds-catalog, application/atom+xml;q=0.9")
	req.Header.Set("User-Agent", "HPF-Reader/0.1 (+self-hosted)")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("sources: OPDS request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("sources: OPDS returned status %d", resp.StatusCode)
	}
	return ParseOPDS(io.LimitReader(resp.Body, c.maxBody))
}
