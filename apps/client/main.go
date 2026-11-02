package main

import (
	"bytes"
	"embed"
	"errors"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"

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

// androidPrivateDir 在 Android 上推导应用私有目录，**不硬编码包名**。
//
// 推导顺序（全部来自运行时环境，换包名后自动跟随）：
//  1. $HOME：部分运行时/容器会设置；Android 应用进程通常没有。
//  2. $TMPDIR：Android 系统会设为 /data/user/0/<pkg>/cache，
//     取父目录即 /data/user/0/<pkg>，再拼 files —— 与 Context.getFilesDir() 等价。
//
// 第二个参数 ok=false 表示"当前不是 Android"或"拿不到可靠来源"，
// 由调用方回落到 os.UserConfigDir() 或返回明确错误。
func androidPrivateDir() (string, bool) {
	if runtime.GOOS != "android" {
		return "", false
	}
	// 1. $HOME / $XDG_CONFIG_HOME：部分运行时（终端模拟器、容器）会设置；
	//    Android 普通应用进程不会。
	if home := os.Getenv("HOME"); home != "" {
		if st, err := os.Stat(home); err == nil && st.IsDir() {
			return filepath.Join(home, "HPFReader"), true
		}
	}

	// 2. $TMPDIR：Android 系统会设为 <pkg root>/cache，父目录即 <pkg root>，
	//    再拼 files —— 与 Context.getFilesDir() 等价。
	if tmp := os.Getenv("TMPDIR"); tmp != "" {
		root := filepath.Dir(filepath.Clean(tmp))
		if st, err := os.Stat(root); err == nil && st.IsDir() {
			return filepath.Join(root, "files", "HPFReader"), true
		}
	}

	// 3. /proc/self/cmdline：Android 上 zygote fork 出的应用进程，
	//    argv[0] 就是**本应用的包名**（实测 com.wails.app）。
	//    这是"运行时推导"而非硬编码：换包名后自动跟随。
	//    拼出来的路径仍需 os.Stat 验证可写，失败就当拿不到。
	if pkg := androidPackageName(); pkg != "" {
		dir := filepath.Join("/data/user/0", pkg, "files", "HPFReader")
		if err := os.MkdirAll(dir, 0o755); err == nil {
			return dir, true
		}
		// 多用户/老版本 Android 可能落在 /data/data 下。
		dir = filepath.Join("/data/data", pkg, "files", "HPFReader")
		if err := os.MkdirAll(dir, 0o755); err == nil {
			return dir, true
		}
	}

	return "", false
}

// androidPackageName 从 /proc/self/cmdline 读当前应用包名。
// Android 应用进程的 argv[0] 是包名，这是运行时事实，不是配置。
func androidPackageName() string {
	b, err := os.ReadFile("/proc/self/cmdline")
	if err != nil || len(b) == 0 {
		return ""
	}
	// cmdline 以 NUL 分隔，取第一段。
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	name := strings.TrimSpace(string(b))
	// 包名只允许 [A-Za-z0-9_.]；过滤掉明显的异常值（如空串或含 / 的路径）。
	if name == "" || strings.ContainsAny(name, "/\\ \t\n") {
		return ""
	}
	return name
}

// dataDir 返回客户端本地数据目录（用于书库文件与元数据）。
//
// 桌面端走 os.UserConfigDir()；Android 上这个调用会直接失败
// （logcat 实证：neither $XDG_CONFIG_HOME nor $HOME are defined），
// 因为 Android 应用进程既不设 $HOME 也不设 $XDG_CONFIG_HOME。
//
// Android 分支刻意**不硬编码** "com.wails.app" 之类的包名：
//   - 换包名后硬编码路径会静默失效（写到一个不属于自己的目录，或被 SELinux 拒绝）；
//   - 而且 /data/data/<pkg> 是另一个进程的私有目录，应用自己也不该按字符串去拼。
//
// 正确来源是运行时环境：
//   - TMPDIR（Android 上由系统设为 /data/user/0/<pkg>/cache）→ 取父目录得到 files 的同级根；
//   - 优先用 HOME（部分容器/终端模拟器会设）；其次由 TMPDIR 推导 <root>/files。
//
// 若两者都拿不到，返回**明确错误**而不是猜一个路径——宁可让上层看到
// "进度存不下来"，也不要写到一个会在换包名后静默失效的地方。
func dataDir() (string, error) {
	if dir, ok := androidPrivateDir(); ok {
		return dir, nil
	}

	base, err := os.UserConfigDir()
	if err != nil {
		if runtime.GOOS == "android" {
			// Android 上没有任何可用的配置目录来源：明确报错，而不是猜一个
			// 换包名后会静默失效的路径（见 androidPrivateDir 注释）。
			return "", errors.New("android: 无法推导应用私有目录（$HOME 与 $TMPDIR 都不可用）: " + err.Error())
		}
		return "", err
	}
	dir := filepath.Join(base, "HPFReader")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}
