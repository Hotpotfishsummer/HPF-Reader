package main

import (
	"errors"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// BrowserService 负责在应用内管理内置浏览器会话与导航，不在外部弹窗。
type BrowserService struct {
	app *application.App
}

// NewBrowserService 创建内置浏览器服务实例。
func NewBrowserService() *BrowserService {
	return &BrowserService{}
}

func (s *BrowserService) attach(app *application.App) {
	s.app = app
}

// OpenURL 触发应用内浏览器导航（不再弹出新操作系统窗口）。
func (s *BrowserService) OpenURL(rawURL string) error {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return errors.New("URL 不能为空")
	}
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		rawURL = "https://" + rawURL
	}

	if s.app != nil {
		s.app.Event.Emit("browser:navigate", rawURL)
	}
	return nil
}

// Close 触发关闭应用内浏览器。
func (s *BrowserService) Close() error {
	if s.app != nil {
		s.app.Event.Emit("browser:close", nil)
	}
	return nil
}
