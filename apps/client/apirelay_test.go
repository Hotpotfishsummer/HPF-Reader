package main

import (
	"bytes"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 本机 API 中继的单测（全程不联网）：
//   - 正常转发：状态码/头/体与上游一致；
//   - 证书不受信：502 + code=upstream_tls_error，且上游**未收到**应用层请求（fail closed）；
//   - SSE 流式：第一个 event 必须在上游结束前到达（证明没有整包缓冲）；
//   - token 缺失/错误 → 403；
//   - 非 https 且非回环目标 → 400。
//
// 测试信任 httptest 自签证书的方式是往 relay 的 Transport 注入根池
// （setUpstreamRootCAsForTest，仅测试可见；生产路径永远为 nil = 系统根证书）。

// newTestRelay 起一个测试用中继。
func newTestRelay(t *testing.T) *APIRelay {
	t.Helper()

	relay := NewAPIRelay()
	if err := relay.Start(); err != nil {
		t.Fatalf("relay.Start failed: %v", err)
	}
	t.Cleanup(func() { _ = relay.Close() })
	return relay
}

// relayURL 把目标 URL 编码成中继地址。
func relayURL(t *testing.T, relay *APIRelay, target string) string {
	t.Helper()
	encoded := base64.RawURLEncoding.EncodeToString([]byte(target))
	return relay.BaseURL() + relayPath + "?" + relayTargetQP + "=" + encoded
}

// relayDo 发一个带正确 token 的中继请求。
func relayDo(t *testing.T, relay *APIRelay, method, target string, body io.Reader) *http.Response {
	t.Helper()

	req, err := http.NewRequest(method, relayURL(t, relay, target), body)
	if err != nil {
		t.Fatalf("build relay request failed: %v", err)
	}
	req.Header.Set(relayTokenHdr, relay.Token())

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("relay request failed: %v", err)
	}
	return resp
}

func trustTestServer(relay *APIRelay, srv *httptest.Server) {
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	relay.setUpstreamRootCAsForTest(pool)
}

func decodeRelayError(t *testing.T, resp *http.Response) map[string]string {
	t.Helper()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read error body failed: %v", err)
	}
	var payload map[string]string
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("error body must be JSON, got %q: %v", string(raw), err)
	}
	return payload
}

func TestAPIRelayRelayTransportInfo(t *testing.T) {
	relay := newTestRelay(t)

	info := relay.TransportInfo()
	if info.BaseURL != relay.BaseURL() {
		t.Fatalf("BaseURL mismatch: %q vs %q", info.BaseURL, relay.BaseURL())
	}
	if !strings.HasPrefix(info.BaseURL, "http://127.0.0.1:") {
		t.Fatalf("relay must listen on loopback, got %q", info.BaseURL)
	}
	if len(info.Token) < 32 {
		t.Fatalf("relay token looks too short (%d chars)", len(info.Token))
	}

	// binding 层的服务也必须能拿到同样的信息。
	svc := NewAPIRelayService(relay)
	got, err := svc.RelayTransport()
	if err != nil {
		t.Fatalf("RelayTransport failed: %v", err)
	}
	if got != info {
		t.Fatalf("binding transport mismatch: %+v vs %+v", got, info)
	}

	// 未启动的中继必须报错，而不是返回空地址让前端直连。
	if _, err := NewAPIRelayService(NewAPIRelay()).RelayTransport(); err == nil {
		t.Fatalf("expected error for relay that was never started")
	}
}

func TestAPIRelayForwardsRequestAndResponse(t *testing.T) {
	const wantBody = `{"items":[],"nextCursor":null}`

	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/books" {
			t.Errorf("unexpected upstream path: %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("limit"); got != "200" {
			t.Errorf("query string must be forwarded, got limit=%q", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization must be forwarded, got %q", got)
		}
		if got := r.Header.Get(relayTokenHdr); got != "" {
			t.Errorf("relay token must not leak upstream, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("ETag", `"abc123"`)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, wantBody)
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	trustTestServer(relay, backend)

	req, err := http.NewRequest(http.MethodGet, relayURL(t, relay, backend.URL+"/v1/books?limit=200"), nil)
	if err != nil {
		t.Fatalf("build request failed: %v", err)
	}
	req.Header.Set(relayTokenHdr, relay.Token())
	req.Header.Set("Authorization", "Bearer test-token")

	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("relay request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body failed: %v", err)
	}
	if string(body) != wantBody {
		t.Fatalf("body mismatch: want %q, got %q", wantBody, string(body))
	}
	if got := resp.Header.Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("Content-Type must be relayed, got %q", got)
	}
	if got := resp.Header.Get("ETag"); got != `"abc123"` {
		t.Fatalf("ETag must be relayed, got %q", got)
	}
}

func TestAPIRelayForwardsBinaryBodyAndRangeHeaders(t *testing.T) {
	payload := bytes.Repeat([]byte{0x00, 0xff, 0x10, 0x7f}, 64)

	var seenContentLength int64 = -1
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenContentLength = r.ContentLength
		if got := r.Header.Get("Range"); got != "bytes=0-255" {
			t.Errorf("Range header must be forwarded, got %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/octet-stream" {
			t.Errorf("Content-Type must be forwarded, got %q", got)
		}
		// 模拟 206 Partial Content + Content-Range。
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(payload)-1, len(payload)))
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(payload)
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	trustTestServer(relay, backend)

	req, err := http.NewRequest(http.MethodPut, relayURL(t, relay, backend.URL+"/v1/books/x/file"), bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("build request failed: %v", err)
	}
	req.Header.Set(relayTokenHdr, relay.Token())
	req.Header.Set("Range", "bytes=0-255")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.ContentLength = int64(len(payload))

	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("relay request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("expected 206, got %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body failed: %v", err)
	}
	if !bytes.Equal(body, payload) {
		t.Fatalf("binary body was corrupted: %d bytes in, %d bytes out", len(payload), len(body))
	}
	if got := resp.Header.Get("Content-Range"); got == "" {
		t.Fatalf("Content-Range must be relayed")
	}
	if got := resp.Header.Get("Accept-Ranges"); got != "bytes" {
		t.Fatalf("Accept-Ranges must be relayed, got %q", got)
	}
	if seenContentLength != int64(len(payload)) {
		t.Fatalf("request Content-Length must be forwarded: want %d, got %d", len(payload), seenContentLength)
	}
}

func TestAPIRelayFailsClosedOnUntrustedCertificate(t *testing.T) {
	var upstreamHits atomic.Int32

	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"leaked":true}`)
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	// 不注入根池：上游自签证书不受系统信任 → 必须 fail closed。
	relay.setUpstreamRootCAsForTest(x509.NewCertPool())

	resp := relayDo(t, relay, http.MethodGet, backend.URL+"/v1/secret", nil)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502 for untrusted upstream, got %d", resp.StatusCode)
	}
	payload := decodeRelayError(t, resp)
	if payload["code"] != "upstream_tls_error" {
		t.Fatalf("expected code=upstream_tls_error, got %q (message=%q)", payload["code"], payload["message"])
	}
	if strings.Contains(strings.ToLower(payload["message"]), "leaked") {
		t.Fatalf("error body must not contain upstream payload: %q", payload["message"])
	}
	if hits := upstreamHits.Load(); hits != 0 {
		t.Fatalf("fail closed violated: upstream handler was reached %d time(s)", hits)
	}
}

func TestAPIRelayStreamsSSEWithoutBuffering(t *testing.T) {
	const firstEvent = "data: first\n\n"
	const secondEvent = "data: second\n\n"
	const delay = 300 * time.Millisecond

	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)

		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Errorf("test upstream cannot flush")
			return
		}
		_, _ = io.WriteString(w, firstEvent)
		flusher.Flush()

		time.Sleep(delay)

		_, _ = io.WriteString(w, secondEvent)
		flusher.Flush()
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	trustTestServer(relay, backend)

	start := time.Now()
	resp := relayDo(t, relay, http.MethodGet, backend.URL+"/v1/events", nil)
	defer resp.Body.Close()

	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("expected text/event-stream, got %q", ct)
	}

	buf := make([]byte, len(firstEvent))
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatalf("read first SSE chunk failed: %v", err)
	}
	elapsed := time.Since(start)
	if string(buf) != firstEvent {
		t.Fatalf("unexpected first chunk: %q", string(buf))
	}
	// 若中继整包缓冲，第一块只能在上游 handler 返回（≈300ms）之后才到达。
	if elapsed >= 250*time.Millisecond {
		t.Fatalf("first SSE event was buffered by the relay: arrived after %v", elapsed)
	}

	rest, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read rest of SSE stream failed: %v", err)
	}
	if !strings.Contains(string(rest), "data: second") {
		t.Fatalf("expected second SSE event, got %q", string(rest))
	}
}

func TestAPIRelayRejectsMissingOrWrongToken(t *testing.T) {
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("upstream must not be reached without a valid relay token")
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	trustTestServer(relay, backend)
	target := relayURL(t, relay, backend.URL+"/v1/books")

	cases := []struct {
		name  string
		token string
	}{
		{name: "missing token", token: ""},
		{name: "wrong token", token: "definitely-not-the-token"},
		{name: "empty-ish token", token: " "},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, target, nil)
			if err != nil {
				t.Fatalf("build request failed: %v", err)
			}
			if tc.token != "" {
				req.Header.Set(relayTokenHdr, tc.token)
			}
			resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusForbidden {
				t.Fatalf("expected 403, got %d", resp.StatusCode)
			}
			if code := decodeRelayError(t, resp)["code"]; code != "relay_forbidden" {
				t.Fatalf("expected relay_forbidden, got %q", code)
			}
		})
	}
}

func TestAPIRelayRejectsNonHTTPSNonLoopbackTargets(t *testing.T) {
	relay := newTestRelay(t)

	rejected := []string{
		"http://example.com/v1/books",
		"http://192.168.1.50:8080/v1/books",
		"ftp://example.com/x",
		"file:///etc/passwd",
	}
	for _, target := range rejected {
		t.Run(target, func(t *testing.T) {
			resp := relayDo(t, relay, http.MethodGet, target, nil)
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("expected 400 for %q, got %d", target, resp.StatusCode)
			}
			if code := decodeRelayError(t, resp)["code"]; code != "relay_bad_target" {
				t.Fatalf("expected relay_bad_target, got %q", code)
			}
		})
	}
}

func TestAPIRelayAllowsLoopbackHTTPTarget(t *testing.T) {
	// 本地开发：http 只对回环放行（自建后端默认 http://127.0.0.1:8080）。
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	resp := relayDo(t, relay, http.MethodGet, backend.URL+"/healthz", nil)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for loopback http target, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{"ok":true}` {
		t.Fatalf("unexpected body: %q", string(body))
	}
}

func TestAPIRelayPreflightNeedsNoToken(t *testing.T) {
	// CORS 预检不带自定义头（浏览器规范），必须在 token 校验之前放行，
	// 否则去掉 --disable-web-security 后中继会被预检拦死。
	relay := newTestRelay(t)

	req, err := http.NewRequest(http.MethodOptions, relay.BaseURL()+relayPath+"?u=whatever", nil)
	if err != nil {
		t.Fatalf("build preflight failed: %v", err)
	}
	req.Header.Set("Origin", "http://wails.localhost")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", relayTokenHdr+", Authorization")

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("preflight failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 for preflight, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got == "" {
		t.Fatalf("preflight must return Access-Control-Allow-Origin")
	}
	if got := resp.Header.Get("Access-Control-Allow-Headers"); !strings.Contains(got, relayTokenHdr) {
		t.Fatalf("preflight must allow the relay token header, got %q", got)
	}
}

func TestAPIRelayRejectsBadTargetEncoding(t *testing.T) {
	relay := newTestRelay(t)

	cases := []string{
		relay.BaseURL() + relayPath,
		relay.BaseURL() + relayPath + "?u=" + base64.RawURLEncoding.EncodeToString([]byte("not a url")),
		relay.BaseURL() + relayPath + "?u=!!!not-base64!!!",
	}
	for _, target := range cases {
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatalf("build request failed: %v", err)
		}
		req.Header.Set(relayTokenHdr, relay.Token())
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			t.Fatalf("request failed: %v", err)
		}
		status := resp.StatusCode
		_ = resp.Body.Close()
		if status != http.StatusBadRequest {
			t.Fatalf("expected 400 for %q, got %d", target, status)
		}
	}
}

func TestRelayTargetHostValidation(t *testing.T) {
	// 目标校验的纯函数行为（含 IPv6 / 回环判定）。
	ok := []string{
		"https://api.example.com/v1/books",
		"https://127.0.0.1:8443/v1/books",
		"http://127.0.0.1:8080/healthz",
		"http://localhost:8080/healthz",
		"http://[::1]:8080/healthz",
	}
	for _, raw := range ok {
		encoded := base64.RawURLEncoding.EncodeToString([]byte(raw))
		if _, err := parseRelayTarget(encoded); err != nil {
			t.Errorf("expected %q to be accepted, got: %v", raw, err)
		}
	}

	bad := []string{
		"http://example.com/v1/books",
		"http://10.0.0.5:8080/",
		"ws://example.com/x",
		"https://",
	}
	for _, raw := range bad {
		encoded := base64.RawURLEncoding.EncodeToString([]byte(raw))
		if _, err := parseRelayTarget(encoded); err == nil {
			t.Errorf("expected %q to be rejected", raw)
		}
	}
}

func TestAPIRelayDoesNotFollowRedirects(t *testing.T) {
	// 3xx 必须原样回给渲染层（由 fetch 重新发起，仍经中继）。
	// 若中继在 Go 内部跟随重定向，Authorization 会被带到一个渲染层没打算访问的地址。
	var leakedHits atomic.Int32

	redirectTarget := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leakedHits.Add(1)
		_, _ = io.WriteString(w, `{"should":"not-be-reached-by-relay"}`)
	}))
	defer redirectTarget.Close()

	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, redirectTarget.URL+"/elsewhere", http.StatusFound)
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	pool := x509.NewCertPool()
	pool.AddCert(backend.Certificate())
	pool.AddCert(redirectTarget.Certificate())
	relay.setUpstreamRootCAsForTest(pool)

	req, err := http.NewRequest(http.MethodGet, relayURL(t, relay, backend.URL+"/v1/books"), nil)
	if err != nil {
		t.Fatalf("build request failed: %v", err)
	}
	req.Header.Set(relayTokenHdr, relay.Token())
	req.Header.Set("Authorization", "Bearer secret-token")

	resp, err := (&http.Client{
		Timeout: 15 * time.Second,
		// 客户端也不跟随，才能看到 302 本身。
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}).Do(req)
	if err != nil {
		t.Fatalf("relay request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusFound {
		t.Fatalf("expected 302 to be relayed as-is, got %d", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != redirectTarget.URL+"/elsewhere" {
		t.Fatalf("Location header must be relayed, got %q", loc)
	}
	if hits := leakedHits.Load(); hits != 0 {
		t.Fatalf("relay must not follow redirects itself; redirect target was hit %d time(s)", hits)
	}
}

func TestAPIRelayDoesNotCutOffSlowStreamAfterResponseStart(t *testing.T) {
	// 回归：60s 上限只能约束"上游何时开始响应"，不能当作整次请求的总时长，
	// 否则大文件下载 / 长 SSE 会被切断。这里把上限调到 50ms，让上游先回响应头、
	// 再慢慢发 body —— 全程远超 50ms，但必须完整到达。
	const chunk = "data: chunk\n\n"

	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for i := 0; i < 3; i++ {
			_, _ = io.WriteString(w, chunk)
			flusher.Flush()
			time.Sleep(120 * time.Millisecond)
		}
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	relay.mu.Lock()
	relay.responseStartTimeout = 50 * time.Millisecond
	relay.mu.Unlock()
	trustTestServer(relay, backend)

	resp := relayDo(t, relay, http.MethodGet, backend.URL+"/v1/events", nil)
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read stream failed: %v", err)
	}
	if want := strings.Repeat(chunk, 3); string(body) != want {
		t.Fatalf("stream must be relayed in full despite the response-start timeout: want %q, got %q", want, string(body))
	}
}

func TestAPIRelayActualResponseCarriesCORSHeaders(t *testing.T) {
	// Windows WebView 的页面源是 http://wails.localhost（明文），
	// 所以到 http://127.0.0.1:<relay> 的请求是跨源：除了预检，**实际响应**也必须带
	// Access-Control-Allow-Origin，否则浏览器会丢掉响应体（哪怕状态码是 200）。
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer backend.Close()

	relay := newTestRelay(t)

	req, err := http.NewRequest(http.MethodGet, relayURL(t, relay, backend.URL+"/healthz"), nil)
	if err != nil {
		t.Fatalf("build request failed: %v", err)
	}
	req.Header.Set(relayTokenHdr, relay.Token())
	req.Header.Set("Origin", "http://wails.localhost")

	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("relay request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://wails.localhost" {
		t.Fatalf("actual response must echo the Origin for CORS, got %q", got)
	}
	if got := resp.Header.Get("Access-Control-Expose-Headers"); !strings.Contains(got, "Content-Range") {
		t.Fatalf("Range 下载需要暴露 Content-Range，got %q", got)
	}
}

func TestAPIRelayBaseURLIsLoopbackOnly(t *testing.T) {
	relay := newTestRelay(t)
	parsed, err := url.Parse(relay.BaseURL())
	if err != nil {
		t.Fatalf("parse base url failed: %v", err)
	}
	host := parsed.Hostname()
	if host != "127.0.0.1" {
		t.Fatalf("relay must bind loopback only, got %q", host)
	}
	if port := parsed.Port(); port == "" || port == "0" {
		t.Fatalf("relay must listen on a concrete random port, got %q", port)
	}
}
