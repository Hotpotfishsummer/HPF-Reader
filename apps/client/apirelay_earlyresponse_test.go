package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// 中继的**"上游提前回响应"**单测。
//
// 背景（"上传卡住 / 网络错误"的第二个根因）：
//
//	上游可能在**读完请求体之前**就回响应 —— 401（鉴权拒绝）、413（体积超限）、
//	200（秒传命中）都是这种形状。中继把响应直接写回渲染层并结束 handler，
//	渲染层还在写的那个 body 就会被连接关闭打断 ⇒ 浏览器只看到 network_error，
//	而不是它真正该看到的 401/413/200。
//
//	这里的上游故意**先回 200，再把 body 读完**（模拟秒传/提前拒绝），
//	断言中继必须让**整份 body 都被转发完**（上游收到的字节数 == 全量），
//	也就是渲染层的上传不会被掐断。

// slowBody 是一个"慢速"请求体：每次只吐一点，并统计最终被读走的字节数。
//
// ★ 用它才能复刻浏览器的真实处境：上传还没发完，上游的响应就到了。
//   快客户端（一次性把 body 塞进 socket）永远看不到这个问题。
type slowBody struct {
	data   []byte
	off    int
	read   int64
	chunk  int
	delay  time.Duration
	failed error
}

func (b *slowBody) Read(p []byte) (int, error) {
	if b.off >= len(b.data) {
		return 0, io.EOF
	}
	n := b.chunk
	if n > len(p) {
		n = len(p)
	}
	if b.off+n > len(b.data) {
		n = len(b.data) - b.off
	}
	time.Sleep(b.delay)
	copy(p, b.data[b.off:b.off+n])
	b.off += n
	b.read += int64(n)
	return n, nil
}

func (b *slowBody) Close() error { return nil }

// TestAPIRelayWaitsForRequestBodyBeforeRelayingEarlyResponse 验证：
// 上游提前回响应时，中继仍然让**整份请求体**被转发完 —— 也就是渲染层
// （浏览器）正在进行的上传不会被中继掐断。
func TestAPIRelayWaitsForRequestBodyBeforeRelayingEarlyResponse(t *testing.T) {
	// 1MB 分 64KB 慢速发送 ⇒ 总耗时约 1.6s，足够让"提前响应"插进来。
	payload := bytes.Repeat([]byte{0x50, 0x4b, 0x03, 0x04}, 256*1024)

	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// ★ 提前回响应（不等 body 读完），但**继续把 body 读完**
		//   （这正是服务端修复后的行为：读完再回响应）。
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"deduplicated":true}`))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		_, _ = io.Copy(io.Discard, r.Body)
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	trustTestServer(relay, backend)

	body := &slowBody{data: payload, chunk: 64 * 1024, delay: 25 * time.Millisecond}
	req, err := http.NewRequest(http.MethodPut, relayURL(t, relay, backend.URL+"/v1/books/x/file"), body)
	if err != nil {
		t.Fatalf("build relay request failed: %v", err)
	}
	req.Header.Set(relayTokenHdr, relay.Token())

	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("relay request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}

	// ★ 关键断言：整份 body 都被发出去了。
	//   如果中继提前把响应写回并结束 handler，连接会被关闭 ⇒ 传输中止 ⇒
	//   客户端的 body 读不到末尾（浏览器看到的就是 network_error）。
	if body.read != int64(len(payload)) {
		t.Fatalf("the whole request body must be sent, got %d/%d bytes "+
			"(the relay cut the upload short)", body.read, len(payload))
	}
}

// TestAPIRelayDoesNotDeadlockOnNormalUpload 验证：正常上传路径上，
// "等请求体读完"不会引入额外延迟（body 本来就被上游读完了）。
func TestAPIRelayDoesNotDeadlockOnNormalUpload(t *testing.T) {
	payload := bytes.Repeat([]byte{0x50}, 64*1024)
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Errorf("upstream read failed: %v", err)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"contentHash":"sha256:x"}`))
	}))
	defer backend.Close()

	relay := newTestRelay(t)
	trustTestServer(relay, backend)

	start := time.Now()
	resp := relayDo(t, relay, http.MethodPut, backend.URL+"/v1/books/x/file", bytes.NewReader(payload))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("want 201, got %d", resp.StatusCode)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("normal upload must not be delayed by the drain wait, took %s", elapsed)
	}
}
