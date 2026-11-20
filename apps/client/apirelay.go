package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// APIRelay 是本机「API 中继」：渲染层把 API 请求发给它，它再用 Go 的 TLS 栈
// **严格校验**后转发到真实服务端。
//
// 为什么需要它（P0：C→S 传输认证）：
//   - 桌面端 WebView2 曾经带 `--ignore-certificate-errors`，渲染层 fetch 的 HTTPS
//     实际上不校验证书，链路中间人（含用户自配的远程代理节点）可以拿走 Bearer /
//     refresh token；
//   - 现在 API 请求**完全不经过 Chromium 的 TLS**：渲染层只跟 127.0.0.1 上的本中继
//     说明文 HTTP，中继用独立的 http.Client（系统根证书 + 主机名校验）出网。
//     于是 `--ignore-certificate-errors` 对 API 彻底失效。
//
// 安全约束（改动前请先读）：
//  1. 只允许 https 目标；http 目标仅限本机回环（本地开发用）。
//  2. 必须带 `X-HPF-Relay: <token>`；token 是启动时 32 字节随机数，只经 Wails binding
//     交给前端，不落盘、不写日志。缺失/不匹配一律 403。
//  3. 上游 TLS 校验失败 fail closed（502 + code=upstream_tls_error），
//     日志**只**记录主机名与错误类型，绝不记录 URL query / Authorization / 请求体 / 响应体。
//  4. 响应必须流式：SSE（text/event-stream）与 chunked 逐块 flush，绝不整包缓冲；
//     客户端断开时取消上游请求（r.Context() 直连）。
type APIRelay struct {
	mu       sync.RWMutex
	listener net.Listener
	server   *http.Server
	baseURL  string
	token    string

	// proxyFunc 返回用户配置的上游代理（nil 表示直连）。
	// 保留它是因为用户可能必须经代理才能访问自建服务端；代理只做 TCP/CONNECT 隧道，
	// 证书仍由本中继校验 —— 代理无法在不被察觉的情况下解密 API 流量。
	proxyFunc func(*http.Request) (*url.URL, error)

	// client 与 http.DefaultTransport 完全独立：
	// 后者会被 ProxyService.apply() 按用户代理设置整体替换，且历史上有过放宽校验的写法。
	client *http.Client

	// responseStartTimeout 是"上游必须在多久内开始响应"的上限（默认 60s）。
	// 单测会把它调小来验证「响应头到达后定时器必须解除」，生产永远用默认值。
	responseStartTimeout time.Duration
}

// RelayTransportInfo 是交给前端的连接信息（Wails 会生成对应 TS 模型）。
type RelayTransportInfo struct {
	// BaseURL 形如 http://127.0.0.1:<随机端口>。
	BaseURL string `json:"baseURL"`
	// Token 每次进程启动都不同；前端把它放进 X-HPF-Relay 头。
	Token string `json:"token"`
}

const (
	relayPath       = "/r"
	relayTokenHdr   = "X-HPF-Relay"
	relayTargetQP   = "u"
	relayTimeout    = 60 * time.Second
	relayBufferSize = 32 * 1024
	// relayDrainWait：上游提前回响应时，等请求体读完的最长时间。
	// （正常路径上这个等待是 0 —— body 早就被上游读完了。）
	relayDrainWait = 30 * time.Second
)

// errRelayResponseStartTimeout 是"上游在限定时间内没有开始响应"这个原因的哨兵。
//
// 用 context.WithCancelCause 传下去，才能把它和"客户端断开"（同样是
// context.Canceled）区分开：前者报 504 upstream_timeout，后者不需要报错体。
var errRelayResponseStartTimeout = errors.New("relay: upstream response start timeout")

// NewAPIRelay 创建中继（尚未监听）。
func NewAPIRelay() *APIRelay {
	r := &APIRelay{responseStartTimeout: relayTimeout}

	transport := &http.Transport{
		// ★ 独立 Transport：不继承 http.DefaultTransport，也绝不设置 InsecureSkipVerify。
		// TLSClientConfig 的 RootCAs 为 nil ⇒ 使用系统根证书 + 标准主机名校验。
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: relayTimeout,
		ExpectContinueTimeout: 1 * time.Second,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		IdleConnTimeout:       90 * time.Second,
		Proxy: func(req *http.Request) (*url.URL, error) {
			r.mu.RLock()
			fn := r.proxyFunc
			r.mu.RUnlock()
			if fn == nil {
				return nil, nil
			}
			return fn(req)
		},
	}
	r.client = &http.Client{
		Transport: transport,
		// 不设 Client.Timeout：SSE 是长连接，整包超时会把它切断。
		// 普通请求的 60s 上限由 handleRelay 里的定时器负责（响应头超时另由 Transport 兜底）。
		//
		// ★ 不自动跟随重定向：3xx 原样回给渲染层，由 fetch 按浏览器语义重新发起，
		//   那次请求仍然经过中继（仍由 Go 校验证书）。在 Go 内部跟随会把
		//   Authorization 带到一个渲染层没打算访问的地址，语义也不对。
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return r
}

// SetUpstreamProxyProvider 注入"当前用户代理"的取值函数（可为 nil）。
func (r *APIRelay) SetUpstreamProxyProvider(fn func(*http.Request) (*url.URL, error)) {
	r.mu.Lock()
	r.proxyFunc = fn
	r.mu.Unlock()
}

// setUpstreamRootCAsForTest 是**仅测试使用**的根池注入点：
// 让单测能信任 httptest 的自签证书。注入的是"信任哪些根"，不是跳过校验 ——
// 生产代码没有任何路径调用它，`InsecureSkipVerify` 在整个包里始终为 false。
func (r *APIRelay) setUpstreamRootCAsForTest(pool *x509.CertPool) {
	if transport, ok := r.client.Transport.(*http.Transport); ok && transport.TLSClientConfig != nil {
		transport.TLSClientConfig.RootCAs = pool
	}
}

// Start 在 127.0.0.1 的随机端口开始监听，并生成一次性 token。
func (r *APIRelay) Start() error {
	token, err := randomRelayToken()
	if err != nil {
		return fmt.Errorf("生成中继 token 失败: %w", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("中继监听失败: %w", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc(relayPath, r.handleRelay)

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}

	r.mu.Lock()
	r.listener = ln
	r.server = srv
	r.token = token
	r.baseURL = fmt.Sprintf("http://127.0.0.1:%d", ln.Addr().(*net.TCPAddr).Port)
	r.mu.Unlock()

	go func() {
		_ = srv.Serve(ln)
	}()
	return nil
}

// BaseURL 返回 http://127.0.0.1:<port>。
func (r *APIRelay) BaseURL() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.baseURL
}

// Token 返回本进程的中继 token（仅供 Wails binding 交给前端）。
func (r *APIRelay) Token() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.token
}

// TransportInfo 返回前端连接本中继所需的全部信息。
func (r *APIRelay) TransportInfo() RelayTransportInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return RelayTransportInfo{BaseURL: r.baseURL, Token: r.token}
}

// Close 停止监听。
func (r *APIRelay) Close() error {
	r.mu.Lock()
	srv := r.server
	ln := r.listener
	r.server = nil
	r.listener = nil
	r.mu.Unlock()

	if srv != nil {
		_ = srv.Close()
	}
	if ln != nil {
		return ln.Close()
	}
	return nil
}

// signalingBody 包装请求体，用来观测"它已经被读完"这个事件。
type signalingBody struct {
	io.ReadCloser
	done chan struct{}
	once sync.Once
}

func newSignalingBody(rc io.ReadCloser) *signalingBody {
	return &signalingBody{ReadCloser: rc, done: make(chan struct{})}
}

func (b *signalingBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err != nil {
		b.once.Do(func() { close(b.done) })
	}
	return n, err
}

func (b *signalingBody) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(func() { close(b.done) })
	return err
}

// waitRelayBodyDrained 等到请求体被读完（上游把它读完了 / 写端出错了）。
//
// ★ 这是"上游提前回响应"的兜底：不这样做，渲染层正在上传的 body 会被
//
//	连接关闭打断，浏览器只看到 network_error（而不是真正的 401/413/200）。
//	上限是有意的：如果上游彻底不读 body，这里不能无限等下去。
func waitRelayBodyDrained(body *signalingBody, timeout time.Duration) {
	if body == nil {
		return
	}
	select {
	case <-body.done:
	case <-time.After(timeout):
	}
}

func randomRelayToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// handleRelay 处理一次转发：<base>/r?u=<base64url(目标 URL)>。
func (r *APIRelay) handleRelay(w http.ResponseWriter, req *http.Request) {
	// 预检请求不带自定义头（浏览器规范），必须在 token 校验之前放行。
	// 它不携带也不返回任何数据，因此不构成信息泄漏面。
	if req.Method == http.MethodOptions {
		writeRelayCORS(w, req)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeRelayCORS(w, req)

	if !r.tokenMatches(req.Header.Get(relayTokenHdr)) {
		writeRelayError(w, http.StatusForbidden, "relay_forbidden", "缺少或无效的中继凭据")
		return
	}

	target, err := parseRelayTarget(req.URL.Query().Get(relayTargetQP))
	if err != nil {
		writeRelayError(w, http.StatusBadRequest, "relay_bad_target", err.Error())
		return
	}

	// 客户端断开 ⇒ 取消上游请求（SSE 尤其重要，否则会泄漏长连接）。
	//
	// ★ 用 WithCancelCause：这样"我们自己触发的超时"能和"客户端断开"区分开，
	//   前者要报 504（上游超时），后者是正常取消。两者都是 context.Canceled，
	//   只看 errors.Is(err, context.Canceled) 分不开。
	ctx, cancel := context.WithCancelCause(req.Context())
	defer cancel(nil)

	// 普通请求 60s 上限：约束"上游必须在 60s 内开始响应"（响应头到达即解除）。
	// 不能把它当成整次请求的总时长上限 —— 那会把大文件下载/整本书下载直接切断。
	// 真正的总时长由渲染层自己的 AbortSignal 控制（fetch 侧语义一致）。
	//
	// ★★ 只有**没有请求体**的请求才受这个上限约束：
	//   带请求体（PUT /v1/books/{id}/file 的大文件上传）时，上游在读完请求体之前
	//   不可能发出响应头，所以"60 秒内开始响应"等价于"60 秒内上传完"——
	//   一本几百 MB 的书必然超时，上传会在中途被 cancel 掉。
	//   带体请求改由 Transport.ResponseHeaderTimeout 兜底（它在**写完请求体之后**
	//   才开始计时，语义正好是"上游收完数据后多久没回话"）。
	r.mu.RLock()
	responseStart := r.responseStartTimeout
	r.mu.RUnlock()
	if responseStart <= 0 {
		responseStart = relayTimeout
	}

	// 计时器与"响应头已到"的标记必须互斥，否则会出现两种坏结果：
	//   - 定时器刚触发就把已经建立好的响应流掐掉（SSE / 大文件下载）；
	//   - 响应头已到之后定时器仍然触发，把流砍断。
	var startMu sync.Mutex
	responseStarted := false
	var startTimer *time.Timer
	if req.ContentLength == 0 {
		startTimer = time.AfterFunc(responseStart, func() {
			startMu.Lock()
			defer startMu.Unlock()
			if responseStarted {
				return
			}
			cancel(errRelayResponseStartTimeout)
		})
		defer startTimer.Stop()
	}

	// ★ 用带信号的 body 转发：这样"请求体已被读完"这件事可观测。
	relayBody := newSignalingBody(req.Body)

	outReq, err := http.NewRequestWithContext(ctx, req.Method, target.String(), relayBody)
	if err != nil {
		writeRelayError(w, http.StatusBadRequest, "relay_bad_request", "无法构造上游请求")
		return
	}
	outReq.Header = req.Header.Clone()
	stripHopByHopHeaders(outReq.Header)
	stripBrowserOnlyHeaders(outReq.Header)
	outReq.Header.Del(relayTokenHdr)
	// Host 由 URL 决定；显式清掉以免把 127.0.0.1:port 当作上游 Host 发出去。
	outReq.Host = ""
	// 透传原始长度（二进制上传 / PUT 需要正确的 Content-Length）。
	if req.ContentLength >= 0 {
		outReq.ContentLength = req.ContentLength
	}

	resp, err := r.client.Do(outReq)
	if err != nil {
		r.failUpstream(w, target, err, context.Cause(ctx))
		return
	}
	defer resp.Body.Close()

	// 响应头已到：解除"开始响应"的上限，此后按 body 实际节奏转发
	// （SSE 与分块下载都可能持续很久，不能用固定总超时切断）。
	if startTimer != nil {
		startMu.Lock()
		responseStarted = true
		startMu.Unlock()
		startTimer.Stop()
	}

	// ★★ 上游可能在**读完请求体之前**就回了响应（401 鉴权拒绝 / 413 体积超限 /
	//   秒传命中 200）。这时候如果直接把响应写回渲染层并结束 handler，
	//   渲染层还在写的那个 body 会被连接关闭打断 ⇒ 浏览器表现为 network_error
	//   （"上传卡住/网络错误"），而不是它真正该看到的 401/413。
	//   所以先把请求体读干净（有上限），再把响应写回去。
	waitRelayBodyDrained(relayBody, relayDrainWait)

	stream := isStreamingResponse(resp)

	stripHopByHopHeaders(resp.Header)
	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(resp.StatusCode)

	flusher, canFlush := w.(http.Flusher)
	if stream && canFlush {
		flusher.Flush()
	}

	buf := make([]byte, relayBufferSize)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return
			}
			if stream && canFlush {
				// 逐块 flush：SSE 的第一个 event 必须立刻到达渲染层。
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				// 上游中途断开：连接已开始写，只能结束（不回写错误体，避免污染已发出的响应）。
				return
			}
			return
		}
	}
}

// failUpstream 把上游失败映射成结构化错误（fail closed）。
//
// cause 是 ctx 的取消原因（context.Cause）：用来区分"我们自己超时"与"客户端断开"，
// 两者在 err 上都表现为 context.Canceled，只有 cause 能分开。
func (r *APIRelay) failUpstream(w http.ResponseWriter, target *url.URL, err error, cause error) {
	host := target.Hostname()

	if isUpstreamTLSError(err) {
		// ★ 只记主机名与错误类型：不记 URL query、不记 Authorization、不记任何 body。
		log.Printf("[api-relay] upstream certificate verification failed for %s (%T)", host, unwrapRelayError(err))
		writeRelayError(w, http.StatusBadGateway, "upstream_tls_error", "无法验证上游服务器证书")
		return
	}

	if errors.Is(cause, errRelayResponseStartTimeout) || errors.Is(err, context.DeadlineExceeded) {
		log.Printf("[api-relay] upstream timeout for %s", host)
		writeRelayError(w, http.StatusGatewayTimeout, "upstream_timeout", "上游服务器响应超时")
		return
	}

	log.Printf("[api-relay] upstream request failed for %s (%T)", host, unwrapRelayError(err))
	writeRelayError(w, http.StatusBadGateway, "upstream_error", "上游服务器请求失败")
}

// unwrapRelayError 取到最内层错误，便于日志只显示错误类型而不带可能敏感的上下文。
func unwrapRelayError(err error) error {
	for {
		next := errors.Unwrap(err)
		if next == nil {
			return err
		}
		err = next
	}
}

// isUpstreamTLSError 判断失败是否属于"证书/握手不可信"（要 fail closed 且单独报错码）。
func isUpstreamTLSError(err error) bool {
	var certErr *tls.CertificateVerificationError
	if errors.As(err, &certErr) {
		return true
	}
	var unknownAuthority x509.UnknownAuthorityError
	if errors.As(err, &unknownAuthority) {
		return true
	}
	var hostnameErr x509.HostnameError
	if errors.As(err, &hostnameErr) {
		return true
	}
	var invalidCert x509.CertificateInvalidError
	if errors.As(err, &invalidCert) {
		return true
	}
	var recordHeader tls.RecordHeaderError
	if errors.As(err, &recordHeader) {
		return true
	}
	return false
}

// tokenMatches 常量时间比较，避免时序侧信道。
func (r *APIRelay) tokenMatches(got string) bool {
	r.mu.RLock()
	want := r.token
	r.mu.RUnlock()
	if want == "" || got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// parseRelayTarget 解码并校验目标 URL。
//
// 只允许 https；http 仅限本机回环（本地开发/联调）。其它一律 400 ——
// 明文 API 链路的加固是另一项工作，这里不假装它是安全的，也不当开放代理用。
func parseRelayTarget(encoded string) (*url.URL, error) {
	if strings.TrimSpace(encoded) == "" {
		return nil, errors.New("缺少目标地址")
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("目标地址编码无效")
	}
	target, err := url.Parse(string(raw))
	if err != nil {
		return nil, errors.New("目标地址无法解析")
	}
	if target.Host == "" {
		return nil, errors.New("目标地址缺少主机名")
	}

	switch strings.ToLower(target.Scheme) {
	case "https":
		return target, nil
	case "http":
		if !isLoopbackHost(target.Hostname()) {
			return nil, errors.New("中继只允许 https 目标（http 仅限本机回环）")
		}
		return target, nil
	default:
		return nil, errors.New("中继只允许 https 目标（http 仅限本机回环）")
	}
}

func isLoopbackHost(host string) bool {
	h := strings.ToLower(host)
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// isStreamingResponse 判断响应是否必须流式转发。
func isStreamingResponse(resp *http.Response) bool {
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
		return true
	}
	if resp.ContentLength < 0 {
		return true // chunked / 关闭定界
	}
	return len(resp.TransferEncoding) > 0
}

// stripHopByHopHeaders 去掉逐跳头（RFC 7230 §6.1），它们只对单跳连接有意义。
//
// 顺序很重要：`Connection` 头里列出的自定义逐跳头必须先被读出来再删，
// 否则删掉 Connection 之后就再也看不到那些名字了（会导致逐跳头漏到上游）。
func stripHopByHopHeaders(h http.Header) {
	var listed []string
	for _, value := range h.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			if name = strings.TrimSpace(name); name != "" {
				listed = append(listed, name)
			}
		}
	}
	for _, key := range []string{
		"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
		"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
	} {
		h.Del(key)
	}
	for _, name := range listed {
		h.Del(name)
	}
}

// stripBrowserOnlyHeaders 去掉只属于渲染层浏览器的头。
//
// 中继是"渲染层 → Go → 上游"的桥：上游看到的是一次普通的 API 调用，
// 不应该看到 WebView 的身份信息（Origin= wails.localhost / Referer / Sec-Fetch-*），
// 更不应该收到 WebView 的 Cookie —— 那可能带着用户浏览器的登录态，
// 被原样带到第三方 API 站点上。
//
// ★ Authorization / Content-Type / Range / If-None-Match 等**必须保留**：
//
//	它们是 API 契约的一部分（鉴权、二进制上传、断点续传、缓存校验）。
func stripBrowserOnlyHeaders(h http.Header) {
	for _, name := range []string{
		"Origin", "Referer", "Cookie", "Cookie2",
		"Sec-Fetch-Dest", "Sec-Fetch-Mode", "Sec-Fetch-Site", "Sec-Fetch-User",
		"Sec-Ch-Ua", "Sec-Ch-Ua-Mobile", "Sec-Ch-Ua-Platform", "Sec-Ch-Ua-Arch",
		"Sec-Ch-Ua-Bitness", "Sec-Ch-Ua-Full-Version-List", "Sec-Ch-Ua-Full-Version",
		"Sec-Ch-Ua-Model", "Sec-Ch-Ua-Platform-Version", "Sec-Ch-Ua-Wow64",
		"Upgrade-Insecure-Requests",
	} {
		h.Del(name)
	}
}

// writeRelayCORS 允许渲染层跨源调用本中继。
//
// 没有它，去掉 `--disable-web-security` 后中继会被 CORS 预检拦住；
// 它不降低安全性：真正的门槛是 X-HPF-Relay token（网页拿不到）。
func writeRelayCORS(w http.ResponseWriter, req *http.Request) {
	origin := req.Header.Get("Origin")
	if origin == "" {
		origin = "*"
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", relayTokenHdr+", Authorization, Content-Type, Range, If-None-Match, Accept")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag, Retry-After, Accept-Ranges")
	w.Header().Set("Access-Control-Max-Age", "600")
}

// writeRelayError 输出结构化错误体（与 api/client.ts 的 {code,message} 约定一致）。
func writeRelayError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "message": message})
}

// APIRelayService 把本机 API 中继暴露给前端（Wails binding）。
//
// 独立成 service（而不是塞进 ProxyService）：职责不同 ——
// ProxyService 管"给 WebView/内置浏览器用的系统代理"，APIRelay 管"API 流量的 TLS 校验"。
type APIRelayService struct {
	relay *APIRelay
}

// NewAPIRelayService 创建 binding 服务。
func NewAPIRelayService(relay *APIRelay) *APIRelayService {
	return &APIRelayService{relay: relay}
}

// RelayTransport 返回本机中继的 BaseURL 与一次性 token。
//
// 前端拿到后把 https://<server>/v1/... 改写成
// <BaseURL>/r?u=<base64url(https://<server>/v1/...)> 并附上 X-HPF-Relay 头。
// 目标 URL 由前端给出，因此切换服务器地址**不需要**再通知 Go。
func (s *APIRelayService) RelayTransport() (RelayTransportInfo, error) {
	if s == nil || s.relay == nil || s.relay.BaseURL() == "" {
		return RelayTransportInfo{}, errors.New("API 中继未启动")
	}
	return s.relay.TransportInfo(), nil
}
