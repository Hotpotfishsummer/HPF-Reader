package main

import (
	"os/exec"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// AppVersion 是客户端版本号（后续由构建注入）。
const AppVersion = "0.1.0"

// AppService 暴露与阅读业务无关的进程级信息。
// 业务代码不允许直接 import bindings，只能通过前端 platform 抽象层访问本服务。
type AppService struct {
	app *application.App
}

func NewAppService() *AppService { return &AppService{} }

// attach 在 application.New 之后调用，保存 app 句柄（当前仅用于未来的事件发送）。
// 刻意不导出：不导出就不会出现在 Wails 生成的 bindings 里。
func (s *AppService) attach(app *application.App) { s.app = app }

// Platform 返回宿主平台标识：windows / darwin / linux / android / ios。
func (s *AppService) Platform() string { return runtime.GOOS }

// Version 返回客户端版本号。
func (s *AppService) Version() string { return AppVersion }

// DataDir 返回客户端本地数据目录的绝对路径。
func (s *AppService) DataDir() (string, error) { return dataDir() }

// OpenDataDir 在系统文件管理器中打开数据目录。
func (s *AppService) OpenDataDir() error {
	dir, err := dataDir()
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer", dir).Start()
	case "darwin":
		return exec.Command("open", dir).Start()
	case "linux":
		return exec.Command("xdg-open", dir).Start()
	default:
		return nil
	}
}
