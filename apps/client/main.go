package main

import (
	"embed"
	"log"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Wails uses Go's `embed` package to embed the frontend build output into the binary.
// 前端构建产物（frontend/dist）会被打进二进制，由 Wails 的资源服务器提供。
//
//go:embed all:frontend/dist
var assets embed.FS

func init() {
	// 注册强类型事件：前端可通过生成的事件常量监听书库变化。
	application.RegisterEvent[LibraryChangedEvent]("library:changed")
}

func main() {
	library := NewLibraryService()
	appService := NewAppService()

	app := application.New(application.Options{
		Name:        "HPFReader",
		Description: "HPF-Reader 桌面客户端（Wails v3 + Vue 3 + foliate-js）",
		Services: []application.Service{
			application.NewService(appService),
			application.NewService(library),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	// 服务在 application.New 之后才拿得到 app 句柄（用于发事件）。
	library.attach(app)
	appService.attach(app)

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "HPF Reader",
		Width:  1280,
		Height: 800,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(20, 22, 26),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// dataDir 返回客户端本地数据目录（用于书库文件与元数据）。
// 目前是一个最小实现：桌面端放在用户配置目录下；后续会按平台调整（移动端用应用私有目录）。
func dataDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := base + string(os.PathSeparator) + "HPFReader"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}
