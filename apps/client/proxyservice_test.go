package main

import (
	"os"
	"testing"
)

func TestProxyServiceConfig(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "proxy-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	s := &ProxyService{
		dir: tempDir,
		config: ProxyConfig{
			Enabled: false,
			Type:    "http",
			Host:    "127.0.0.1",
			Port:    7890,
		},
	}

	cfg := s.GetConfig()
	if cfg.Port != 7890 || cfg.Enabled {
		t.Fatalf("unexpected default config: %+v", cfg)
	}

	newCfg := ProxyConfig{
		Enabled: true,
		Type:    "socks5",
		Host:    "127.0.0.1",
		Port:    1080,
	}

	if err := s.SaveConfig(newCfg); err != nil {
		t.Fatalf("failed to save config: %v", err)
	}

	// 验证保存到了文件
	s2 := &ProxyService{dir: tempDir}
	if err := s2.load(); err != nil {
		t.Fatalf("failed to reload config: %v", err)
	}
	loaded := s2.GetConfig()
	if !loaded.Enabled || loaded.Type != "socks5" || loaded.Port != 1080 {
		t.Fatalf("loaded config mismatch: %+v", loaded)
	}

	// 验证环境变量被正确设置
	if os.Getenv("ALL_PROXY") != "socks5://127.0.0.1:1080" {
		t.Fatalf("ALL_PROXY env var expected socks5://127.0.0.1:1080, got %s", os.Getenv("ALL_PROXY"))
	}

	// 禁用代理并验证环境变量清理
	disableCfg := ProxyConfig{Enabled: false, Type: "http", Host: "127.0.0.1", Port: 7890}
	if err := s.SaveConfig(disableCfg); err != nil {
		t.Fatalf("failed to disable config: %v", err)
	}
	if os.Getenv("ALL_PROXY") != "" {
		t.Fatalf("ALL_PROXY expected empty, got %s", os.Getenv("ALL_PROXY"))
	}
}

func TestProxyServiceValidation(t *testing.T) {
	s := &ProxyService{}
	invalidCfg := ProxyConfig{
		Port: 70000,
	}
	if err := s.SaveConfig(invalidCfg); err == nil {
		t.Fatalf("expected error for invalid port > 65535")
	}

	res := s.TestProxy(invalidCfg)
	if res.Success {
		t.Fatalf("expected failure for invalid port")
	}
}
