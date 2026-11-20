//go:build windows

package main

import (
	"net"
	"strconv"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// readWindowsSystemProxy 从 Windows 注册表中读取当前用户的 Internet Settings 代理设置。
func readWindowsSystemProxy() (ProxyConfig, bool) {
	cfg := ProxyConfig{
		Enabled: false,
		Type:    "http",
		Host:    "127.0.0.1",
		Port:    7890,
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return cfg, false
	}
	defer k.Close()

	enabled, _, _ := k.GetIntegerValue("ProxyEnable")
	proxyServer, _, err := k.GetStringValue("ProxyServer")
	if err != nil || strings.TrimSpace(proxyServer) == "" {
		return cfg, false
	}

	proxyServer = strings.TrimSpace(proxyServer)
	// proxyServer 格式可能是 "127.0.0.1:7898" 或 "http=127.0.0.1:7898;https=127.0.0.1:7898" 或 "socks=127.0.0.1:1080"
	target := proxyServer
	proxyType := "http"
	if strings.Contains(target, ";") {
		parts := strings.Split(target, ";")
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if strings.HasPrefix(part, "https=") {
				target = strings.TrimPrefix(part, "https=")
				proxyType = "http"
				break
			} else if strings.HasPrefix(part, "http=") {
				target = strings.TrimPrefix(part, "http=")
				proxyType = "http"
				break
			} else if strings.HasPrefix(part, "socks=") {
				target = strings.TrimPrefix(part, "socks=")
				proxyType = "socks5"
				break
			}
		}
	} else {
		if strings.HasPrefix(target, "socks=") {
			target = strings.TrimPrefix(target, "socks=")
			proxyType = "socks5"
		} else {
			target = strings.TrimPrefix(target, "http=")
			target = strings.TrimPrefix(target, "https=")
		}
	}

	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		return cfg, false
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		return cfg, false
	}

	cfg.Host = host
	cfg.Port = port
	cfg.Type = proxyType
	cfg.Enabled = (enabled == 1)
	return cfg, true
}
