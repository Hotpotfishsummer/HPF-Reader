package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	reCSPFrameAncestors = regexp.MustCompile(`(?i)frame-ancestors\s+[^;]+;?`)
	reSameSite          = regexp.MustCompile(`(?i);\s*SameSite=[^;]+`)
)

type mitmManager struct {
	caCert    *x509.Certificate
	caKey     *ecdsa.PrivateKey
	caDer     []byte
	certCache sync.Map // host string -> *tls.Certificate

	// caSPKIPin 是 CA 公钥的 SPKI SHA-256（标准 base64），用于 Chromium 的
	// `--ignore-certificate-errors-spki-list`：只忽略**这一张**本地 CA，
	// 而不是像 `--ignore-certificate-errors` 那样全局关掉证书校验。
	caSPKIPin string
}

func newMitmManager() (*mitmManager, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("failed to generate CA private key: %w", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("failed to generate CA serial: %w", err)
	}

	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"HPF Reader Internal Proxy"},
			CommonName:   "HPF Reader Root CA",
		},
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}

	der, err := x509.CreateCertificate(rand.Reader, template, template, &priv.PublicKey, priv)
	if err != nil {
		return nil, fmt.Errorf("failed to create CA certificate: %w", err)
	}

	pin, err := spkiPinFor(&priv.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("failed to compute CA SPKI pin: %w", err)
	}

	return &mitmManager{
		caCert:    template,
		caKey:     priv,
		caDer:     der,
		caSPKIPin: pin,
	}, nil
}

// SPKIPin 返回本 CA 的 SPKI SHA-256（标准 base64，Chromium 参数要求的格式）。
// 空串表示不可用 —— 调用方此时**不应该**给 Chromium 加任何忽略证书的参数。
func (m *mitmManager) SPKIPin() string {
	if m == nil {
		return ""
	}
	return m.caSPKIPin
}

// spkiPinFor 计算公钥的 SubjectPublicKeyInfo SHA-256 并做标准 base64 编码。
//
// Chromium 的 --ignore-certificate-errors-spki-list 期望的就是这个值：
// 只让**指定公钥**签发的证书免于校验，其它证书仍严格校验。
func spkiPinFor(pub any) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(der)
	return base64.StdEncoding.EncodeToString(sum[:]), nil
}

func (m *mitmManager) getCert(host string) (*tls.Certificate, error) {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if val, ok := m.certCache.Load(host); ok {
		return val.(*tls.Certificate), nil
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}

	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName: host,
		},
		NotBefore:   time.Now().Add(-24 * time.Hour),
		NotAfter:    time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	if ip := net.ParseIP(host); ip != nil {
		template.IPAddresses = []net.IP{ip}
	} else {
		template.DNSNames = []string{host}
	}

	der, err := x509.CreateCertificate(rand.Reader, template, m.caCert, &priv.PublicKey, m.caKey)
	if err != nil {
		return nil, err
	}

	tlsCert := &tls.Certificate{
		Certificate: [][]byte{der, m.caDer},
		PrivateKey:  priv,
	}
	m.certCache.Store(host, tlsCert)
	return tlsCert, nil
}

func shouldInterceptHost(host string) bool {
	h := strings.ToLower(host)
	if strings.HasPrefix(h, "127.") || strings.HasPrefix(h, "localhost") || strings.HasPrefix(h, "::1") {
		return false
	}
	return strings.Contains(h, "annas-archive") ||
		strings.Contains(h, "singlelogin") ||
		strings.Contains(h, "z-library") ||
		strings.Contains(h, "z-lib") ||
		strings.Contains(h, "zlibrary") ||
		strings.Contains(h, "wikipedia.org") ||
		strings.Contains(h, "wikimedia.org") ||
		strings.Contains(h, "1lib") ||
		strings.Contains(h, "b-ok") ||
		strings.Contains(h, "bookfi")
}

func stripFrameAncestors(csp string) string {
	cleaned := reCSPFrameAncestors.ReplaceAllString(csp, "")
	return strings.TrimSpace(cleaned)
}

func adaptCookieForIframe(cookie string) string {
	cleaned := reSameSite.ReplaceAllString(cookie, "")
	if !strings.Contains(strings.ToLower(cleaned), "secure") {
		cleaned += "; Secure"
	}
	return cleaned + "; SameSite=None; Partitioned"
}

const cookieShimScript = `<script>
(function(){
  try {
    // 覆盖 window.stop 防止任何防嵌套脚本中途杀死页面解析与渲染
    window.stop = function() {};
  } catch(e){}

  try {
    var d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
            Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
    if (d && d.set) {
      var origSet = d.set;
      Object.defineProperty(Document.prototype, 'cookie', {
        set: function(v) {
          if (typeof v === 'string') {
            if (!v.toLowerCase().includes('samesite=')) {
              v += '; SameSite=None; Secure; Partitioned';
            } else {
              v = v.replace(/;\s*samesite=[^;]+/i, '; SameSite=None; Partitioned');
            }
            if (!v.toLowerCase().includes('secure')) {
              v += '; Secure';
            }
          }
          return origSet.call(this, v);
        },
        get: function() { return d.get ? d.get.call(this) : ''; }
      });
    }
  } catch(e){}

  try {
    Object.defineProperty(window, 'top', { get: function() { return window.self; }, configurable: true });
    Object.defineProperty(window, 'parent', { get: function() { return window.self; }, configurable: true });
  } catch(e){}
})();
</script>`

func transformHTMLBody(resp *http.Response, host string) *http.Response {
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if !strings.Contains(contentType, "text/html") {
		return resp
	}

	contentEncoding := strings.ToLower(resp.Header.Get("Content-Encoding"))
	var reader io.Reader = resp.Body
	if strings.Contains(contentEncoding, "gzip") {
		gr, err := gzip.NewReader(resp.Body)
		if err == nil {
			reader = gr
			defer gr.Close()
		}
	} else if strings.Contains(contentEncoding, "deflate") {
		zr, err := zlib.NewReader(resp.Body)
		if err == nil {
			reader = zr
			defer zr.Close()
		}
	}

	bodyBytes, err := io.ReadAll(reader)
	_ = resp.Body.Close()
	if err != nil {
		resp.Body = io.NopCloser(bytes.NewReader(nil))
		return resp
	}

	// 移除可能存在的 Content-Encoding / Transfer-Encoding 标头，由本地以明文精确长度交付
	resp.Header.Del("Content-Encoding")
	resp.Header.Del("Transfer-Encoding")

	bodyStr := string(bodyBytes)

	// 1. 对于 singlelogin.rs，直接将 cookie 检验逻辑 if(!cE2()){ 规避为 if(false){
	if strings.Contains(strings.ToLower(host), "singlelogin") {
		bodyStr = strings.Replace(bodyStr, "if(!cE2()){", "if(false){", 1)
		bodyStr = strings.Replace(bodyStr, "if (!cE2()) {", "if (false) {", 1)
	}

	// 2. 彻底中和 Z-Library 及常见 framebuster 脚本（window != top ? window.stop() : null）
	bodyStr = strings.ReplaceAll(bodyStr, "window != top ? window.stop() : null;", "/* unblocked */ null;")
	bodyStr = strings.ReplaceAll(bodyStr, "window != top ? window.stop() : null", "/* unblocked */ null")
	bodyStr = strings.ReplaceAll(bodyStr, "window!=top?window.stop():null;", "/* unblocked */ null;")
	bodyStr = strings.ReplaceAll(bodyStr, "window!=top?window.stop():null", "/* unblocked */ null")
	bodyStr = strings.ReplaceAll(bodyStr, "window.stop()", "/* stop ignored */ void(0)")

	// 3. 注入 Cookie 垫片与 window.stop 防御垫片
	if idx := strings.Index(strings.ToLower(bodyStr), "<head>"); idx != -1 {
		bodyStr = bodyStr[:idx+6] + cookieShimScript + bodyStr[idx+6:]
	} else if idx := strings.Index(strings.ToLower(bodyStr), "<html"); idx != -1 {
		if closeIdx := strings.Index(bodyStr[idx:], ">"); closeIdx != -1 {
			insertAt := idx + closeIdx + 1
			bodyStr = bodyStr[:insertAt] + "<head>" + cookieShimScript + "</head>" + bodyStr[insertAt:]
		}
	}

	newBytes := []byte(bodyStr)
	resp.Body = io.NopCloser(bytes.NewReader(newBytes))
	resp.ContentLength = int64(len(newBytes))
	resp.Header.Set("Content-Length", strconv.Itoa(len(newBytes)))
	return resp
}

func (m *mitmManager) handleInterceptConnect(clientConn net.Conn, targetConn net.Conn, targetHost string) {
	defer clientConn.Close()
	defer targetConn.Close()

	hostWithoutPort := targetHost
	if h, _, err := net.SplitHostPort(targetHost); err == nil {
		hostWithoutPort = h
	}

	tlsCert, err := m.getCert(targetHost)
	if err != nil {
		return
	}

	clientTLS := tls.Server(clientConn, &tls.Config{
		Certificates: []tls.Certificate{*tlsCert},
		NextProtos:   []string{"http/1.1"},
	})
	if err := clientTLS.Handshake(); err != nil {
		return
	}
	defer clientTLS.Close()

	targetTLS := tls.Client(targetConn, &tls.Config{
		ServerName: hostWithoutPort,
		NextProtos: []string{"http/1.1"},
	})
	if err := targetTLS.Handshake(); err != nil {
		return
	}
	defer targetTLS.Close()

	clientReader := bufio.NewReader(clientTLS)
	targetReader := bufio.NewReader(targetTLS)

	for {
		req, err := http.ReadRequest(clientReader)
		if err != nil {
			break
		}

		req.URL.Scheme = "https"
		req.URL.Host = targetHost

		// 移除 Accept-Encoding，确保能够针对 HTML 进行反反爬/cookie/framebuster 脚本替换
		if shouldInterceptHost(targetHost) {
			req.Header.Del("Accept-Encoding")
		}

		if err := req.Write(targetTLS); err != nil {
			break
		}

		resp, err := http.ReadResponse(targetReader, req)
		if err != nil {
			break
		}

		// 1. 移除 X-Frame-Options 允许在内置应用 iframe 中加载
		resp.Header.Del("X-Frame-Options")

		// 2. 移除 CSP 中阻止 iframe 的 frame-ancestors 指令
		if csp := resp.Header.Get("Content-Security-Policy"); csp != "" {
			cleaned := stripFrameAncestors(csp)
			if cleaned != "" {
				resp.Header.Set("Content-Security-Policy", cleaned)
			} else {
				resp.Header.Del("Content-Security-Policy")
			}
		}

		// 3. 增强 Set-Cookie 跨站 iframe 支持
		cookies := resp.Header.Values("Set-Cookie")
		if len(cookies) > 0 {
			resp.Header.Del("Set-Cookie")
			for _, c := range cookies {
				resp.Header.Add("Set-Cookie", adaptCookieForIframe(c))
			}
		}

		// 4. HTML 页面注入兼容脚本与规避单点登录检查
		resp = transformHTMLBody(resp, targetHost)

		if err := resp.Write(clientTLS); err != nil {
			_ = resp.Body.Close()
			break
		}
		_ = resp.Body.Close()
	}
}
