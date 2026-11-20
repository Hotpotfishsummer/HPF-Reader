package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/net/proxy"
)

// ProxyConfig 存储代理配置信息。
type ProxyConfig struct {
	Enabled bool   `json:"enabled"`
	Type    string `json:"type"` // "http" 或 "socks5"
	Host    string `json:"host"` // 默认 "127.0.0.1"
	Port    int    `json:"port"` // 默认 7890
}

// ProxyTestResult 是代理测试结果。
type ProxyTestResult struct {
	Success   bool   `json:"success"`
	LatencyMs int64  `json:"latencyMs"`
	Message   string `json:"message"`
}

type bufferedConn struct {
	net.Conn
	r io.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) {
	return b.r.Read(p)
}

// ProxyService 管理网络代理设置，并启动本地透明代理分发器供 WebView 与应用即时生效。
type ProxyService struct {
	app       *application.App
	mu        sync.RWMutex
	dir       string
	config    ProxyConfig
	localPort int
	listener  net.Listener
	mitm      *mitmManager
}

// NewProxyService 创建并加载代理配置服务，同时启动本地中继代理服务器。
func NewProxyService() *ProxyService {
	s := &ProxyService{
		config: ProxyConfig{
			Enabled: false,
			Type:    "http",
			Host:    "127.0.0.1",
			Port:    7890,
		},
	}
	if mitm, err := newMitmManager(); err == nil {
		s.mitm = mitm
	} else {
		fmt.Printf("[ProxyService] warning: 初始化 MITM 管理器失败: %v\n", err)
	}
	if err := s.load(); err != nil {
		detected := s.DetectSystemProxy()
		if detected.Port > 0 {
			s.config = detected
		}
	}
	s.startLocalProxy()
	s.apply()
	return s
}

// DetectSystemProxy 尝试自动读取操作系统的系统代理配置（Windows 注册表或环境变量）。
func (s *ProxyService) DetectSystemProxy() ProxyConfig {
	cfg := ProxyConfig{
		Enabled: false,
		Type:    "http",
		Host:    "127.0.0.1",
		Port:    7890,
	}

	// 1. 尝试从常见环境变量读取
	for _, envKey := range []string{"HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy"} {
		val := strings.TrimSpace(os.Getenv(envKey))
		if val != "" {
			if u, err := url.Parse(val); err == nil && u.Host != "" {
				cfg.Enabled = true
				if strings.HasPrefix(strings.ToLower(u.Scheme), "socks") {
					cfg.Type = "socks5"
				} else {
					cfg.Type = "http"
				}
				host, portStr, err := net.SplitHostPort(u.Host)
				if err == nil {
					cfg.Host = host
					if p, err := strconv.Atoi(portStr); err == nil && p > 0 {
						cfg.Port = p
						return cfg
					}
				}
			}
		}
	}

	// 2. 在 Windows 上尝试从注册表读取系统代理
	if winCfg, ok := readWindowsSystemProxy(); ok {
		return winCfg
	}

	return cfg
}

func (s *ProxyService) attach(app *application.App) {
	s.app = app
}

// LocalPort 返回本地代理中继服务器的监听端口。
func (s *ProxyService) LocalPort() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.localPort
}

// Close 停止本地代理服务监听器。
func (s *ProxyService) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener != nil {
		err := s.listener.Close()
		s.listener = nil
		return err
	}
	return nil
}

// startLocalProxy 在本地随机可用端口启动 HTTP/HTTPS CONNECT 转发中继服务。
// WebView2 启动时配置此本地代理，之后的每次请求由 Go 根据用户的实时代理配置动态转发。
func (s *ProxyService) startLocalProxy() {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return
	}
	s.listener = ln
	s.localPort = ln.Addr().(*net.TCPAddr).Port

	server := &http.Server{
		Handler: http.HandlerFunc(s.handleProxyRequest),
	}

	go func() {
		_ = server.Serve(ln)
	}()
}

func (s *ProxyService) handleProxyRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		s.handleConnect(w, r)
	} else {
		s.handleHTTP(w, r)
	}
}

func (s *ProxyService) dialTarget(targetHost string) (net.Conn, error) {
	s.mu.RLock()
	cfg := s.config
	s.mu.RUnlock()

	// 1. 若未开启代理或配置无效，直连目标
	if !cfg.Enabled || cfg.Host == "" || cfg.Port <= 0 {
		return net.DialTimeout("tcp", targetHost, 10*time.Second)
	}

	// 2. SOCKS5 代理
	if strings.ToLower(cfg.Type) == "socks5" {
		proxyAddr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
		dialer, err := proxy.SOCKS5("tcp", proxyAddr, nil, proxy.Direct)
		if err != nil {
			return nil, fmt.Errorf("创建 SOCKS5 拨号器失败: %w", err)
		}
		return dialer.Dial("tcp", targetHost)
	}

	// 3. HTTP 代理
	// ★ 用 net.JoinHostPort：IPv6 主机必须写成 [::1]:7890，
	//   fmt.Sprintf("%s:%d") 会拼出 ::1:7890 这种非法地址。
	proxyAddr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	pConn, err := net.DialTimeout("tcp", proxyAddr, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("连接上游 HTTP 代理 %s 失败: %w", proxyAddr, err)
	}

	req := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Connection: Keep-Alive\r\n\r\n", targetHost, targetHost)
	if _, err := pConn.Write([]byte(req)); err != nil {
		_ = pConn.Close()
		return nil, fmt.Errorf("发送 CONNECT 到上游代理失败: %w", err)
	}

	br := bufio.NewReader(pConn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		_ = pConn.Close()
		return nil, fmt.Errorf("读取上游代理响应失败: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = pConn.Close()
		return nil, fmt.Errorf("上游代理返回错误: %s", resp.Status)
	}

	if br.Buffered() > 0 {
		return &bufferedConn{Conn: pConn, r: io.MultiReader(br, pConn)}, nil
	}
	return pConn, nil
}

func (s *ProxyService) handleConnect(w http.ResponseWriter, r *http.Request) {
	targetConn, err := s.dialTarget(r.Host)
	if err != nil {
		http.Error(w, fmt.Sprintf("无法连接目标 %s: %v", r.Host, err), http.StatusBadGateway)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		targetConn.Close()
		http.Error(w, "webserver does not support hijacking", http.StatusInternalServerError)
		return
	}

	clientConn, rw, err := hijacker.Hijack()
	if err != nil {
		targetConn.Close()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if _, err := clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		clientConn.Close()
		targetConn.Close()
		return
	}

	var reader io.Reader = clientConn
	if rw != nil && rw.Reader != nil && rw.Reader.Buffered() > 0 {
		reader = io.MultiReader(rw.Reader, clientConn)
	}

	if s.mitm != nil && shouldInterceptHost(r.Host) {
		go s.mitm.handleInterceptConnect(&bufferedConn{Conn: clientConn, r: reader}, targetConn, r.Host)
		return
	}

	go func() {
		defer targetConn.Close()
		defer clientConn.Close()
		n, cErr := io.Copy(targetConn, reader)
		if cErr != nil {
			fmt.Printf("[handleConnect] copy client->target err: %v (n=%d)\n", cErr, n)
		}
	}()

	go func() {
		defer targetConn.Close()
		defer clientConn.Close()
		n, cErr := io.Copy(clientConn, targetConn)
		if cErr != nil {
			fmt.Printf("[handleConnect] copy target->client err: %v (n=%d)\n", cErr, n)
		}
	}()
}

func (s *ProxyService) handleHTTP(w http.ResponseWriter, r *http.Request) {
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, r.RequestURI, r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	outReq.Header = r.Header.Clone()

	s.mu.RLock()
	cfg := s.config
	s.mu.RUnlock()

	transport := &http.Transport{}
	if cfg.Enabled && cfg.Host != "" && cfg.Port > 0 {
		scheme := "http"
		if strings.ToLower(cfg.Type) == "socks5" {
			scheme = "socks5"
		}
		if u, err := url.Parse(fmt.Sprintf("%s://%s:%d", scheme, cfg.Host, cfg.Port)); err == nil {
			transport.Proxy = http.ProxyURL(u)
		}
	}

	resp, err := transport.RoundTrip(outReq)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if shouldInterceptHost(r.Host) {
		resp.Header.Del("X-Frame-Options")
		if csp := resp.Header.Get("Content-Security-Policy"); csp != "" {
			cleaned := stripFrameAncestors(csp)
			if cleaned != "" {
				resp.Header.Set("Content-Security-Policy", cleaned)
			} else {
				resp.Header.Del("Content-Security-Policy")
			}
		}
		cookies := resp.Header.Values("Set-Cookie")
		if len(cookies) > 0 {
			resp.Header.Del("Set-Cookie")
			for _, c := range cookies {
				resp.Header.Add("Set-Cookie", adaptCookieForIframe(c))
			}
		}
		resp = transformHTMLBody(resp, r.Host)
	}

	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (s *ProxyService) configPath() (string, error) {
	if s.dir == "" {
		dir, err := dataDir()
		if err != nil {
			return "", err
		}
		s.dir = dir
	}
	return filepath.Join(s.dir, "proxy.json"), nil
}

func (s *ProxyService) load() error {
	path, err := s.configPath()
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var cfg ProxyConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return err
	}
	s.mu.Lock()
	s.config = cfg
	s.mu.Unlock()
	return nil
}

func (s *ProxyService) save() error {
	path, err := s.configPath()
	if err != nil {
		return err
	}
	s.mu.RLock()
	raw, err := json.MarshalIndent(s.config, "", "  ")
	s.mu.RUnlock()
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o644)
}

func (s *ProxyService) apply() {
	s.mu.RLock()
	cfg := s.config
	s.mu.RUnlock()

	if !cfg.Enabled || cfg.Host == "" || cfg.Port <= 0 {
		_ = os.Unsetenv("HTTP_PROXY")
		_ = os.Unsetenv("HTTPS_PROXY")
		_ = os.Unsetenv("ALL_PROXY")
		_ = os.Unsetenv("http_proxy")
		_ = os.Unsetenv("https_proxy")
		_ = os.Unsetenv("all_proxy")
		http.DefaultTransport = &http.Transport{
			Proxy: http.ProxyFromEnvironment,
		}
		return
	}

	scheme := "http"
	if strings.ToLower(cfg.Type) == "socks5" {
		scheme = "socks5"
	}
	proxyURL := fmt.Sprintf("%s://%s:%d", scheme, cfg.Host, cfg.Port)

	_ = os.Setenv("HTTP_PROXY", proxyURL)
	_ = os.Setenv("HTTPS_PROXY", proxyURL)
	_ = os.Setenv("ALL_PROXY", proxyURL)
	_ = os.Setenv("http_proxy", proxyURL)
	_ = os.Setenv("https_proxy", proxyURL)
	_ = os.Setenv("all_proxy", proxyURL)

	if u, err := url.Parse(proxyURL); err == nil {
		http.DefaultTransport = &http.Transport{
			Proxy: http.ProxyURL(u),
		}
	}
}

// GetConfig 返回当前代理配置。
func (s *ProxyService) GetConfig() ProxyConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config
}

// SaveConfig 保存并即时应用代理配置。
func (s *ProxyService) SaveConfig(cfg ProxyConfig) error {
	if cfg.Port < 0 || cfg.Port > 65535 {
		return fmt.Errorf("无效的代理端口: %d", cfg.Port)
	}
	if cfg.Host == "" {
		cfg.Host = "127.0.0.1"
	}
	if cfg.Type == "" {
		cfg.Type = "http"
	}

	s.mu.Lock()
	s.config = cfg
	s.mu.Unlock()

	if err := s.save(); err != nil {
		return err
	}
	s.apply()
	return nil
}

// TestProxy 测试指定配置的代理连通性。
func (s *ProxyService) TestProxy(cfg ProxyConfig) ProxyTestResult {
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return ProxyTestResult{Success: false, Message: "端口号必须在 1 ~ 65535 之间"}
	}
	if cfg.Host == "" {
		cfg.Host = "127.0.0.1"
	}

	start := time.Now()
	target := "en.wikipedia.org:443"
	if strings.ToLower(cfg.Type) == "socks5" {
		proxyAddr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
		dialer, err := proxy.SOCKS5("tcp", proxyAddr, nil, proxy.Direct)
		if err != nil {
			return ProxyTestResult{Success: false, Message: fmt.Sprintf("SOCKS5 拨号器错误: %v", err)}
		}
		conn, err := dialer.Dial("tcp", target)
		if err != nil {
			return ProxyTestResult{Success: false, Message: fmt.Sprintf("无法通过 SOCKS5 连接目标: %v", err)}
		}
		_ = conn.Close()
	} else {
		// HTTP 代理 CONNECT 测试
		proxyAddr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
		conn, err := net.DialTimeout("tcp", proxyAddr, 6*time.Second)
		if err != nil {
			return ProxyTestResult{Success: false, Message: fmt.Sprintf("无法连接代理端口 %s: %v", proxyAddr, err)}
		}
		defer conn.Close()

		req := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
		_ = conn.SetDeadline(time.Now().Add(6 * time.Second))
		if _, err := conn.Write([]byte(req)); err != nil {
			return ProxyTestResult{Success: false, Message: fmt.Sprintf("发送 CONNECT 失败: %v", err)}
		}

		br := bufio.NewReader(conn)
		resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
		if err != nil {
			return ProxyTestResult{Success: false, Message: fmt.Sprintf("读取代理响应失败: %v", err)}
		}
		_ = resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return ProxyTestResult{Success: false, Message: fmt.Sprintf("代理返回错误状态码: %s", resp.Status)}
		}
	}

	latency := time.Since(start).Milliseconds()
	return ProxyTestResult{
		Success:   true,
		LatencyMs: latency,
		Message:   fmt.Sprintf("代理连通正常（延迟: %dms）", latency),
	}
}
