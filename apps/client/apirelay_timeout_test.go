package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// 中继的**超时预算**单测。
//
// 背景（这是"上传大文件必失败"的根因之一）：
//   中继原来给每个请求挂了一个 60 秒的"上游必须开始响应"定时器。
//   但上游在**读完请求体之前不可能发出响应头**，所以这个定时器实际上等价于
//   "60 秒内必须上传完" —— 一本几百 MB 的书必然超时，上传会在中途被 cancel。
//
//   修法：**只有没有请求体的请求**（GET/HEAD/DELETE）才受这个上限约束；
//   带请求体的请求改由 Transport.ResponseHeaderTimeout 兜底
//   （它在写完请求体之后才开始计时，语义正好是"上游收完数据后多久没回话"）。
//
// 另外两条不变式：
//   - 超时必须报 504 + code=upstream_timeout，而不是笼统的 502；
//   - 渲染层的浏览器专属头（Origin/Referer/Cookie/Sec-Fetch-*）不能转发到上游。

// TestAPIRelayUploadIsNotKilledByResponseStartTimer 验证：带请求体的上传
// 即使超过"开始响应"的时限也能完成（这正是大文件上传的场景）。
func TestAPIRelayUploadIsNotKilledByResponseStartTimer(t *testing.T) {
	payload := bytes.Repeat([]byte{0x50, 0x4b, 0x03, 0x04}, 4096)

	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 上游先"忙" 300ms 再读 body —— 这段时间它不可能发出响应头。
		time.Sleep(300 * time.Millisecond)
		got, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("upstream read body failed: %v", err)
			return
		}
		if !bytes.Equal(got, payload) {
			t.Errorf("upstream got %d bytes, want %d", len(got), len(payload))
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"contentHash":"sha256:x"}`))
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	trustTestServer(relay, backend)
	// 把"开始响应"的上限压到 100ms：旧实现必然在这里被掐断。
	relay.responseStartTimeout = 100 * time.Millisecond

	resp := relayDo(t, relay, http.MethodPut, backend.URL+"/v1/books/x/file", bytes.NewReader(payload))
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("upload must survive the response-start budget, got %d: %s", resp.StatusCode, body)
	}
}

// TestAPIRelayResponseStartTimeoutIs504 验证：无请求体的请求超时时报 504。
func TestAPIRelayResponseStartTimeoutIs504(t *testing.T) {
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	trustTestServer(relay, backend)
	relay.responseStartTimeout = 150 * time.Millisecond

	resp := relayDo(t, relay, http.MethodGet, backend.URL+"/v1/books", nil)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusGatewayTimeout {
		t.Fatalf("want 504 on response-start timeout, got %d", resp.StatusCode)
	}
	payload := decodeRelayError(t, resp)
	if payload["code"] != "upstream_timeout" {
		t.Fatalf("want code=upstream_timeout, got %q", payload["code"])
	}
}

// TestAPIRelayStripsBrowserOnlyHeaders 验证：浏览器专属头不转发到上游，
// 但鉴权头必须保留（它属于 API 契约）。
func TestAPIRelayStripsBrowserOnlyHeaders(t *testing.T) {
	var seen http.Header
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	trustTestServer(relay, backend)

	req, err := http.NewRequest(http.MethodGet, relayURL(t, relay, backend.URL+"/v1/me"), nil)
	if err != nil {
		t.Fatalf("build request failed: %v", err)
	}
	req.Header.Set(relayTokenHdr, relay.Token())
	req.Header.Set("Authorization", "Bearer secret-token")
	req.Header.Set("Origin", "http://wails.localhost")
	req.Header.Set("Referer", "http://wails.localhost/")
	req.Header.Set("Cookie", "session=browser-cookie")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header.Set("Sec-Fetch-Mode", "cors")

	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("relay request failed: %v", err)
	}
	defer resp.Body.Close()

	for _, name := range []string{"Origin", "Referer", "Cookie", "Sec-Fetch-Site", "Sec-Fetch-Mode"} {
		if v := seen.Get(name); v != "" {
			t.Errorf("browser-only header %s must not reach upstream, got %q", name, v)
		}
	}
	if got := seen.Get("Authorization"); got != "Bearer secret-token" {
		t.Errorf("Authorization must be forwarded, got %q", got)
	}
	if got := seen.Get(relayTokenHdr); got != "" {
		t.Errorf("relay token must never reach upstream, got %q", got)
	}
}
