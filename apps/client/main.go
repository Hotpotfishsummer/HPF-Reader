package main

import (
	"bytes"
	"embed"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Wails uses Go's `embed` package to embed the frontend build output into the binary.
// 前端构建产物（frontend/dist）会被打进二进制，由 Wails 的资源服务器提供。
//
//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var appIcon []byte

func init() {
	// 注册强类型事件：前端可通过生成的事件常量监听书库变化。
	application.RegisterEvent[LibraryChangedEvent]("library:changed")
}

func main() {
	library := NewLibraryService()
	appService := NewAppService()
	proxyService := NewProxyService()
	browserService := NewBrowserService()
	downloadService := NewDownloadService(library)

	// 本机 API 中继：渲染层的 API 请求走这里出网，TLS 由 Go 严格校验。
	// 起不来就降级为"前端直连"（见 desktop.ts），此时 API 的证书校验只剩 Chromium，
	// 因此下面也不再给 Chromium 加任何忽略证书的参数。
	apiRelay := NewAPIRelay()
	if err := apiRelay.Start(); err != nil {
		log.Printf("[api-relay] 启动失败，前端将直连 API（证书校验退化）: %v", err)
	} else {
		defer func() { _ = apiRelay.Close() }()
	}
	apiRelayService := NewAPIRelayService(apiRelay)

	app := application.New(application.Options{
		Name:        "HPFReader",
		Description: "HPF-Reader 桌面客户端（Wails v3 + Vue 3 + foliate-js）",
		Icon:        appIcon,
		Services: []application.Service{
			application.NewService(appService),
			application.NewService(library),
			application.NewService(proxyService),
			application.NewService(browserService),
			application.NewService(downloadService),
			application.NewService(apiRelayService),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Windows: application.WindowsOptions{
			AdditionalBrowserArgs: windowsBrowserArgs(proxyService.LocalPort(), proxyService.mitm),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	// 服务在 application.New 之后才拿得到 app 句柄（用于发事件）。
	library.attach(app)
	appService.attach(app)
	proxyService.attach(app)
	browserService.attach(app)
	downloadService.attach(app)

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "HPF Reader",
		Width:     1280,
		Height:    800,
		Frameless: runtime.GOOS != "darwin",
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

// windowsBrowserArgs 构造 WebView2 的 Chromium 参数。
//
// 证书相关的取舍（安全关键，改动前请读完）：
//   - 曾用 `--ignore-certificate-errors`：它让 WebView2 的**所有** HTTPS 都不校验证书，
//     渲染层 fetch 的 API 请求因此可被链路中间人（含用户自配的远程代理节点）窃取
//     Bearer / refresh token。现已移除。
//   - 现在 API 流量根本不经过 Chromium 的 TLS：渲染层把请求发给本机 Go 中继
//     （apirelay.go，127.0.0.1 明文 HTTP），由 Go 用系统根证书严格校验后出网。
//     所以"忽略证书"对 API 已经完全失效。
//   - 内置书源浏览器（z-lib / annas-archive 等）仍需要 MITM：那部分靠本进程生成的
//     本地 CA 签发的叶子证书。这里只把这**一张 CA 公钥**的 SPKI 哈希加进白名单
//     （`--ignore-certificate-errors-spki-list`），其它任何证书仍按标准校验。
//   - CA 不可用（mitm 为 nil / SPKI 计算失败）时**不加**任何忽略证书的参数：
//     宁可不忽略证书，也不要退回全局忽略。
//   - `--disable-web-security` 保留（内置浏览器依赖它做跨域 iframe/脚本注入）。
//     它只影响 Chromium 渲染层的同源策略，不改变证书校验，也不影响已改走 Go 中继的
//     API 流量；但它仍是残留风险，见本次安全报告。
func windowsBrowserArgs(proxyPort int, mitm *mitmManager) []string {
	// 诊断开关：WebView2 的 controller 创建失败时，无法从进程外区分是哪条参数导致的。
	// 设置 HPF_BROWSER_ARGS_MODE=none 可完全不注入参数，用于确认"是不是参数的锅"。
	// 生产环境不要设置这个变量（等于关掉内置浏览器的代理与证书豁免）。
	if strings.EqualFold(strings.TrimSpace(os.Getenv("HPF_BROWSER_ARGS_MODE")), "none") {
		log.Printf("[browser-args] HPF_BROWSER_ARGS_MODE=none：跳过全部浏览器参数（仅诊断用）")
		return nil
	}
	args := []string{
		fmt.Sprintf("--proxy-server=http=127.0.0.1:%d;https=127.0.0.1:%d", proxyPort, proxyPort),
		"--proxy-bypass-list=localhost;127.0.0.1;*.localhost",
		"--disable-web-security",
	}
	// 诊断开关（仅本机、仅显式设置环境变量时生效）：HPF_DEBUG_CDP=<端口>。
	// 本应用没有日志文件，线上排障（例如「同步一直失败」）时，只有在真实运行的
	// WebView2 里抓 Network/Console 才能看到「请求到底发出去没有、服务器回了什么」。
	// 端口只绑 127.0.0.1；生产环境不要设置这个变量。
	if port := debugCDPPort(); port != "" {
		args = append(args, "--remote-debugging-port="+port)
		log.Printf("[browser-args] HPF_DEBUG_CDP=%s：已打开本机 DevTools 调试端口（仅诊断用）", port)
	}
	if pin := mitm.SPKIPin(); pin != "" {
		args = append(args, "--ignore-certificate-errors-spki-list="+pin)
	} else {
		log.Printf("[browser-args] MITM CA 不可用：不注入证书豁免参数（fail closed）")
	}
	// 参数内容会进 WebView2 的 additionalBrowserArguments，出问题时这是唯一能对账的证据。
	log.Printf("[browser-args] proxyPort=%d spki=%t args=%q", proxyPort, mitm.SPKIPin() != "", args)
	return args
}

// debugCDPPort 读取 HPF_DEBUG_CDP（1..65535 的十进制端口）。未设置或非法时返回空串。
//
// 只接受端口号而不是完整参数：这样环境变量无法注入任意 Chromium 开关
// （例如重新打开 --ignore-certificate-errors 或 --user-data-dir）。
func debugCDPPort() string {
	raw := strings.TrimSpace(os.Getenv("HPF_DEBUG_CDP"))
	if raw == "" {
		return ""
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		log.Printf("[browser-args] HPF_DEBUG_CDP=%q 非法，已忽略（需要 1-65535 的端口号）", raw)
		return ""
	}
	return strconv.Itoa(port)
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
