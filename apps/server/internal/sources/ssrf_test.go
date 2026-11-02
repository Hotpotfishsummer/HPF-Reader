package sources

import (
	"net"
	"net/http"
	"strings"
	"testing"
)

// ★ DNS 重绑定防护的单元测试。
//
// 攻击形态：注册一个看起来完全正常的公网域名（evil.example），
// 让它的 DNS 解析到 127.0.0.1 / 169.254.169.254。
// 只在主机名字面量上做黑名单（isPrivateHost）**拦不住**这种攻击，
// 因为 "evil.example" 不匹配任何内网前缀。
//
// 防线在 DialContext：先解析，再校验**解析出来的 IP**，然后用校验过的 IP 拨号。
func TestIsPrivateIPBlocksInternalRanges(t *testing.T) {
	mustParse := func(s string) net.IP {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("bad test ip %q", s)
		}
		return ip
	}

	internal := []string{
		"127.0.0.1",        // 回环
		"127.0.0.2",        // 回环段
		"::1",              // IPv6 回环
		"10.0.0.1",         // 私有 A 类
		"172.16.0.1",       // 私有 B 类（低端）
		"172.31.255.254",   // 私有 B 类（高端）
		"192.168.1.1",      // 私有 C 类
		"169.254.169.254",  // ★ 云元数据服务（经典 SSRF 目标）
		"169.254.1.1",      // 链路本地
		"0.0.0.0",          // 未指定
		"100.64.0.1",       // CGNAT
		"::ffff:127.0.0.1", // IPv4 映射到 IPv6 的回环
		"fe80::1",          // IPv6 链路本地
		"fd00::1",          // IPv6 唯一本地
	}
	for _, s := range internal {
		if !isPrivateIP(mustParse(s)) {
			t.Fatalf("isPrivateIP(%s) = false, want true (must be blocked)", s)
		}
	}

	public := []string{
		"8.8.8.8",
		"1.1.1.1",
		"93.184.216.34",   // example.com
		"151.101.1.140",   // fastly
		"2606:4700::1111", // Cloudflare IPv6
	}
	for _, s := range public {
		if isPrivateIP(mustParse(s)) {
			t.Fatalf("isPrivateIP(%s) = true, want false (public address must be allowed)", s)
		}
	}
}

// nil IP 必须按"不安全"处理（fail closed，不是 fail open）。
func TestIsPrivateIPFailsClosed(t *testing.T) {
	if !isPrivateIP(nil) {
		t.Fatal("nil IP must be treated as private (fail closed)")
	}
}

// ★ 端到端：DialContext 必须**在建立连接前**拒绝私网 IP。
//
// 关键：不能只断言"err != nil" —— 拨号到一个没有监听的端口也会 err != nil
// （connection refused），那样测试就是假阳性。必须断言错误**来自我们的防护**。
func TestDialRejectsPrivateIPBeforeConnecting(t *testing.T) {
	// 起一个**真的在监听**的回环服务：如果防护失效，拨号会成功，测试就会红。
	srv := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>`))
	})
	addr := strings.TrimPrefix(srv.URL, "http://")

	c := newOPDSClient(0) // 生产配置：allowPrivateHosts=false
	tr := c.newTransport()

	conn, err := tr.DialContext(t.Context(), "tcp", addr)
	if err == nil {
		_ = conn.Close()
		t.Fatal("DialContext connected to loopback: SSRF guard is not effective")
	}
	// 错误必须来自 IP 校验，而不是网络层（refused/timeout 都说明防护没生效）。
	if !strings.Contains(err.Error(), "private address") {
		t.Fatalf("dial failed for the wrong reason (guard did not fire): %v", err)
	}
}

// 反向：放开 allowPrivateHosts 后 DialContext 必须允许回环（测试才跑得起来）。
func TestDialAllowsPrivateIPWhenExplicitlyAllowed(t *testing.T) {
	srv := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	c := newOPDSClient(0)
	c.allowPrivateHosts = true
	c.allowPlainHTTP = true
	tr := c.newTransport()
	conn, err := tr.DialContext(t.Context(), "tcp", srv.URL[len("http://"):])
	if err != nil {
		t.Fatalf("allowed private host must connect: %v", err)
	}
	_ = conn.Close()
}
