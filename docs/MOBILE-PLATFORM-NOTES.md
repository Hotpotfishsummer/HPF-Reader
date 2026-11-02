# 移动端平台现实（2026-11-02 实测）

> 结论先行：**Android 可在本机构建（补齐 gomobile 即可）；iOS 在 Windows 上无法构建，必须有 macOS。**

## 1. Wails v3 的官方移动端工具

`wails3` CLI 自带移动端子命令（不是第三方插件）：

| 命令 | 用途 |
|---|---|
| `wails3 android ...` | Android 工程生成、构建、打包 |
| `wails3 ios ...`      | iOS 工程生成、构建、打包（**macOS only**） |
| `wails3 package`      | 打包产物（安装器 / AAB / IPA） |
| `wails3 signing`      | 签名配置 |

注意：`wails3 build` **没有平台参数**，移动端构建走 `android` / `ios` 子命令或 Taskfile 任务。

## 2. 本机 Android 工具链（齐全）

| 组件 | 实测内容 |
|---|---|
| Android SDK | `C:\Users\HOTPOTFISH\AppData\Local\Android\Sdk` |
| build-tools | 23.0.1 → **36.1.0**（含 36.0.0-rc3） |
| platforms | android-30 / 33 / 34 / 35 / **36 / 36.1** |
| NDK | 16.1 → **29.0.14206865**（多版本并存） |
| cmdline-tools | latest / 16.0 / 8.0 等 |
| platform-tools | `adb.exe` 可用 |
| JDK | `C:\Program Files\Microsoft\jdk-21.0.4.7-hotspot`（JAVA_HOME 已设） |
| **gomobile** | **未安装** → 已派后台任务安装 `golang.org/x/mobile/cmd/gomobile@latest` |

→ **Android 侧只差 gomobile 一步**，之后即可尝试 `wails3 android build`。

## 3. iOS：Windows 上的硬阻塞

| 检查项 | 结果 |
|---|---|
| `xcodebuild` | **不存在**（Windows 无 Xcode） |
| Wails iOS 构建链路 | 需要 Xcode 工具链 + iOS SDK + 代码签名（IPA 必须 Apple 开发者账号） |
| WSL | 本机有 WSL2（docker-desktop 发行版），但**WSL 不能构建 iOS** |

**因此 iOS 只有三条路**：
1. 一台 Mac（真机或 Mac mini）；
2. macOS CI（如 GitHub Actions 的 macos runner）打到 Apple 开发者账号；
3. 暂时放弃 iOS，先只做 Android + 桌面 + Web。

> 这直接影响 docs/OPEN-QUESTIONS.md 的 **Q12（移动端策略）**：即使 Wails v3 的移动端成熟度问题解决了，**iOS 的构建环境**仍是独立的、必须由你决定的开销。

## 4. 建议的移动端推进顺序

| 阶段 | 内容 | 前置 |
|---|---|---|
| M-1 | Android 桌面级验证：`wails3 android build` 出 APK，装到真机打开 | 补齐 gomobile |
| M-2 | **e-ink / 老旧 WebView 专项**：Onyx Boox 类设备或低版本 WebView 机型验证白屏问题 | M-1 |
| M-3 | iOS 环境决策（Mac / macOS CI / 放弃） | **需你拍板** |
| M-4 | iOS 构建与真机验证 | M-3 |

## 5. 与隔离架构（ADR-003）的交叉点

移动端是**不可信内容隔离最薄弱的环节**：
- Android 上 `window.wails` 桥**对所有 frame 暴露**（v3.0.0 官方 Known limitations）；
- 移动端没有「多窗口」可以分摊风险（仅第一个窗口可用）；
- 因此 ADR-003 的 **L2（净化 + 逐节 CSP）在移动端不是可选项，而是唯一可用的主力防线**；L4（窗口限权）在移动端基本不可用。

→ **G2 隔离 PoC 的结论会直接约束移动端方案**；若 L4 不成立，移动端必须走 L5 结构化渲染或显著降低渲染保真度。

## 6. 证据来源

| 结论 | 来源 |
|---|---|
| `wails3` 含 ios/android 子命令、build 无平台参数 | 本机 `wails3 --help` / `wails3 build --help` 实测 |
| Android SDK 组件与版本 | 本机目录实测 |
| xcodebuild 缺失 | 本机 `Get-Command xcodebuild` 实测 |
| iOS 需 Xcode 与 macOS | Wails 官方文档与常识约束（构建链路需 Apple 工具链） |
| Android 桥对所有 frame 暴露 | docs/research/40-wails-v3.md（v3.0.0 官方 Known limitations 原文） |
---

## 7. ⚠️ 实测发现的兼容性下限：WebView 91（2026-11-03，Android 模拟器真机复现）

这是「移动端不在稳定性承诺内」之外、**我们自己代码层面**的真实缺陷，已在真实 APK 上复现并定位。

### 7.1 现象与根因

| 项 | 实测值 |
|---|---|
| 模拟器 WebView | **`Chrome/91.0.4472.114`**（Pixel_6 AVD，Android 12 / API 31 系统镜像） |
| 触发点 | 点「打开示例书」后 `Object.groupBy is not a function` |
| 源码位置 | vendored `foliate-js/epub.js` 第 178 / 200 / 204 / 206 / 258 行，使用 ES2024 `Object.groupBy` / `Map.groupBy`（需 Chrome 117+） |
| logcat 原文 | `D/WailsActivity(4927): [WebView] ERROR: [engine] open failed TypeError: Object.groupBy is not a function (.../ReaderView-Bb7x_oFD.js:2)` |
| 影响面 | **Android 上「打开书」必挂**；桌面 WebView2 版本新，所以**在 Windows 上完全没暴露** |

### 7.2 为什么这不是「降级构建目标」能解决的

`Object.groupBy` 是**运行时内置方法**，不是语法。esbuild / rolldown 之类的打包器只做语法降级，**不会** polyfill 内置对象。必须自己补 polyfill（或引入 core-js 这类运行时）。

### 7.3 处置

| # | 措施 |
|---|---|
| 1 | 在 `src/compat/polyfills.ts` 补齐缺失的 ES2024+ 内置对象，并在 `src/main.ts` **最顶部最先导入**（必须先于任何业务与 foliate-js 代码执行） |
| 2 | 全量审计（不只是这两个）：`Object.groupBy`、`Map.groupBy`、`Promise.withResolvers`、`Array.prototype.with`、`Object.hasOwn`、`structuredClone`、`findLast`/`findLastIndex`、`String.prototype.replaceAll`、`Array.prototype.at` 等 |
| 3 | `vite.config.ts` 下调 `build.target` 到保守基线，防止将来新语法再踩 |
| 4 | **不改 vendored 的上游源码**——补丁记在 `VENDOR.md`；polyfill 属于我们自己的兼容层 |

### 7.4 支持基线（连带结论）

- 移动端**最低支持 WebView 91 / Android 12**（补 polyfill 后）；
- 真机上 WebView 一般可由应用商店更新到很新，但**国产 ROM 与 e-ink 设备常年不更新**，所以不能假设；
- 启动时若检测到 WebView 低于基线，应给出**可读提示**，而不是白屏或静默失败。

### 7.5 其它已解决的环境坑（复现时照做）

| 坑 | 现象 | 处置 |
|---|---|---|
| 模拟器带窗口启动 | `Failed to load opengl32sw` → QEMU 线程 hang → exit 1 | **必须 `-no-window`**（`sys.boot_completed=1` 可正常起） |
| Gradle 官方源在本机被墙 | HTTP 307，12 秒内 0 字节 | 用镜像下载，**并用官方 `.sha256` 校验一致**后写入 wrapper 缓存；校验和记入 `gradle-wrapper.properties` |
| gradle wrapper 读超时 | `networkTimeout=10000` 对 135MB 分发包必挂 | 调到 `120000` |
| Android 绑定生成损坏前端 | `wails3 generate bindings -f '-tags android' -clean=true` 缺 `-ts` 且带 `-clean` → 清掉 `.ts` 绑定，前端报 TS7016；另外 `env: GOOS=android` 会让分析器解析不到 GOROOT stdlib，产出**空 bindings**（`1 Package, 0 Services, 0 Methods`） | 改为 `wails3 generate bindings -ts -i -f '-tags android' -clean=true`，并删除该 env（保留 `CGO_ENABLED=0`） |
