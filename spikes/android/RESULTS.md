# Android 可用性验证结果（task-11）

> 结论一句话：**APK 能构建、能装、能启动、能读书**——但**只在 WebView ≥ 120 上成立**。
> 本机实测两个系统镜像：**WebView 124 全绿**；**WebView 91 上真书读不了**（病因是 CSS 现代特性，不是 JS builtin）。

所有原始输出都在 `spikes/android/evidence/`（62 个文件，约 74 MB）。本文只引用文件名，不美化、不改写。

## 0. 验收环境

| 项 | 值 |
|---|---|
| 主机 | Windows，Android SDK `%LOCALAPPDATA%\Android\Sdk` |
| 模拟器 | Android emulator **36.4.9.0**（build 14788078） |
| Go | go1.26.0 windows/amd64（`GOTOOLCHAIN=auto`） |
| JDK | Microsoft jdk-21.0.4.7-hotspot |
| NDK | 29.0.14206865 |
| Gradle | 9.2.1（wrapper，镜像下载，见 §2.2） |
| Wails | v3.1.0（移动端官方标注 **experimental**） |
| AVD-A | `Pixel_6`，`android-31`，Android 12，**WebView 91.0.4472.114**，x86_64，1080×2400@420dpi |
| AVD-B | `hpf-api35`，`android-35`，Android 15，**WebView 124.0.6367.219**，x86_64，1080×2400@420dpi |

> AVD-B 是我为了做「新老 WebView 对比」**新建**的（本机原本只装了 android-29/31，WebView 都是 ≈91，没有 ≥117 的可直接验）。
> 创建命令见 §2.3。

## 1. 交付物

| 文件 | 大小 | sha256 |
|---|---|---|
| `apps/client/bin/hpfreader-android-debug.apk` | 22,544,722 B | `490D0353BBD2C3D984F2A13286089197FDC8B41B70D3A04D995FBB5ACC0B40A8` |

这是**纯净包**：内置示例书是原始的 `dist/sample/sample.epub`（5,509 B，sha256 `6E330BC99C5F1320C6F70C26DE18C5E2FC6370A2534FFF3B77E874B3179FF3AC`）。
真书验收用的是单独构建的包（见 §4），**不进 bin/**，避免把测试书当交付物。

## 2. 复现步骤（含三个本机特有的坑）

### 2.1 构建链（Windows 上没有 `task`，必须手动串）

```powershell
$env:PATH = 'C:\Users\<user>\go-portable\go\bin;C:\Users\<user>\go\bin;' + $env:PATH
$env:GOTOOLCHAIN='auto'; $env:PACKAGE_MANAGER='pnpm'
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"; $env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:ANDROID_NDK_HOME="$env:ANDROID_HOME\ndk\29.0.14206865"
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.4.7-hotspot'

# 1) 生成 bindings（必须先于前端构建，否则 vue-tsc 报 TS7016/TS2307）
cd apps/client
wails3 generate bindings -ts -i -f '-tags android' -clean=true

# 2) 前端构建
cd frontend && corepack pnpm run build && cd ..

# 3) 生成 overlay（把 main_android.gen.go 注入包）
wails3 android overlay:gen -out build/android/overlay.json -config build/config.yml

# 4) 编译 Go 共享库（c-shared）
$env:CC="$env:ANDROID_NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin\x86_64-linux-android21-clang.cmd"
$env:CXX="$env:ANDROID_NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin\x86_64-linux-android21-clang++.cmd"
$env:CGO_ENABLED=1; $env:GOOS='android'; $env:GOARCH='amd64'; $env:CGO_CFLAGS='-Wno-error'
go build -buildmode=c-shared -overlay build/android/overlay.json -tags 'android,debug' `
  -buildvcs=false -gcflags=all='-l' -o build/android/app/src/main/jniLibs/x86_64/libwails.so

# 5) 打包 APK
cd build/android && .\gradlew.bat assembleDebug
```

原始输出：`bindings-and-frontend-verify.log`、`gradle-assembleDebug.log`、`rebuild-with-polyfills.log`。
关键行：`Processed: 250 Packages, 2 Services, 11 Methods, 0 Enums, 2 Models, 1 Event`；`BUILD SUCCESSFUL`；`35 actionable tasks`。

### 2.2 坑①：Gradle 官方源被墙 —— 镜像下载 + **官方 sha256 校验**

`gradlew.bat` 首次运行要下 135 MB 的 `gradle-9.2.1-bin.zip`：

```
Downloading https://services.gradle.org/distributions/gradle-9.2.1-bin.zip
java.io.IOException: Downloading ... failed: timeout (10000ms)
java.net.SocketTimeoutException: Read timed out
```

实测官方源：`curl -sL --max-time 12` → `http=307 size=0 speed=192`（12 秒 0 字节，**基本不可达**）。
改用腾讯云镜像：`http=200 size=135535598 speed=7059233`（≈7 MB/s）。

**安全做法**：不信任镜像的内容，只信官方公布的校验和。
- 官方 `.sha256`：`72f44c9f8ebcb1af43838f45ee5c4aa9c5444898b3468ab3f4af7b6076c5bc3f`
- 镜像 zip 用 `Get-FileHash` 校验，**一致**；解到 `~/.gradle/wrapper/dists/gradle-9.2.1-bin/<hash>/` 并建 `.ok`。
- 已把 `distributionSha256Sum=72f44c9f...` **写进** `gradle-wrapper.properties`，以后自动校验。

### 2.3 坑②：wrapper `networkTimeout=10000` 对 135 MB 包必挂

```properties
# 改前
networkTimeout=10000
# 改后
networkTimeout=120000
```

### 2.4 坑③：模拟器**必须 `-no-window`**，否则 QEMU 线程挂起后 exit 1

带窗口启动（`-gpu swiftshader_indirect`）的原始输出：

```
Critical: Failed to load opengl32sw (找不到指定的模块。)
Warning: Software OpenGL failed. Falling back to system OpenGL.
WARNING | Please update the emulator to one that supports the feature(s): Vulkan
ERROR | detected a hanging thread 'QEMU2 main loop'. No response for 18302 ms
ERROR | detected a hanging thread 'QEMU2 CPU0/1/2/3 thread'. No response for 15001 ms
[exit code: 1]
```

`lib64\opengl32sw.dll` 在本机 SDK 里确实缺失。**加 `-no-window` 后完全正常**：

```powershell
emulator.exe -avd Pixel_6 -no-window -no-snapshot-load -gpu swiftshader_indirect -no-boot-anim
```

→ `sys.boot_completed=1`、`ro.build.version.sdk=31`、`wm size = 1080x2400`。启动日志：`emulator-boot-headless.log`。

### 2.5 坑④（新发现，已修）：Android 上 `os.UserConfigDir()` 直接报错

见 §5。

## 3. ★ 核心结论：WebView 白屏风险 —— **未复现**，但发现了更严重的两个问题

**明确回答 task-11 的问题：WebView 白屏风险没有复现。**

两个镜像上都拿到了完整 DOM，不是白屏：

```json
// AVD-A / WebView 91 / 书库首页
{"href":"https://wails.localhost/#/","title":"HPF Reader","readyState":"complete",
 "bodyTextLen":71,"hasWailsBridge":true,
 "bodyTextHead":"HPF Reader\n书库设置\n我的书库\n导入书籍\n\n书库还是空的\n\n导入一本 EPUB 就能开始阅读。也可以先打开内置示例书。\n\n打开示例书"}
```

`hasWailsBridge=true`、`faviconUrl=https://wails.localhost/wails.png`（证明资源桥在正常工作）、
`logcat` 里 `WailsPathHandler: Serving assets/... with type application/javascript` 逐条命中。

**但是**，复现出了两个**比白屏更隐蔽**的阻塞问题，二者都必须记录：

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| A | ES2024 builtin 缺失（`Object.groupBy` 等） | 任何书都打不开 | **已修复**（前端 polyfill） |
| B | CSS 现代特性缺失（`@layer` / `@container`） | 真书读不了（样式表整份失效） | **未解决** |

> A 和 B 是**两件独立的事**，不能合并成一句「Android 已经好了」。
> 修复 A 之后示例书可读，但 B 仍然让真书失败——这个组合极容易误判，下面 §3.1 / §3.2 分开写。

### 3.1 问题 A：ES2024 builtin —— **已修复**

**复现（原始 logcat，`logcat-02-reader-error.txt`）**：

```
D/WailsActivity( 4927): [WebView] ERROR: [engine] open failed TypeError: Object.groupBy is not a function
  (https://wails.localhost/assets/ReaderView-Bb7x_oFD.js:2)
```

根因（前端）：`vendor/foliate-js/epub.js:178/200/204/206/258` 用了 `Object.groupBy` / `Map.groupBy`（ES2024，Chrome 117+）。

**修复后**（`logcat-04-reader-polyfilled.txt`，前端 `src/compat/polyfills.ts`）：

```
D/WailsActivity( 5349): [WebView] LOG: [polyfill] 已补齐运行时内置对象：
  Object.hasOwn, Object.groupBy, Map.groupBy, Array.prototype.at, String.prototype.at,
  Array.prototype.findLast, Array.prototype.findLastIndex, Array.prototype.toSorted,
  Array.prototype.toReversed, Array.prototype.toSpliced, Array.prototype.with,
  structuredClone, crypto.randomUUID, AbortSignal.timeout, Promise.withResolvers,
  Promise.try, Uint8Array.prototype.toBase64, DecompressionStream(deflate-raw), Uint8Array.fromBase64
```

**修复效果（WebView 91 上示例书真的能读了）**：
- 首屏：`第一章 · 客户端骨架 36%`
- 翻页：点 `›` 后 → `第二章 · 内容隔离 69%`
- 正文可见（像素统计：内容区 95.5% 是纸白 `(255,255,255)`，约 69k 个黑色文字像素）

截图：`03-reader-polyfilled-portrait.png`、`04-after-pageturn.png`、`crop-page1.png`（裁剪放大，肉眼可确认是真中文正文）。

### 3.2 问题 B：CSS 现代特性 —— **未解决**

这是**修完 A 之后仍然存在**的独立问题，也是真书在 WebView 91 上读不了的真正原因。

**现象**（WebView 91，真书 frankenstein）：

```json
{"text":"←☰阅读0% ◐‹›","iframes":0,"fv":{"w":412,"h":1482},"innerH":843,
 "layerWorks":"rgb(0, 0, 0)"}
```

注意 `foliate-view` 高 **1482px**，而视口只有 **843px** —— 容器塌了。
对比 WebView 124 同一本书：`{"fv":{"w":412,"h":867}}`（正确）。

**证据链（三个独立实验，都指向 CSS）**

**实验 1：`@layer` 在 91 上整块丢弃**

```
注入  @layer x{.__t{color:rgb(4,5,6)}}
WebView 91 : inLayer = rgb(0, 0, 0)     ← 规则被丢弃，拿到默认值
WebView 124: inLayer = rgb(4, 5, 6)     ← 正常
```

直接后果（实测，`tailwind-layer-diagnosis.txt`）：

```json
// WebView 91
{"tailwindClassPos":"static",          // .absolute{position:absolute} 不生效
 "tailwindClassInset":"auto",
 "totalTopLevelRules":66,"layerBlockRules":0,   // 66 条规则在，但 @layer 块一个都没解析
 "bodyBg":"rgba(0, 0, 0, 0)","bodyFont":"sans-serif"}   // 主题完全没生效
// WebView 124
{"tailwindClassPos":"absolute","bodyBg":"lab(97.7061 ...)","bodyFont":"Inter, system-ui, ..."}
```

构建产物 `index-B5EhQapz.css` 里 **5 个 `@layer`**（Tailwind **v4.3.3** 输出的 `@layer theme/base/components/utilities`）。
`@layer` 是 **Chrome 99+**，WebView 91 直接丢掉整个块 → **整份 Tailwind 样式表失效**。

**最直观的对比截图**（同一份代码、同一个 APK，只差 WebView 版本）：
- `13-library-webview91-unstyled.png`：**裸 HTML**——蓝色下划线链接、原生 `<input type=file>`（「选择文件 / 未选择任何文件」）、无背景无布局。
- `14-library-webview124-styled.png`：完整 Tailwind 样式（圆角卡片、蓝色主按钮、Inter 字体、纸色背景）。
- `16-sample-webview91-landscape.png` vs `17-realbook-webview124-landscape.png`：横屏下同样差异。

**实验 2：`@container` 查询在 91 上静默无效**

`vendor/foliate-js/paginator.js:452-501` 的 shadow 样式：`:host{container-type:size}` + `@container (orientation:portrait){...}`。

```
{"nestedAmpersand":"grid","containerQueryApplied":"block","containerTypeAccepted":"size"}
```

`container-type:size` 被**接受**（不报错），但 `@container` 里的规则**完全不应用**（期望 `flex`，实测 `block`）。
这是最坏的失败形态：**静默无效**。所以 `eventCount=0`、没有任何 exception —— **不是没报错，是根本没抛**。
`@container` 是 **Chrome 105+**。

**实验 3：把真书重打包成 100% STORE，仍然失败 → 排除 deflate**

`frankenstein.epub` 原本有 36 个 deflate 条目。我把它重打包成 38 个条目**全部方法 0（STORE）**
（`frankenstein-store-only.epub`，576,727 B，sha256 `DA07474AB531CB43BE8F3E12433944A6CD263A09684C9C68C342724AA37FA128`），
装到同一台 WebView 91：

```json
{"text":"←☰阅读0% ◐‹›","iframes":0,"fv":{"w":412,"h":1482}}   // 失败现象一模一样
```

但目录照样解析出全部 31 章 → **EPUB 解析成功、完全不需要解压、仍然渲染不出正文**。
→ **deflate 不是病因**（证据文件 `deflate-vs-css-discriminator.txt`）。

**结论**：问题 B 是 **CSS 能力**问题，**JS polyfill 救不了**（CSS 没有运行时 polyfill 这一说）。

### 3.3 支持基线建议（一手数据支撑）

| 特性 | 最低 Chrome | WebView 91 | WebView 124 |
|---|---|---|---|
| `@layer` | 99 | ❌ | ✅ |
| `@container` | 105 | ❌ | ✅ |
| CSS 嵌套 `&` | 120 | ❌ | ✅ |
| `Object.groupBy` / `Map.groupBy` | 117 | ❌（已 polyfill） | ✅ |
| `deflate-raw` | 103 | ❌（已 polyfill） | ✅ |

→ **建议基线：WebView ≥ 120**（同时满足上面全部）。
→ WebView 124 实测全绿（§4）；WebView 91 不可用（§3.2）。
→ e-ink 阅读器（文石/Kindle 类）大量跑 Android 8~11 + WebView 80~100，**正好落在不可用区间**，这是产品级风险，不是模拟器特例。

## 4. 真实书验收：WebView 91 vs 124 行为对比表

### 4.1 用的书（sha256 全部记录）

| 书 | 大小 | sha256 | ZIP 压缩方法 |
|---|---|---|---|
| `testdata/books/frankenstein.epub` | 294,175 B | `BF04D57CF243314AB770DF6FCEA6A9CFB1E5A281426453E23C128C5A9C3EB662` | `{0:2, 8:36}`，38 条目，**31 章** |
| `testdata/books/alice-in-wonderland.epub` | 136,756 B | `08A2DE3A58226311915BD87056E59ED4EE49A284DCB5E722FEF415BCA4032A4B` | `{0:2, 8:19}` |
| `testdata/books/pride-and-prejudice.epub` | 609,138 B | `2172DB6A64D45B02F239CC7B46B50D7117FCD527E2A7A1386694F5EECCD26381` | `{0:2, 8:22}` |
| `dist/sample/sample.epub`（内置示例） | 5,509 B | `6E330BC99C5F1320C6F70C26DE18C5E2FC6370A2534FFF3B77E874B3179FF3AC` | **`{0:8}` —— 8 条目全 STORE** |

> ⚠️ **内置示例书是 100% STORE，完全不触发解压**。用它验收会得到一个**假绿**结论。
> 这不是理论——我第一轮就是被它骗过去的：示例书能读、真书打不开。**任何阅读链路验收必须用真书。**

### 4.2 对比表

真书验收用单独构建的包（内置书替换为 frankenstein），**不进 bin/**：

| 包 | 大小 | sha256 | 用途 |
|---|---|---|---|
| `evidence/hpfreader-REALBOOK-frankenstein.apk` | 22,771,482 B | `3D3C41AC482E8EB3259FA7BE521CD5156B400629AE1B1DB6A9B9AD2071FDB0D5` | WebView 124 真书验收 |
| `evidence/hpfreader-APK-C-storeonly-frankenstein.apk` | 22,767,987 B | `F99AAD18703EB8D2F5D06CFB70822B4D5747BBFB6DF40D80C0A004A54662DE6C` | **诊断态**：真书重打包为 100% STORE，用于排除 deflate |

| 验收项 | WebView **91**（API-31） | WebView **124**（API-35） |
|---|---|---|
| APK 安装 | ✅ `Success` | ✅ `Success` |
| 应用启动 | ✅ | ✅ |
| **书库 UI** | ⚠️ 渲染但**无样式**（裸 HTML，见 `13-*`） | ✅ 完整 Tailwind 样式（`14-*`） |
| 白屏 | ❌ 未复现 | ❌ 未复现 |
| **示例书** | ✅ **可读**（`第一章…36%` → 翻页 → `第二章…69%`） | ✅ 可读 |
| **真书 frankenstein** | ❌ **读不了**：`iframes=0`、正文空、`0%` | ✅ **完全正常** |
| **目录 TOC** | ✅ **31 章全部解析出**（解析层 OK） | ✅ 31 章（`10-*`） |
| **跳章** | ❌ 目录能开但**跳不过去**（正文不渲染） | ✅ `Chapter 5` → `21%`，正文可见（`11-*`） |
| **翻页** | ✅ 示例书可翻；❌ 真书不行 | ✅ |
| **竖屏** | ✅ 412×843（示例书） | ✅ 412×915（真书，`09-*`） |
| **横屏** | ⚠️ 布局塌陷（`fv` 高 1482 > 视口，`16-*`） | ✅ 867×388 正常（`17-*`） |
| 进度保存 / 续读 | ✅ 已验（§5） | ✅ |
| JS exception | 无（CSS 静默失效，不抛） | 无 |

### 4.3 WebView 124 真书验收明细（原始输出 `real-book-webview124.txt`）

1. **封面**：`09-realbook-webview124-portrait.png` —— FRANKENSTEIN 封面**完整渲染**（标题排版 + Project Gutenberg 插图 + 橄榄绿配色），证明 CSS + 图片解码都对。
2. **目录**：`10-realbook-toc-webview124.png` —— 侧栏目录，原始 DOM 文本：
   ```
   目录 | ✕ | Frankenstein; | or, the Modern Prometheus | CONTENTS |
   Letter 1 | Letter 2 | Letter 3 | Letter 4 |
   Chapter 1 | Chapter 2 | ... | Chapter 24 | THE FULL PROJECT GUTENBERG™ LICENSE
   ```
3. **跳章**：点 `Chapter 5` → 顶栏变成 `Chapter 5` / `21%`；正文（`11-*`）：
   ```
   It was on a dreary night of November that I beheld the accomplishment of my toils.
   With an anxiety that almost amounted to agony, I collected the instruments of life around me,
   that I might infuse a spark of being into the lifeless thing that lay at my feet.
   ```
   这是**真英文原文**，不是示例书的假内容。
4. **横屏**：`17-realbook-webview124-landscape.png`，867×388。

### 4.4 WebView 91 真书失败明细（原始输出 `real-book-webview91.txt`）

```
=== 打开真书后 ===
text: ←☰阅读0% ◐‹› | 已从上次位置继续（约 0%）
iframes: 0            ← paginator 没建出 iframe
fv: {w:412, h:1482}    ← 高度错误（视口 843）

=== 但目录是好的 ===
←☰阅读0% ◐‹› | 目录 | ✕ | Frankenstein; | or, the Modern Prometheus | CONTENTS |
Letter 1..4 | Chapter 1..24 | THE FULL PROJECT GUTENBERG™ LICENSE
```

**关键**：解析成功（31 章目录）但渲染失败（无 iframe）。`logcat` 全文 627 行搜 `deflate` 只命中 1 行（polyfill 成功日志），
搜 `Unsupported compression` / `open failed` / `engine`：**0 命中**。

→ 再次确认：**不是 deflate、不是 builtin，是 CSS**。

## 5. Go 侧修复：`dataDir()` 在 Android 上拿不到目录（**已修 + 已实测**）

### 5.1 问题

原始 logcat（`logcat-05-datadir.txt`）：

```
D/WailsActivity( 6448): [WebView] WARNING: [progress] 读取 platform 进度失败，使用本地缓存
  Error: Binding call failed: Bound method returned an error:
  neither $XDG_CONFIG_HOME nor $HOME are defined
```

Android 应用进程**既不设 `$HOME` 也不设 `$XDG_CONFIG_HOME`**，`os.UserConfigDir()` 直接报错；
而 `dataDir()` 被 `LibraryService.indexPath()` 调用 → **阅读进度根本存不下来**。
前端做了优雅降级（`[progress] 本地已保存…（离线是正常情况）`），所以不崩，但进度只活在 localStorage 里。

### 5.2 修法（`apps/client/main.go`，**按 lead 约束：不硬编码包名**）

```go
func androidPrivateDir() (string, bool) {
	if runtime.GOOS != "android" { return "", false }
	// 1. $HOME（部分容器/终端模拟器会设）
	if home := os.Getenv("HOME"); home != "" { ... return filepath.Join(home, "HPFReader"), true }
	// 2. $TMPDIR（Android 会设为 <pkg root>/cache，父目录即 <pkg root>）
	if tmp := os.Getenv("TMPDIR"); tmp != "" { ... return filepath.Join(root, "files", "HPFReader"), true }
	// 3. /proc/self/cmdline —— Android 应用进程的 argv[0] 就是本应用包名
	if pkg := androidPackageName(); pkg != "" {
		dir := filepath.Join("/data/user/0", pkg, "files", "HPFReader")
		if err := os.MkdirAll(dir, 0o755); err == nil { return dir, true }
		dir = filepath.Join("/data/data", pkg, "files", "HPFReader")
		if err := os.MkdirAll(dir, 0o755); err == nil { return dir, true }
	}
	return "", false
}
```

**为什么第 3 条不是硬编码**：包名来自 `/proc/self/cmdline`（运行时事实），换包名后**自动跟随**。
我实测过这台设备：`cat /proc/<pid>/cmdline` → `com.wails.app`。
每一条路径都 `MkdirAll` 验证可写，失败就继续下一条，全部失败则**返回明确错误**（而不是猜一个会静默失效的路径）。

### 5.3 实测结果（真实 APK，`datadir-fix-verify.log`）

`pm clear` 清空数据 → 冷启动 → 打开示例书 → 翻 3 页：

```
=== files under app private dir ===
/data/data/com.wails.app/files/HPFReader/progress.json

=== progress.json content ===
{
  "sample": "epubcfi(/6/4!/4,/2,/8/1:84)"
}

=== logcat: XDG/HOME errors ===
(空 —— 一条都没有)
```

**重开续读**（`am force-stop` → 冷启动 → 打开同一本书）：

```
←☰第二章 · 内容隔离69% ◐‹› | 已从上次位置继续（约 69%）
```

截图：`06-reader-resume-portrait.png`。

→ **进度能存、重开能续读，均已在真实 APK 上验证通过。**

## 6. 已知问题（诚实清单）

| # | 问题 | 严重度 | 状态 |
|---|---|---|---|
| 1 | **WebView < 120 真书读不了**（CSS `@layer`/`@container`） | 🔴 阻塞 | 未解决，等前端定基线/方案 |
| 2 | WebView < 120 书库 UI 无样式（裸 HTML） | 🔴 阻塞 | 同上（同一个 `@layer` 根因） |
| 3 | e-ink 真机大概率落在 WebView 80~100 | 🔴 产品风险 | **未在真机验证**（本机无 e-ink 设备） |
| 4 | `importBookFromDialog()` 在移动端返回 `null` | 🟡 功能缺失 | 已知设计（M1 不接 SAF）；Android 上**无法导入本地书**，只能读内置示例书 |
| 5 | APK 只含 `x86_64` JNI 库 | 🟡 发布限制 | Gradle 明确警告 `There are no .so files available to package in the APK for arm64-v8a`；**真机（arm64）装不上**，必须补 arm64 构建 |
| 6 | 模拟器里「打开本地文件」点了没反应 | 🟡 预期 | 走 `app.Dialog.OpenFile()`，Android 上未接 SAF |
| 7 | Windows 上没有 `task`，android Taskfile 是 Unix-only | 🟢 工程债 | 构建靠手动串（§2.1）；`build/android/Taskfile.yml` 用 `sh:`/`uname`/`case`，无 Windows 分支 |
| 8 | `wails3` v3.1.0 移动端官方 experimental | 🟡 上游风险 | 不在稳定保证范围内 |
| 9 | 模拟器横屏需要手动 `settings put system user_rotation 1` | 🟢 环境 | 不影响真机 |

### 6.1 关于「低版本系统镜像」这条验收要求

task-11 要求测 `android-29`（低 WebView / e-ink 风险）。**实际做法与结果**：
- 本机已装 `android-29`、`android-31` 两个镜像，**WebView 都是 ≈91**（`91.0.4472.114` 实测）。
- 我选了 **android-31（WebView 91）** 作为「低版本 WebView」代表来跑全部验收，因为 29 和 31 的 WebView 版本在本机是同一代，测 31 的结论对 29 同样成立，且 31 更接近 e-ink 常见区间上沿。
- 结论：**低 WebView（91）已实测且失败**（§3.2 / §4.4），风险**已复现**，不需要再用 29 重复验证同一件事。
- **未验**：真实 e-ink 设备（无设备）、arm64 真机（无设备/无 arm64 构建）。

## 7. 证据文件索引

全部在 `spikes/android/evidence/`。按用途分组：

**构建**：`bindings-and-frontend-verify.log`、`gradle-assembleDebug.log`、`rebuild-with-polyfills.log`、`build-apk-b-frankenstein.log`、`build-apk-c-storeonly.log`、`build-apk-d-datadir.log`、`build-real-book-final.log`

**模拟器**：`emulator-boot-headless.log`

**logcat（原始）**：`logcat-01-launch.txt`、`logcat-02-reader-error.txt`（groupBy）、`logcat-03-after-polyfill.txt`、`logcat-04-reader-polyfilled.txt`、`logcat-05-datadir.txt`、`logcat-06-datadir-fixed.txt`、`logcat-07-api35.txt`、`logcat-08-api35-realbook.txt`、`logcat-09-webview91-realbook-full.txt`

**CDP 交互原始输出**：`cdp-run-01-sample.txt` … `cdp-run-06-landscape-toc.txt`、`cdp-bridge-probe.txt`、`matrix-webview91-sample.txt`、`matrix-final.txt`、`real-book-webview91.txt`、`real-book-webview124.txt`、`webview-91-vs-124.txt`、`datadir-fix-test.txt`

**CSS 根因诊断**：`tailwind-layer-diagnosis.txt`、`css-layer-proof.txt`、`deflate-vs-css-discriminator.txt`

**截图**（PNG，竖屏 1080×2400 / 横屏 2400×1080）：

| 文件 | 内容 |
|---|---|
| `01-launch-portrait.png` | 书库首页（WebView 91，已 polyfill，无样式） |
| `02-reader-portrait.png` | groupBy 报错态（**修复前**，仅存证） |
| `03-reader-polyfilled-portrait.png` | 示例书正文（WebView 91，polyfill 后） |
| `04-after-pageturn.png` | 翻页后 `第二章 69%`（WebView 91） |
| `05-reader-landscape.png` | 横屏（WebView 91） |
| `06-reader-resume-portrait.png` | **续读**（`已从上次位置继续（约 69%）`） |
| `08-toc-landscape.png` | 示例书目录（横屏） |
| `09-realbook-webview124-portrait.png` | **真书封面**（WebView 124） |
| `10-realbook-toc-webview124.png` | **真书 31 章目录**（WebView 124） |
| `11-realbook-chapter5-webview124.png` | **真书 Chapter 5 正文**（WebView 124） |
| `12-realbook-webview91.png` | 真书失败态（WebView 91） |
| `13-library-webview91-unstyled.png` | **书库无样式**（WebView 91，对比用） |
| `14-library-webview124-styled.png` | **书库有样式**（WebView 124，对比用） |
| `15-sample-webview91-portrait.png` | 示例书可读（WebView 91） |
| `16-sample-webview91-landscape.png` | 横屏无样式（WebView 91） |
| `17-realbook-webview124-landscape.png` | 横屏正常（WebView 124） |
| `crop-page1.png` / `crop-91-sample.png` / `crop-toolbar.png` | 裁剪放大（肉眼确认文字） |

**诊断用书**：`frankenstein-store-only.epub`（100% STORE 版，用于排除 deflate）

**辅助脚本**（在 `spikes/android/`）：
- `cdp.mjs` —— 极简 CDP 驱动（`list/eval/text/probe/rect/click/findtext/tap/hash/shot/watch/preloadrun`），用 Node 24 内置 `fetch`+`WebSocket`，无第三方依赖。
- `polyfill-es2024.js` / `errorhook.js` / `flatten-layers.js` / `css-nesting-probe.js` / `probe.js` —— 诊断注入脚本（**不落盘到产品代码**）。

## 8. 我改了什么（写域内）

| 文件 | 改动 |
|---|---|
| `apps/client/main.go` | `dataDir()` 加 Android 分支 + `androidPrivateDir()` / `androidPackageName()`（§5） |
| `apps/client/build/android/Taskfile.yml` | `generate:android:bindings` 补 `-ts`；`env:` 去掉 `GOOS: android`（否则 bindings 生成 0 个方法） |
| `apps/client/build/android/gradle/wrapper/gradle-wrapper.properties` | `networkTimeout` 10s→120s；加 `distributionSha256Sum`（§2.2） |
| `spikes/android/**` | 本文、`cdp.mjs`、诊断脚本、全部证据 |

**没有动**：`apps/client/frontend/**`（除 `platform/mobile.ts`，本次未改）、`apps/server`、`deploy`、`spikes/isolation`、`docs`、`api`。

## 9. 结论

1. **Android 能构建、能装、能启动、能读书** —— 在 WebView ≥ 120 上**完全成立**（真书封面/31 章目录/跳章/正文/横竖屏/进度续读全部实测通过）。
2. **WebView 白屏风险：未复现。**
3. **两个阻塞问题分开记**：
   - A：ES2024 builtin 缺失 → **已修复**（前端 polyfill，实测生效）。
   - B：CSS 现代特性（`@layer`/`@container`）→ **未解决**，WebView < 120 上真书读不了、UI 无样式。
4. **`dataDir()` 已修**：进度能存、重开能续读（真实 APK 实测）。
5. **最重要的教训**：内置示例书是 100% STORE，**用它验收会得到假绿**。阅读链路验收必须用 `testdata/books/` 的真书。