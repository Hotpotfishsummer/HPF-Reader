# 40 · Wails v3 深度核实：移动端、Server 构建、绑定模型、安全与版本节奏

> **任务**：task-4 ｜ **交付**：docs/research/40-wails-v3.md
> **撰写日期**：2026-11-02 ｜ **证据采集日期**：2026-11-02（除单独标注外）
> **背景**：用户已拍板客户端外壳改用 **Wails v3 + Vue 3**（替代此前的 Tauri v2 + React 方案）。本文件承接 task-1（docs/research/10-client-frontend.md）的跨端框架调研结论，重新核实 Wails v3 的真实能力边界。
> **方法**：一手证据优先——GitHub REST API（仓库 / 发布 / tag 列表）、仓库内官方文档源码（`docs/mpress/content/`）、官方 FAQ 与 v3 文档站、npm registry、GitHub Security Advisory 编号。凡未取证者一律标注「**未验证**」，不编造版本号、API、字段或结论。

> **⚠️ 本文最重要的三条更正（与 Lead 原假设不同）**
> 1. **v3.0.1 从未发布**。GA 之后的下一个稳定版是 **v3.1.0（2026-11-01）**，二者之间只有 nightly。「3.0.1 修 Android bridge」的计划没有以该版本号落地。
> 2. **v3.1.0 的发布说明中没有任何与 frame / origin / bridge / 安全公告相关的条目**（详见 6.2）。因此「3.0.1 / 3.1.x 已修复 frame 暴露」**无法被证实**。
> 3. **Wails 官方明确把 iOS / Android 定为实验性，且明确排除在稳定性承诺之外**（FAQ 原文，2026-11-01）。这不是我们的推断。

---

## 0. 结论速览（TL;DR）

| 项目 | 结论 |
|---|---|
| **桌面端** | 可用。v3.0.0（2026-10-26）是 Windows / macOS / Linux 的**稳定版**，官方口径明确 |
| **移动端** | **实验性**（官方原文）。原文：「Android 和 iOS 支持仍处于实验阶段，不在稳定桌面版兼容性约定的范围内。」截至 2026-11-02，GA 仅 **7 天** |
| **Server 构建** | **一等公民**，且是 Wails 相对 Tauri 的**真实优势**：同一份 `main.go` 加 `-tags server` 即可产出纯 HTTP 服务，官方提供 `build:server` / `run:server` / Docker 工作流与 `/health` 端点 |
| **「同一 main.go 同时产出桌面 / 移动 / Web」** | **基本成立但有边界**：前端与 service 代码完全共享；但窗口 / 托盘 / 菜单 / 对话框在 server 模式不可用，移动端多窗口不可用；Android / iOS 的 `application.Android` / `application.IOS` API 在 server 构建中不存在，必须用 `!server` 构建约束隔离 |
| **绑定模型** | 只有导出方法（PascalCase）被绑定；**service 是跨所有窗口共享的单例**（需自行加锁）；生成 TS 绑定到 `./bindings/<pkg>/<Service>` |
| **本地数据库** | **官方无任何 DB 能力或插件**（`features/` 目录下没有 database 项）。官方示例直接用 `sql.Open("sqlite3", ...)`（cgo 驱动） |
| **许可** | **MIT**（GitHub API `license.spdx_id = MIT`），`@wailsio/runtime` 亦为 MIT → **可闭源商用，未见附加条款** |
| **版本节奏** | **周更**（标题即 "Wails v3 Weekly Release - v3.1.0"）+ nightly。生产项目必须**钉死精确版本**，官方自己在 nightly 说明里也这么建议 |
| **最大安全风险** | v3.0.0 发布说明**自己承认**：跨平台子 frame 的绑定调用走 HTTP 到 `/wails/runtime`，守卫**不限制**它们；Android 上 `window.wails` 暴露给**所有 frame**；Linux 上**同源**子 frame 无法被守卫阻止。原文结论：「**Treat any iframe you embed as having access to your bound Go methods**」「**Do not embed untrusted same-origin content in a Wails window**」 |
| **对阅读器的直接冲击** | 我们的核心场景是**渲染不可信 EPUB（本质是打包的 HTML / CSS / JS）**。上面那条正是为该场景写下的最坏情况。→ 必须做架构级补偿，清单见第 11 节 |
| **相对 Tauri 的关键差距** | ① 移动端成熟度差距明显（Tauri 移动端已生产使用 2 年、Readest 双商店上架；Wails 移动端 GA 仅 7 天且官方标注实验性）；② Wails **缺少 Tauri 的 CSP 配置项 + capability / permission 授权模型**；③ Wails **没有** `tauri-plugin-webview-upgrade` 这类 Android WebView 升级方案 |

---

## 1. 版本与节奏现状

### 1.1 仓库事实基线

| 项目 | 事实 | 证据来源 | 证据日期 |
|---|---|---|---|
| 仓库 | `wailsapp/wails` | GitHub API | 2026-11-02 |
| 主语言 / 许可 | Go / **MIT**（`spdx_id = MIT`） | GitHub API | 2026-11-02 |
| Stars / Forks / Open Issues | 36,915 / 1,918 / 360 | GitHub API | 2026-11-02 |
| 创建 / 最后推送 | 2018-12-15 / 2026-11-02T10:27:46Z | GitHub API | 2026-11-02 |
| 归档状态 / 默认分支 | `archived: false` / `master` | GitHub API | 2026-11-02 |
| 描述 | "Create beautiful applications using Go" | GitHub API | 2026-11-02 |

### 1.2 发布线（实测，来自 GitHub Releases API 与 git tags）

| 版本 | 发布日期 | 类型 | 备注 |
|---|---|---|---|
| **v3.0.0** | **2026-10-26** | 稳定（GA） | 首个 v3 稳定版。原文："It has been nearly four years since the first v3 alpha in January 2023" |
| v3.0.0-beta.0 … beta.34 | 2026-08-03 … 2026-10-20 | 预发布 | beta 阶段约 11 周内发布 35 个 beta |
| v3.1.0-nightly.20261027 / .20261028 | 2026-10-27 / 2026-10-28 | nightly | GA 之后的 nightly |
| **v3.1.0** | **2026-11-01** | 稳定 | 标题即 "**Wails v3 Weekly Release - v3.1.0**"；距 GA **6 天** |
| v3.2.0-nightly.20261101 | 2026-11-01 | nightly | "Nightly preview of the upcoming v3.2.0" |
| v2.17.1 | 2026-11-01 | 稳定 | **v2 仍在同日发布**，与 v3 并行维护 |
| ~~v3.0.1~~ | **不存在** | — | **git tag 列表与 Releases API 中均无 v3.0.1** |

> 证据：[tags 列表](https://api.github.com/repos/wailsapp/wails/tags?per_page=100)、[releases 列表](https://api.github.com/repos/wailsapp/wails/releases?per_page=40)（证据日期 2026-11-02）。

### 1.3 ✅ 关键更正：v3.0.1 从未发布

任务书要求核实「v3.0.0 之后的 3.0.1 / 3.1.x 修了什么」。实测结论：

1. **`v3.0.1` 这个 tag 不存在**；Releases API 中也无该版本。GA 之后的下一个稳定 tag 直接是 **v3.1.0**。
2. v3.0.0 发布说明中写着「**A fix is planned for 3.0.1**」（针对 Android 的 `window.wails` frame 暴露）——该计划**没有以 3.0.1 这个版本号兑现**。
3. v3.1.0（2026-11-01）的发布说明是一份自动生成的周更清单（Added / Changed / Fixed），其中**没有任何**与 `frame` / `origin` / `bridge` / `guard` / `advisory` / `GHSA` 相关的条目。唯一含 "permission" 的条目是 "retain source permissions for new file copies"（文件权限位，与安全隔离无关）。
4. v3.2.0-nightly.20261101 的说明同样**不含**相关条目（其 Fixed 仅 3 条：nightly 构建问题、release 校验、跨平台校验失败）。

> **对任务书问题的精确回答**：**无法证实 3.0.1 / 3.1.x 已修复 frame 暴露**。既没有 3.0.1，3.1.0 的发布说明中也没有对应修复记录。
>
> **⚠️ 限制**：v3.1.0 的条目由 PR 标题自动生成，理论上存在「修复已合并但 PR 标题未体现」的可能。本文**未**逐 PR 审查 `/wails/runtime` 与 Android bridge 的实现代码，因此准确表述是「**未验证到修复**」，而非「确定未修复」。建议在架构决策前直接在各目标平台做一次运行时验证（见第 11 节 M0 项）。

**第三方旁证**（独立媒体报道，与上述一手证据一致）：

> "On experimental Android, the `window.wails` bridge is exposed to every WebView frame pending a planned fix. Across platforms, bound-method calls from child frames can use `/wails/runtime` over HTTP; treat any embedded iframe as capable of calling exposed Go methods. Avoid untrusted iframe content and apply least privilege to bindings."
> "**What to watch next**: Wails 3.0.1 fix for experimental Android bridge exposure and closure of GHSA-2p5f-2gx8-mh8m. v3.1 removal of GTK3 legacy path and weekly releases."

> 来源：第三方报道 "Wails 3.0 reaches stable release with a new Go desktop architecture — mobile remains experimental"，证据日期 2026-11-02。**注意**：该报道把「3.0.1 修复」列为 **待发生事项（What to watch next）**，与我们实测的「v3.0.1 不存在」一致。

### 1.4 工具链与版本号

| 项目 | 值 | 证据 |
|---|---|---|
| CLI 名称 | `wails3`（**不是 `wails`**；v2 CLI 为 `wails`，两者模块路径独立、可共存） | [v3.0.0 发布说明](https://github.com/wailsapp/wails/releases/tag/v3.0.0) |
| 安装 | `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0` | 同上 |
| Go 版本要求 | **Go 1.26 或更高**；官方建议 `1.26.10` 或 `1.27.3`（含 `crypto/x509` 修复） | v3.0.0 发布说明；[FAQ](https://v3.wails.io/zh-cn/faq/)（2026-11-01）；`guides/mobile/ios.md`、`android.md` |
| ⚠️ 文档内部不一致 | `guides/mobile/index.md` 的先决条件表格写 "Go **1.25+**"，而 `ios.md` / `android.md` / FAQ / 发布说明均写 **1.26+** → 以 1.26+ 为准，1.25+ 应为过期表述 | 同上 |
| JS 运行时 | `@wailsio/runtime`，npm latest **3.1.0**（2026-11-01 发布；共 103 个版本；MIT） | [npm registry](https://registry.npmjs.org/@wailsio/runtime)（2026-11-02） |
| 版本对齐建议 | 官方在 nightly 说明中明确："always **pin an exact version** (e.g. `@v3.2.0-nightly.20261101`) in `go.mod` and CI rather than `@latest`" | v3.2.0-nightly 说明 |

### 1.5 周更节奏对生产项目意味着什么

| 维度 | 事实 | 对项目的含义 |
|---|---|---|
| 发布频率 | 周更 minor（v3.1.0 标题即 "Weekly Release"）+ 每日 nightly | 修补速度快（利好），但依赖面持续变动（风险） |
| nightly 性质 | "It is **not selected by `@latest`**" | 不会被意外拉入，可安全忽略 |
| 迭代强度 | v3.1.0 的 Changed 列表含 20+ 条内部性能 / 分配优化 PR，Fixed 30+ 条 | **v3.1.0 仍处高强度迭代期**，内部实现仍在剧烈调整 |
| 兼容承诺 | 桌面有稳定性承诺；**移动端明确不在承诺范围内** | 桌面可跟随 minor 升级；移动端每次升级都需回归 |
| v2 并行维护 | v2.17.1 与 v3.1.0 **同日（2026-11-01）发布** | v2 未被放弃；但 v2 **无移动端**，因此不是移动端的退路 |
| 实操建议 | 锁定 `wails3` CLI 版本 = `@wailsio/runtime` 版本；CI 中显式指定 | 避免 CLI 与运行时版本错配导致绑定不兼容 |

---

## 2. 移动端真实能力（最关键）

### 2.1 官方定位与措辞（原文，务务必逐字看待）

| 来源 | 原文 | 证据日期 |
|---|---|---|
| FAQ「Wails v3 是否已可用于生产环境?」 | 「Wails v3.0.0 是面向 Windows、macOS 和 Linux 桌面应用程序的稳定版本。**Android 和 iOS 支持仍处于实验阶段，不在稳定桌面版兼容性约定的范围内。**」 | 2026-11-01 |
| v3.0.0 发布说明 Platforms 段 | "**iOS and Android (experimental).** The same `main.go` and frontend can run on mobile. **Try it and tell us what you find; it isn't yet covered by the stability promise.**" | 2026-10-26 |
| `guides/mobile/index.md` | "Wails v3 runs on **iOS and Android** using the same `main.go` and frontend you already write for desktop. There is no separate mobile project, no code-sharing bridge, and no rewrite" | 2026-11-02（master） |

> **判定**：官方对移动端的措辞**一致且明确**——「实验性 / 不在稳定性承诺内 / 欢迎试用反馈」。这与 Tauri 在 2024-10-02 宣布移动端稳定、并由 Readest 在双商店生产验证两年的状态**不在同一成熟度量级**。

### 2.2 移动端实现与工具链要求

| 项目 | iOS | Android |
|---|---|---|
| WebView 宿主 | `WKWebView` inside a `UIViewController` | `WebView` inside an `Activity` |
| 资源加载 | 自定义 `wails://` scheme，**无开放端口** | `WebViewAssetLoader`，**进程内**从 Go 内存提供，无 localhost 服务 |
| Go 产物 | 以 `GOOS=ios` 编译 | 经 NDK 编译为 `libwails.so` |
| 构建主机 | **仅 macOS**，且需**完整 Xcode**（命令行工具不够） | macOS / Linux / Windows 均可 |
| 工具链 | 完整 Xcode | Android SDK + platform-tools + SDK platform **API 35** + build-tools **35.0.0** + **NDK 26.3.x** + JDK（如 OpenJDK 21） |
| Go / npm | Go 1.26+ 与 npm | Go 1.26+ 与 npm |
| 环境变量 | — | `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` |
| 最低系统版本 | `minIOSVersion` 默认 **"15.0"**（可配置） | `compileSdk` / `targetSdk` = **35**（模板默认） |
| 自检 | `wails3 doctor`（列出找到的 iOS SDK） | `wails3 doctor` |
| 调试 | 调试构建可从 **Safari 的 Develop 菜单**检查 WebView | 调试构建可从 Chrome `chrome://inspect` 检查 |

> 来源：`guides/mobile/ios.md`、`guides/mobile/android.md`（master，证据日期 2026-11-02）。

**构建标签陷阱（官方明确警告，极易踩坑）**

- **`ios` implies `darwin`**：写 `//go:build darwin` 的文件**也会**在 iOS 上编译。要只针对 macOS，必须写 `//go:build darwin && !ios`。
- **`android` implies `linux`**：写 `//go:build linux` 的文件**也会**在 Android 上编译。要只针对桌面 Linux，必须写 `//go:build linux && !android`。
- 运行时检测用 `application.System.IsMobile()` / `IsDesktop()` / `IsServer()`（无需构建标签）；前端对应 `System.IsMobile()` / `System.IsIOS()` 等。

### 2.3 移动端能力矩阵（官方表格，原文照录）

| 能力 | iOS | Android |
|---|---|---|
| Service bindings（JS → Go） | ✅ | ✅ |
| Events（双向） | ✅ | ✅ |
| Message dialogs | ✅ `UIAlertController` | ✅ `AlertDialog` |
| Open file dialogs | ✅ `UIDocumentPicker` | ✅ Storage Access Framework |
| **Save file dialogs** | ❌ 改为写沙盒 | ❌ 改为写沙盒 |
| Open directory dialogs | — | ❌ **返回错误**，改为写沙盒 |
| Clipboard | ✅ `UIPasteboard` | ✅ `ClipboardManager` |
| Screens / 安全区度量 | ✅ | ✅ |
| 生命周期事件 | ✅ `events.IOS.*` | ✅ `events.Android.*` |
| 触觉反馈 | ✅ `IOS.Haptics.*` | ✅ `Android.Haptics.Vibrate` |
| 设备信息 | ✅ `IOS.Device.Info()` | ✅ `Android.Device.Info()` |
| 原生标签栏 | ✅ `UITabBar` | — |
| Toast | — | ✅ `Android.Toast.Show` |
| **多窗口** | ❌ **仅第一个窗口** | ❌ **仅第一个窗口** |
| **窗口几何 / 菜单 / 托盘** | **intentional no-ops（有意为之的空操作）** | **intentional no-ops** |
| WebView + 进程内资源 | ✅ | ✅ |
| 模拟器 + 真机构建 | ✅ | ✅ |

> 来源：`guides/mobile/index.md`、`guides/mobile/ios.md`、`guides/mobile/android.md`（证据日期 2026-11-02）。
>
> **对阅读器的含义**：**多窗口在移动端不可用**。桌面端若用「双窗口」实现双栏 / 对照阅读，移动端**必须有单窗口内的替代实现**（Vue 内部 pane 布局），否则功能直接缺失。同理，**托盘 / 菜单类功能在移动端是空操作**，前端必须做能力探测而非假设 API 可用。

### 2.4 构建、签名与上架

**iOS 任务**（`wails3 task ...`）

| 任务 | 用途 |
|---|---|
| `ios:run` | 构建 + 启动模拟器 |
| `ios:package` | 生产 `.app`（模拟器） |
| `ios:package` + `IOS_PLATFORM=device` + `CODESIGN_IDENTITY` + `PROVISIONING_PROFILE` | 真机构建（需签名身份与预置描述文件） |
| `ios:deploy-device` | 经 `xcrun devicectl` 安装到真机 |
| `ios:package:ipa` | 分发用 IPA（App Store / TestFlight） |
| `ios:xcode` | 打开生成的 Xcode 工程 |
| `ios:logs:dev` | 流式查看模拟器日志 |

> 官方提示（原文要点）：上传到 App Store Connect 时，**建议用 `wails3 task ios:xcode` 并让 Xcode 管理签名与归档**——「它会自动处理证书、描述文件和公证等复杂事项」。
> **含义**：Wails 自身的 IPA 任务**不覆盖完整的商店签名 / 公证流程**，实际交付要落到 Xcode。对项目排期而言，iOS 上架链路是一个独立交付项。

**Android 任务与商店要求**

| 项目 | 事实 |
|---|---|
| 调试 APK | `android:package`（用 Android **debug keystore** 签名，可直接安装） |
| 发布签名 | 需设 `ANDROID_KEYSTORE_FILE` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` |
| 无 keystore 时 | 发布构建**仍用 debug keystore 签名**（可安装测试）；但 `bundle` 任务会**打印警告**，且 "**Google Play will reject it**" |
| AAB | `android:bundle:fat` 产出 `bin/<AppName>.aab`（含全部 ABI），是**商店上传的正确产物**（AAB 不能用 adb 直接安装） |
| Play 要求 | 新提交必须用 `.aab` 格式，且必须 **target Android 15（API 35）或更高** |
| Play App Signing | 本地签名用的是 **upload key**；Google 用自己管理的 app signing key 重新签名 |
| ABI | `android:package:fat` 产出含 `arm64-v8a` 与 `x86_64` 的单一 APK |

> 来源：`guides/mobile/android.md`、`guides/mobile/ios.md`（证据日期 2026-11-02）。
>
> **判定**：**签名、打包、商店上传的官方路径是完备的**（含 AAB、upload key、API 35 要求）。这是 Wails v3 GA 的一项实打实的工作成果。

### 2.5 ❌ 是否有人真的成功上架 App Store / Google Play —— **未验证**

| 核查项 | 结果 |
|---|---|
| 官方是否提供生产级移动端示例 | 只找到 **Kitchen Sink**（`v3/examples/mobile`），属**框架能力演示**（7 个标签页），不是上架应用 |
| 官方是否声明有上架案例 | **未找到**任何「已上架 App Store / Google Play」的官方声明或案例列表 |
| 第三方上架案例 | **未找到**可用于交叉验证的案例 |
| 商店侧证据（应用描述含 Wails / Go） | **未检索到** |

> 结论：**「Wails v3 移动端是否已有真实商业应用通过 App Store / Google Play 审核」= 未验证**。作为对照，Tauri 有 Readest（App Store id6738622779 / Google Play `com.bilingify.readest`）这一可验证的双商店生产案例。
>
> **这是选择 Wails 移动端时最大的信息缺口**：打包链路文档齐全 ≠ 审核路径已被验证。App Store 对 WebView 型应用的审核（尤其 2.5.2「不得下载 / 执行代码」、4.7 第三方内容）在实践中反复出现争议，而 Wails 侧缺少可参照的过审先例。

### 2.6 移动端 API 面与插件现状

| 项目 | 事实 |
|---|---|
| 官方移动 API 面 | `application.Android` / `application.IOS` 命名空间（Haptics、Device、Toast、Notifications、Biometrics、Secure storage、Geolocation、加速度计、距离传感器、TTS、屏幕亮度、手电筒等） |
| 通信机制 | 「Wails wires up the message bridge automatically」——**进程内桥**，非 localhost |
| 生态规模 | 未见与 Tauri `tauri-plugin-*` 对等的第三方移动插件目录；移动能力主要由**框架内置**提供（`v3/examples/mobile` 演示了较大的 API 面） |
| 与 Tauri 的差异 | Tauri 移动端明确「**not all of the official plugins are supported**」，但**存在**插件生态与第三方生产案例；Wails 移动端是内置 API 面 + 实验性状态 |

> 来源：`guides/mobile/index.md`（证据日期 2026-11-02）。
> **注**：本文**未**系统枚举 `application.Android` / `application.IOS` 的完整 API 清单，因此「移动端 API 覆盖度」这项的完整性**未验证**（可见范围仅限官方 Kitchen Sink 的 7 个标签页）。

---

## 3. Server 构建模式（对「网页版」最关键）

### 3.1 它是什么、怎么开

官方原文（`guides/server-build.md`）：

> "Wails v3 supports server mode, allowing you to run your application as a pure HTTP server **without creating native windows or requiring GUI dependencies**. This enables deploying the same Wails application to servers, containers, and web browsers."

| 项目 | 事实 |
|---|---|
| 开关 | `server` 构建标签：`go build -tags server -o myapp-server .` |
| Taskfile | `wails3 task build:server` / `wails3 task run:server` |
| 配置对象 | `application.ServerOptions`（`Host`、`Port`、`ReadTimeout`、`WriteTimeout`、`IdleTimeout`、`ShutdownTimeout`、`WebSocketOriginPatterns`、`WebSocketAllowAllOrigins`、`TLS`） |
| 默认监听 | `localhost:8080`（`Host` 默认 `"localhost"`，`Port` 默认 `8080`） |
| 环境变量覆盖 | `WAILS_SERVER_HOST`、`WAILS_SERVER_PORT`（**优先于代码中的 `ServerOptions`**） |
| 健康检查 | 自动提供 `GET /health` → `{"status":"ok"}`（适用于 K8s 存活/就绪探针、LB 健康检查） |
| 容器化 | 项目自带 `Dockerfile.server`（基于 **distroless** 的最小镜像）；`wails3 task build:docker` / `run:docker`；`docker-compose` 示例含 healthcheck |
| 优雅关闭 | 处理 `SIGINT` / `SIGTERM`：停止接受新连接 → 等待进行中的请求（至 `ShutdownTimeout`）→ 运行 `OnShutdown` 钩子 → **逆序**关闭 services |
| 编译目标 | "Server mode is pure Go and compiles for **every `GOOS` Wails supports, including `android` and `ios`, without CGO**" |
| 移动目标的 server 构建 | 只构建**无头服务**：`application.Android` / `application.IOS` **不可用**，用到它们的代码必须用 `!server` 构建约束排除；默认 logger 是桌面 logger（写 stderr）而非 logcat / WebView console |

### 3.2 Server 模式 vs 桌面模式（官方对照表，原文照录）

| 能力 | 桌面模式 | Server 模式 |
|---|---|---|
| 原生窗口 | 创建 | 浏览器窗口（`browser-N`） |
| 系统托盘 | 可用 | **不可用** |
| 原生对话框 | 可用 | **不可用** |
| 应用菜单 | 可用 | **不可用** |
| 屏幕信息 | 可用 | 无原生屏幕；`GetPrimary()` 返回 `nil` |
| Service bindings | 可用 | **可用** |
| Events | 可用 | **可用**（经 WebSocket） |
| 资源 | 经 webview | 经 HTTP |
| **CGO 要求** | **需要** | **不需要** |

**窗口 API 在 server 模式的行为**（官方原文要点）：

- `app.Window.NewWithOptions(options)` 返回**非 nil** 的 Go window 对象，但**不会**创建原生桌面窗口。
- `app.Hide()` / `app.Show()` 为 no-op。
- `app.Screen.GetPrimary()` 在没有主屏幕时返回 `nil`，**使用前必须判空**。
- 官方警告："a non-nil Go window object does **not** establish that a native window or screen exists."

> **对阅读器的含义**：`app.Screen.GetPrimary()` 这类 API 在 server 模式返回 `nil` → **所有涉及窗口 / 屏幕的代码在 Web 模式下都必须有 Vue 端的替代实现**（例如用 CSS 视口单位与 `ResizeObserver` 代替原生屏幕度量）。

### 3.3 「同一 main.go 同时产出桌面 / 移动 / Web」成立到什么程度

| 层 | 共享程度 | 依据 |
|---|---|---|
| Go service / 业务逻辑 | ✅ **完全共享** | 官方：「Your application code remains the same - you just build with the tag」 |
| 前端（HTML / JS / CSS / Vue） | ✅ **完全共享** | 官方：「The frontend can call these bindings using the standard Wails runtime」 |
| Service bindings | ✅ 三端一致 | server-build.md：「All service bindings work identically to desktop mode」 |
| Events | ✅ 三端一致（Web 走 WebSocket） | 同上 |
| **窗口 / 托盘 / 菜单 / 对话框** | ⚠️ **仅桌面** | server 不可用；移动端为 no-op 或仅首窗 |
| **屏幕 / 显示器信息** | ⚠️ 仅桌面可用 | server 返回 `nil` |
| **`application.Android` / `.IOS`** | ⚠️ 仅移动原生构建 | server 构建中不存在，需 `!server` 约束 |
| 多窗口对照阅读 | ⚠️ 仅桌面 | 移动端仅第一个窗口 |

> **结论**：**「共享 Go 业务层 + 共享 Vue 前端」成立**；**「共享一切 UI 能力」不成立**。必须引入一个**平台能力抽象层**（类似 Readest 的 `AppService` 三实现：native / web / node），把「窗口、托盘、屏幕、文件对话框、原生 TTS」等差异收敛到少数 adapter 里，其余代码只依赖接口。

### 3.4 Server 模式的限制与「多用户」缺口

| 限制 / 缺口 | 事实与原文 |
|---|---|
| **无用户 / 会话模型** | Server 模式把**每个浏览器标签页**建模为一个「窗口」，命名为 `browser-1`、`browser-2`…，经 `event.Sender` 区分。**没有**账号、会话、租户概念 |
| **绑定无鉴权** | 见 6.4：`/wails/runtime` 只校验 `Origin` / `Sec-Fetch-Site`（外加 loopback Host 检查），**没有 token、没有鉴权、没有授权** |
| **非同源前端不被支持** | 官方原文：「Frontends served from a different origin that call `/wails/runtime` directly are **not supported**: the endpoint emits no CORS headers and answers preflight `OPTIONS` requests with HTTP 405. Serve the frontend from the Wails server, or put both behind the same proxy origin」 |
| **反向代理需配置** | 若代理改写 `Host`，必须把公网 origin 加入 `WebSocketOriginPatterns`，否则 403 |
| **请求体上限** | `/wails/runtime` 请求在 JSON 处理前限制为 **64 MiB**；普通超限请求返回 **HTTP 413**（含无 `Content-Length` 的请求）；分块上传另有 **1 MiB/块** 与 **64 MiB/整包** 限制。官方建议用应用中间件或反向代理设更低的限制 |
| **静态资源** | 由 Wails 的 asset server 提供（`AssetFileServerFS` + `embed.FS`） |
| **多用户结论** | **Wails server 模式是「单租户」的**。要支持多用户，鉴权 / 会话 / 配额 / 数据隔离**必须在 Wails 之外自建**（自研中间件或前置反向代理 + 自己的 API 层） |

> **⚠️ 对「网页版」的重要判断**：如果我们的 Web 版需要**多用户 + 权限 + 配额**，那么把 Wails server 模式直接暴露给公网是**不安全的**。合理做法是：
> **方案 A**：Web 版走**独立的自研 HTTP API**（不暴露 `/wails/runtime`），Wails server 模式只用于**单用户自托管**场景；
> **方案 B**：Wails server 模式**仅监听 loopback**，前面放自己的反向代理做鉴权与限流，并把 `/wails/runtime` 路径**限制在已认证会话内**（需自定义中间件）。

---

## 4. 绑定与服务模型

### 4.1 services / bindings 的组织方式（官方原文要点）

| 规则 | 事实 |
|---|---|
| 绑定范围 | **只有导出方法（PascalCase）被绑定** |
| 实例语义 | **Services 是单例（singleton）**，且**跨所有窗口共享** |
| 并发 | 官方原文强调："**Services are shared across all windows. Always use mutexes for thread safety.**" |
| 返回值 | 方法可返回 `(value, error)` |
| 注册 | `application.NewService(...)` 放进 `application.Options.Services` 切片 |
| 依赖注入 | 构造器可接收依赖（如 `*sql.DB`、`*slog.Logger`），在 `NewService` 时注入 |
| 生命周期钩子 | `ServiceStartup(ctx, options) error` / `ServiceShutdown() error` |
| 启动顺序 | **按注册顺序启动**；`ServiceStartup` 返回 error 会**阻止应用启动** |
| 关闭顺序 | **逆序关闭**；此时应用 context 已取消；`ServiceShutdown` 返回 error 只**记录警告**，不阻止关闭 |
| HTTP 路由 | Services **可以**提供 HTTP 路由（发布说明原文："Services … can serve HTTP routes"） |

### 4.2 生成的 TypeScript / JS 绑定

| 项目 | 事实 |
|---|---|
| 命令 | `wails3 generate bindings` |
| 实现方式 | **静态分析** Go 源码（发布说明原文：「reads your Go source, so doc comments and real parameter names carry through」）——不是运行时反射 |
| 产物位置 | `./bindings/<pkg>/<Service>`（官方示例：`import { Greet } from './bindings/changeme/GreetService';`） |
| 类型映射 | Go struct → TS class 或 interface；Go enum → TS enum |
| 前端调用形式 | 生成函数式 API（`await Greet("World")`）；动态调用可用 `wails.Call.ByName('main.GreetService.Greet', 'World')` |
| **对 Vue 的意义** | 生成物是**框架无关的 TS**，Vue 3 可直接 `import` 使用；建议再包一层 composable（如 `useGreet()`）以统一 loading / error / 重试语义 |

### 4.3 streams、raw messages 与 events

| 机制 | 用途 | 证据 |
|---|---|---|
| Streams | Go ⇄ 前端流式数据 | 发布说明 "Streams and raw messages"；`guides/streams.md`、`guides/streams-from-websockets.md` |
| Raw messages | 需要完全控制时的原始消息通道 | 同上 |
| Custom transport | 自定义 IPC 传输 | `guides/custom-transport.md` |
| Events | 应用级 / 窗口级 / 自定义事件，**带类型化负载**，Go 与 JS 双向可用，另有平台系统事件 | 发布说明 Events 段；`guides/events-reference.md` |
| Server 模式的 Events | 前端发出的事件经 HTTP 到 Go；Go 发出的事件经 **WebSocket 广播到所有已连接浏览器** | `guides/server-build.md` |
| 事件发送者识别 | `event.Sender` 形如 `browser-1` / `browser-2` | 同上 |
| 广播风险 | Go 侧 `app.Event.Emit(...)` 是**广播到所有连接**——多用户场景下会造成**跨用户数据泄漏**，必须按 `Sender` 定向发送 | 官方示例仅展示广播用法；**定向发送 API 的具体形式未验证** |

### 4.4 窗口级权限（per-window permission map）

v3.0.0 发布说明列出的能力（原文）：

> 「a per-window **permissions** map for the camera, microphone, geolocation and notifications」

| 判断 | 说明 |
|---|---|
| 这是**WebView 能力授权**（摄像头 / 麦克风 / 定位 / 通知） | **不是**绑定方法的访问控制 |
| 是否可用于「frame 不能调用绑定」 | **不能**。这是两件事。见 6.5 |
| 对阅读器 | 用处有限（阅读器一般不申请摄像头/麦克风；定位可选） |

### 4.5 大型应用的目录结构建议（基于官方模型的推导）

> 以下为**设计建议**，非官方文档内容。依据是 4.1–4.3 的官方规则与「三端共享」约束。

| 目录 | 职责 | 要点 |
|---|---|---|
| `main.go` | 组装：创建 `application.New`、注册 services、按平台选择选项 | 保持极薄，只做装配 |
| `internal/services/<domain>/` | 每个业务域一个 service（`library`、`sync`、`reader`、`ai`、`settings`） | 每个 service 自带 mutex；**不要**跨 service 共享可变状态 |
| `internal/platform/` | 平台能力 adapter 接口 | 如 `Tray`、`ScreenInfo`、`FileDialog`、`NativeTTS`、`SecureStore`；桌面 / 移动 / server 三实现 |
| `internal/platform/platform_desktop.go` | `//go:build !server && !android && !ios` | 桌面实现 |
| `internal/platform/platform_mobile.go` | `//go:build android || ios` | 移动实现 |
| `internal/platform/platform_server.go` | `//go:build server` | Web 实现（多数为降级 / no-op） |
| `bindings/` | **生成物**（`wails3 generate bindings`） | **必须 gitignore 或明确标记为生成**；不要手改 |
| `frontend/` | Vue 3 + Vite | 内含 `src/platform/` 做前端侧能力探测（`System.IsMobile()` 等） |
| `frontend/src/services/` | 包装生成绑定的 composable 层 | 统一错误处理、loading、重试、离线降级 |
| `build/` | Taskfile 与打包配置 | 官方 Taskfile 机制，可读可改 |

> **关键纪律**：因为 service 是**全局单例且跨窗口共享**，**任何"当前用户 / 当前书籍 / 当前会话"状态都不能放在 service 字段里**（多用户 Web 场景下会串号）。必须由前端在每次调用时显式传参，或用 `event.Sender` / 会话标识做服务端侧隔离。**这是 Wails 绑定模型对多用户应用最重要的约束。**

---

## 5. 本地数据库

### 5.1 官方是否有 DB 能力或插件 —— **没有**

| 核查项 | 结果 |
|---|---|
| 官方 features 目录 | `autostart, bindings, browser, clipboard, dialogs, drag-and-drop, environment, events, index, keyboard, menus, notifications, platform, screens, windows` → **无 database / sqlite 项** |
| 官方 guides 目录 | 无 database 专题（`guides/` 下为 `mobile`、`build`、`dev`、`distribution`、`advanced`、`patterns` 等） |
| 官方文档中的 DB 用法 | `features/bindings/services.md` 的示例**直接使用** `sql.Open("sqlite3", "app.db")` ——驱动名 `sqlite3` 即 **mattn/go-sqlite3（需要 cgo）** |
| 结论 | **Wails 不提供数据库抽象、不提供迁移工具、不提供官方 DB 插件**；数据库完全由开发者自选 |

> 来源：`docs/mpress/content/features/` 与 `docs/mpress/content/guides/` 目录列表、`features/bindings/services.md`（证据日期 2026-11-02）。

### 5.2 SQLite 驱动选择（阅读器场景）

| 维度 | `modernc.org/sqlite`（纯 Go） | `mattn/go-sqlite3`（cgo） |
|---|---|---|
| cgo | **不需要** | **需要** |
| 交叉编译 | 简单（`GOOS/GOARCH` 直接编译） | 需各平台 C 交叉工具链 |
| Android | 与 NDK 工具链配合更简单 | 需 NDK 交叉编译配置 |
| Server / Docker | 可静态链接进 distroless 镜像 | 需 CGO_ENABLED=1 + glibc/musl 兼容处理 |
| 与官方示例一致性 | 需改驱动名与 import | **与官方示例一致**（`sql.Open("sqlite3", ...)`） |
| 性能 | 一般略低于 cgo 版本（**未实测**） | 通常更快（**未实测**） |
| 扩展 / 特性 | 部分 SQLite 扩展不支持（**未逐一验证**） | 支持面广 |
| 官方推荐 | **官方未表态** | **官方示例用它** |

> **⚠️ 本文未实测两者性能差异，亦未验证 `modernc.org/sqlite` 对 Wails 全部目标平台（尤其 Android / iOS）的可编译性**。此处仅给出结构性权衡。
> **推荐方向（基于上述结构）**：若坚持「一套代码 + 桌面 / 移动 / Web + Docker」且要避免 cgo，**优先纯 Go 方案**（`modernc.org/sqlite`）；代价是与官方示例不一致、需自行验证各平台。这与 Wails server 模式「CGO 不需要」的定位更契合。

### 5.3 对交叉编译与移动端的影响

| 场景 | cgo（`mattn`） | 纯 Go（`modernc`） |
|---|---|---|
| 桌面 → Windows / macOS / Linux 三平台交叉编译 | 需各自工具链，**最麻烦** | 直接交叉编译 |
| Android（经 NDK，`libwails.so`） | 额外配置 NDK 交叉编译 SQLite | 随 Go 一起编译，**更简单** |
| iOS（`GOOS=ios`，需 macOS） | 额外配置 | 随 Go 一起编译 |
| Server / distroless 镜像 | 需 CGO_ENABLED=1 且静态链接处理 | 天然静态 |
| **结论** | 与「一份代码出六端」的目标**冲突** | 与目标**一致** |

---

## 6. 安全模型（必须精确）

### 6.1 v3.0.0 发布说明 Security 段（官方原文逐条摘录）

> "## Security
> This release **fixes every published Wails v3 security advisory except one: GHSA-2p5f-2gx8-mh8m is only partly fixed.** Cross-origin child frames on Linux are now blocked, and the cases that remain open are listed under *Known limitations* below. If you are on `v3.0.0-beta.30` or earlier, please upgrade."

**已修复项（原文）**

| 条目 | 内容 |
|---|---|
| Linux 子 frame 守卫 | "Block reserved `wails:` messages from **cross-origin child frames on Linux** (GTK3 and GTK4) by injecting a **guard script into all frames**, mitigating **GHSA-2p5f-2gx8-mh8m**" |
| Go 依赖 | "Update `github.com/klauspost/compress` to 1.18.7 (**GHSA-259r-337f-4rfw**) and `golang.org/x/image` to 0.45.0, and build with Go 1.26.10 to pick up the `crypto/x509` fix (**GO-2026-6809**)" |
| 前端依赖 | "Update `vite` to 8.2.4 or later in the runtime package, setup wizard, examples and project templates"（**GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22, GHSA-vfpm-58rq-9qcg, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv**，共 6 条） |

**Known limitations（原文照录，这是最关键的段落）**

| # | 平台 | 原文 | 工程含义 |
|---|---|---|---|
| L1 | **Linux** | "the child-frame guard **cannot stop a *same-origin* child frame** (for example a `srcdoc` or `about:blank` iframe) from reaching the native message handler through its parent, because **WebKitGTK gives the handler no frame information**. Cross-origin frames, and sandboxed frames without `allow-same-origin`, are blocked. **Do not embed untrusted same-origin content in a Wails window.**" | 同源 iframe 是**结构性缺口**（受 WebKitGTK API 限制），非实现疏忽 |
| L2 | **Android（实验性）** | "the `window.wails` JavaScript bridge is **exposed to every frame** in the WebView. **Do not embed untrusted third-party content in the app's WebView. A fix is planned for 3.0.1.**" | 移动端主动承认的隔离缺陷；**承诺的修复未以 3.0.1 落地**（见 6.2） |
| L3 | **所有平台** | "bound-method calls from child frames **go over HTTP to `/wails/runtime`, so the guard does not restrict them**. **Treat any iframe you embed as having access to your bound Go methods.**" | **这条最致命**：无论桌面还是移动、无论 frame 是否跨源，**只要页面里嵌了 iframe，就应该假设它能调用我们全部导出的 Go 方法** |

> 来源：[Wails v3.0.0 发布说明 · Security](https://github.com/wailsapp/wails/releases/tag/v3.0.0)（证据日期 2026-11-02 抓取；发布日 2026-10-26）。

### 6.2 修复状态核实（任务书核心问题）

| 任务书问题 | 核实结果 | 证据 |
|---|---|---|
| 3.0.1 是否已修复？ | **v3.0.1 不存在**（tag 与 Release 均无） | tags / releases API |
| 3.1.x 是否已修复？ | **在 v3.1.0 发布说明中找不到任何相关条目**（无 frame / origin / bridge / guard / advisory / GHSA 关键词） | v3.1.0 release body（15,473 字符，逐行检索） |
| nightly 是否已修复？ | v3.2.0-nightly.20261101（1,114 字符）同样**无相关条目** | nightly release body |
| 「3.0.1 修复 Android bridge」的说法从何而来？ | **来自 v3.0.0 发布说明自己的承诺**（L2 原文"planned for 3.0.1"），并被第三方报道列为待办事项 | v3.0.0 说明 + 第三方报道 |

**⚠️ 结论的准确表述**：**「未验证到修复」**，而非「确定未修复」。

理由：v3.1.0 的变更清单由 PR 标题自动生成；标题不含 frame / origin 关键词的修复不会被列出。本文**未**逐一审查 `/wails/runtime` 与 Android bridge 的实现代码或全部 PR，因此不能排除「修复已合并但未在说明中体现」。**架构决策前必须在各目标平台做运行时验证**（见第 11 节 M0 项）。

**⚠️ 顺带发现的文档问题**：仓库 `SECURITY.md`（经第三方镜像抓取）的「Supported Versions」表仍写着 **`2.x.x ✅ / 3.0.x-alpha ❌**——**没有列出 v3.0.0 / v3.1.0 稳定版**。这与 v3 已 GA 的事实不一致，属于**安全政策文档滞后**。（本文未从 GitHub 原始 SECURITY.md 直接取证，此项标记为**未验证**。）

### 6.3 `/wails/runtime` 的校验机制（官方原文，server 模式）

> "### Runtime request origin
> `/wails/runtime` accepts only `POST` requests; other methods receive **HTTP 405**. A browser request whose `Origin` is neither the request host nor a match for `WebSocketOriginPatterns` receives **HTTP 403**, as does one without `Origin` whose `Sec-Fetch-Site` is `cross-site` or `same-site`. **Requests carrying neither header, such as those from `curl` or other non-browser clients, are accepted.** If a reverse proxy rewrites the `Host` header, add the public origin to `WebSocketOriginPatterns`."

> "`WebSocketOriginPatterns` exists for reverse-proxy deployments… **Frontends served from a different origin that call `/wails/runtime` directly are not supported: the endpoint emits no CORS headers and answers preflight `OPTIONS` requests with HTTP 405.** Serve the frontend from the Wails server, or put both behind the same proxy origin."

> "### Loopback Host check
> When the server binds a loopback address (the default `localhost`, any `127.0.0.0/8` address, or `::1`…), every request must carry a `Host` header naming `localhost`, an IP literal, the bind host, or a host matching the host part of a `WebSocketOriginPatterns` entry; any other `Host` receives **HTTP 403**. This stops **DNS rebinding**… The port is not compared, and spellings such as `localhost.` (trailing dot) or `127.1` are rejected. **The check still applies when `WebSocketAllowAllOrigins` is set.** If a local reverse proxy forwards its public `Host`, add that host to `WebSocketOriginPatterns`. Binds to other addresses, such as `0.0.0.0` in containers, are not affected."

> 来源：`guides/server-build.md`（master，证据日期 2026-11-02）。

**机制归纳表**

| 机制 | 校验对象 | 触发条件 | 响应 |
|---|---|---|---|
| HTTP 方法白名单 | 方法 | 非 `POST` | **405** |
| Origin 校验 | `Origin` 头 | `Origin` 既非请求 host 也不匹配 `WebSocketOriginPatterns` | **403** |
| Sec-Fetch-Site 校验 | `Sec-Fetch-Site` 头 | **无 `Origin`** 且 `Sec-Fetch-Site` 为 `cross-site` / `same-site` | **403** |
| **无头请求放行** | — | **既无 `Origin` 也无 `Sec-Fetch-Site`**（如 `curl`、非浏览器客户端） | **放行** ⚠️ |
| Loopback Host 校验 | `Host` 头 | 绑定 loopback 时 `Host` 不是 localhost / IP 字面量 / bind host / 模式匹配 | **403** |
| CORS | — | 任何跨源直连 | **不发 CORS 头**，预检 `OPTIONS` → **405** |
| 禁用开关 | — | `WebSocketAllowAllOrigins: true`（官方标注 "**Unsafe**"） | 关闭 Origin 检查（但仍受 loopback Host 检查保护） |
| 请求体上限 | 大小 | `/wails/runtime` > **64 MiB** | **413**（分块另有 1 MiB/块、64 MiB/整包） |

### 6.4 是否有 token / 鉴权？—— **没有**

| 问题 | 答案 | 依据 |
|---|---|---|
| `/wails/runtime` 是否要求 token / API Key / CSRF token？ | **没有任何 token 机制**（文档未提及，`ServerOptions` 中也没有对应字段） | `guides/server-build.md` 全文无 token / auth 相关配置项 |
| 是否做**鉴权（authentication）**？ | **否**。只做**来源合法性**判断（Origin / Sec-Fetch-Site / Host） | 同上 |
| 是否做**授权（authorization）**？ | **否**。没有 per-method / per-user 的授权模型 | 同上 |
| `Referer` 是否参与校验？ | **文档未提及** `Referer`；校验依据是 `Origin` 与 `Sec-Fetch-Site` | 同上 |
| 非浏览器客户端（无 Origin 头）能否调用绑定？ | **能**。原文：「Requests carrying neither header, such as those from `curl` or other non-browser clients, are accepted」 | 同上 |
| 多用户隔离？ | **不提供**。`browser-N` 只是标签页标识，不是身份 | 同上 |

> **🔴 这是全篇最重要的安全结论之一**：
> **「Origin 校验 ≠ 认证」**。任何能发 HTTP 请求、且不携带 `Origin` / `Sec-Fetch-Site` 的本地或网络进程（`curl`、脚本、其它 App），**都能调用我们全部导出的 Go 方法**。
> 因此：**若把 Wails server 模式直接暴露到公网或非受信网络，等于把全部后端能力以无认证接口对外提供。** 必须外加鉴权层（第 11 节 A1）。

### 6.5 官方是否提供 per-frame / per-window 隔离手段？

| 手段 | 是否可用于隔离 frame 的绑定调用 | 证据 |
|---|---|---|
| per-window **permissions** map（摄像头 / 麦克风 / 定位 / 通知） | ❌ **不能**。这是 WebView 能力授权，与绑定访问控制无关 | v3.0.0 发布说明 |
| Linux **guard script**（注入到所有 frame） | ⚠️ **部分**：只挡 `wails:` 保留消息，**且挡不住同源子 frame** | v3.0.0 L1 |
| 跨源 frame 阻断 | ✅ 在 **Linux** 上已阻断跨源子 frame；**其它平台未在说明中承诺** | v3.0.0 说明 |
| Android `window.wails` 隔离 | ❌ **未实现**（暴露给所有 frame；修复未验证） | v3.0.0 L2 |
| 绑定调用的 frame 级限制 | ❌ **不存在**。L3 明确「守卫不限制」它们 | v3.0.0 L3 |
| CSP 配置项（等价 Tauri 的 `tauri.conf.json` CSP） | **未验证**。Wails 文档中**未找到**与 Tauri 对等的「在应用配置中声明 CSP」的官方机制 | 文档检索结果 |
| Capability / permission 授权模型（等价 Tauri capabilities） | **未找到**。仅有 per-window 的 WebView 能力 map | 文档检索结果 |

> **结论**：**Wails v3.0.0/3.1.0 没有提供「让 iframe 无法调用绑定」的官方机制。** 官方给出的应对方式是**开发纪律**（"Do not embed untrusted content"），而不是**框架级隔离**。
> **对照 Tauri v2**：Tauri 有 `tauri.conf.json` 中的 **CSP 配置项**与 **capabilities / permissions 授权模型**（Readest 即用 `capabilities: ["default", "desktop-capability"]` 并按窗口授权）。这是 Wails 方案下一个必须**自行补齐**的能力缺口。
> **⚠️ 限制**：本文**未**穷尽检索 Wails 全部文档与源码来确认「确实不存在 CPS 配置项」，因此该条为「**未找到**」而非「确定不存在」。

### 6.6 官方安全文档的实际覆盖范围

仓库内 `guides/security.md`（标题 "Security Best Practices"）的**实际内容**（证据日期 2026-11-02）：

| 涵盖主题 | 内容要点 |
|---|---|
| 输入校验 | 校验邮箱 / 密码强度，`html.EscapeString` 转义 |
| 认证 | `golang.org/x/crypto/bcrypt` 哈希密码；会话 token |
| 数据保护 | AES-GCM（`cipher.NewGCMWithRandomNonce`，自动生成并前缀 nonce）；`go-keyring` 存敏感数据 |
| 网络 | 强制 HTTPS、校验证书、`MinVersion: tls.VersionTLS12`、限制重定向次数 |
| **文件操作** | 用 `os.OpenRoot(dir)` 把文件系统解析限制在目录内（**含符号链接**）；原文明确指出：「Rejecting `..` or checking a string prefix alone **does not** provide this boundary」；且「do not let the frontend supply the allowed root」 |
| 速率限制 | 提供了示例实现 |
| 清单 | 10 项 checklist（输入校验 / bcrypt / 加密 / HTTPS / 限流 / 路径校验 / 依赖更新 / 日志 / 错误信息不泄密 / 代码审计） |

**❌ 官方安全指南中完全缺失的主题**（与本项目直接相关）：

| 缺失主题 | 为什么对本项目重要 |
|---|---|
| **不可信内容 / iframe 隔离** | 阅读器的核心场景就是渲染不可信 EPUB |
| **绑定方法的访问控制** | 我们的 LLM、文件、同步能力都在绑定后面 |
| **CSP 配置指引** | 与 foliate-js 官方「必须用 CSP 阻止所有脚本」的要求直接冲突 |
| **多用户 / 会话隔离**（server 模式） | 我们需要多用户 Web 版 |
| **CSRF** | `/wails/runtime` 是无 token 的 POST 端点 |

> **判定**：`guides/security.md` 是一份**通用 Web 应用安全速查**，**不是**针对「Wails 应用内嵌不可信内容」的威胁模型文档。阅读器项目**不能依赖它**来设计 EPUB 隔离。

---

## 7. WebView 碎片化

### 7.1 各平台 WebView 与系统要求（官方 FAQ 原文，2026-11-01）

| 平台 | WebView / 技术栈 | 最低要求（官方） |
|---|---|---|
| **Windows** | **WebView2（Chromium）** | AMD64 和 ARM64。使用 WebView2 运行时 |
| **macOS** | **WebKit（WKWebView）** | Intel：**10.15 或更高**（应用可目标 10.13 或更高）；Apple Silicon：**11.0 或更高**。支持通用二进制 |
| **Linux** | **GTK4 + WebKitGTK 6.0**（默认） | AMD64 和 ARM64。默认栈需 **Ubuntu 24.04+ / Debian 13+ / Fedora 40+** 及类似发行版 |
| **Linux（旧栈）** | WebKit2GTK **4.1**，经旧版 `-tags gtk3` 构建 | 仅提供 WebKit2GTK 4.1 的发行版（**Ubuntu 22.04 / Debian 12 / RHEL 9**）可用；**支持截至 v3.1** |
| **Linux（不支持）** | WebKit2GTK **4.0** | **不受支持** |
| **iOS** | **WKWebView** | **实验性支持** |
| **Android** | **系统 Android WebView** | **实验性支持** |
| **Server** | 无 WebView（浏览器访问） | 亦可「将应用程序作为普通 Web 应用提供」 |

> 来源：[Wails FAQ](https://v3.wails.io/zh-cn/faq/)（证据日期 2026-11-01）、`guides/mobile/*`（证据日期 2026-11-02）。
> 官方另称最终产物「通常只需一个约 **10MB** 的二进制文件」——**属官方宣传口径，本文未实测**。

### 7.2 已知兼容问题与风险

| 风险 | 事实 | 影响 |
|---|---|---|
| **Windows 7/8 不支持** | 依赖 WebView2（Windows 10/11 已预装） | 与 Tauri 2.12 弃用 Win7 一致，影响有限 |
| **Linux 发行版碎片化（最严重）** | 默认需 GTK4 + WebKitGTK 6.0（Ubuntu 24.04+）；旧发行版需 `-tags gtk3`（**支持截至 v3.1**）；WebKit2GTK 4.0 发行版直接不支持 | 中文 Linux 用户中 Ubuntu 22.04 / Debian 12 占比高，**需要额外提供 gtk3 构建或引导升级** |
| **GTK3 退场时间点未在 v3.1.0 说明中体现** | FAQ 称 gtk3「支持截至 v3.1」，但 **v3.1.0 的发布说明中没有 GTK3 移除条目** | **文档与实现可能不同步 → 未验证**；若 gtk3 构建在 v3.1 后消失，Ubuntu 22.04 用户受影响 |
| **五个平台 = 五种 WebView 引擎** | WebView2 / WKWebView（macOS）/ WebKitGTK 6.0（Linux）/ 系统 WebView（Android）/ WKWebView（iOS） | **同一本 EPUB 在不同平台断行 / 分页 / 字体可能不同** → 进度与标注定位必须用「Locator + 文本上下文」双保险（承接 task-1 的 4.3 节结论） |
| **Android 系统 WebView 版本碎片化** | Wails 使用系统 WebView，**未提供** WebView 升级 / 降级机制；未见等价 `tauri-plugin-webview-upgrade` 的方案 | ⚠️ **高风险**：Tauri 生态已实测「WebView 83–99 设备（华为、无 Play 的 AOSP、**Onyx Boox 等 e-ink 阅读器**）会渲染成白屏」。**Wails 侧无对应缓解工具，必须自研** |
| **v3.1.0 新增 CGO-free 后端** | "add experimental **CGO-free macOS and Linux backends**"（PR #6521） | 说明 Linux/macOS 后端**仍在重构**，可能引入新兼容问题 |
| **移动端整体** | 官方标注实验性、不受稳定性承诺覆盖 | 移动端渲染问题优先级与修复时效无保证 |

### 7.3 Android WebView 升级方案（Wails 无对应物）

| 对比项 | Tauri 生态 | Wails v3 |
|---|---|---|
| 官方 / 社区 WebView 升级插件 | ✅ `readest/tauri-plugin-webview-upgrade`（Kotlin）：把 in-process WebView loader 重定向到侧载的 `com.google.android.webview`；README 明确列出受影响设备（华为 `com.huawei.webview`、Rockchip / Moaan / Onyx / Boox 上 `com.android.webview` 83–99、无 Play 的 AOSP） | ❌ **未找到等价方案** |
| 受影响设备识别 | 插件内置判断逻辑 | 需自研（读取 `WebView.getCurrentWebViewPackage()` 等） |
| 本项目可采取的措施 | — | ① 启动时探测 WebView 版本，过旧则给用户引导（升级系统 WebView / 安装 Android System WebView）；② 对 e-ink 设备降级为更保守的渲染路径；③ 必要时自写 Kotlin 插件（参考上述开源实现的设计） |

> **⚠️ 未验证**：Wails Android 在老旧系统 WebView（Chromium 83–99）上的实际表现**未实测**，也未找到 Wails 社区的对应 issue。但**结构性风险是确定的**——Wails 与 Tauri 用同一种「系统 WebView」模型，而 Tauri 侧已被实测证伪。

---

## 8. 许可与商业化

| 项目 | 事实 | 证据 |
|---|---|---|
| Wails 主仓库许可 | **MIT**（`license.spdx_id = "MIT"`） | [GitHub API](https://api.github.com/repos/wailsapp/wails)（2026-11-02） |
| `@wailsio/runtime` 许可 | **MIT** | [npm registry](https://registry.npmjs.org/@wailsio/runtime)（2026-11-02） |
| 是否有附加条款（CLA / 商用限制 / SSPL 类条款） | **未发现**附加限制；MIT 条款下可闭源商用 | 上两项 |
| 与 Readest（AGPL-3.0）对比 | Wails 是 MIT，**没有 AGPL 传染风险** | — |
| 对比 Tauri | Tauri 为 Apache-2.0；两者均宽松，均可闭源商用 | task-1 结论 |

> **结论**：**许可层面无阻碍**。MIT 允许闭源商用、修改、再分发。唯一需注意的是**不得使用 Wails 商标**暗示官方背书（MIT 不含商标授权，这是通用常识而非本项目专用限制；本文**未**核对其商标政策原文）。

---

## 9. 迁移与维护成本

### 9.1 Taskfile 构建系统

| 项目 | 事实 |
|---|---|
| 官方定位 | 发布说明原文：「**A build system you can see.** Projects use a **Taskfile-based** build that you can read, extend and debug, **instead of one opaque command.**」 |
| 载体 | 项目模板中的 `build/Taskfile.yml`（`wails3 dev` 会运行其中定义的任务，如前端 dev server） |
| 优点 | 构建过程**可读可改**，不藏在框架内部；对「需要自定义打包 / 签名 / 多商店产物」的阅读器项目是**实际优势**（对比 Tauri 的 CI 封装更透明） |
| 代价 | 需要团队理解并维护 Taskfile；升级 Wails 时模板可能变动，需手工合并 |

### 9.2 日常工作流

| 命令 | 用途 |
|---|---|
| `wails3 doctor` | 检查系统与工具链，给出各平台缺失项与安装说明（**每次环境问题第一个该跑的**） |
| `wails3 setup` | 引导式安装：检查系统并安装 Wails 所需内容（GA 新增） |
| `wails3 init` | 创建项目（支持 `-t` 模板、`-l` 列出模板） |
| `wails3 dev` | 开发模式（前端 dev server 热重载 + 原生窗口） |
| `wails3 generate bindings` | 静态分析 Go 源码生成 TS / JS 绑定 |
| `wails3 task <name>` | 运行 Taskfile 任务（`build:server`、`ios:package`、`android:bundle:fat`…） |

### 9.3 v3 周更节奏对生产项目的含义

| 维度 | 判断 | 依据 |
|---|---|---|
| 升级成本 | **中**。周更 minor 意味着长期需要**每周评估是否跟进**；官方建议钉死精确版本，说明官方也预期用户不会自动跟随 | nightly 说明「always pin an exact version」 |
| breaking policy | 桌面有**稳定性承诺**；移动端**不在承诺内** | FAQ + v3.0.0 说明 |
| 内部重构强度 | **高**。v3.1.0 含 20+ 条内部性能 / 分配优化 PR；v3.1.0 还引入了 "experimental CGO-free macOS and Linux backends" | v3.1.0 说明 |
| 对项目的建议 | ① 钉死 `wails3` 与 `@wailsio/runtime` 版本并在 CI 中显式指定；② 每 2–4 周**主动**评估一次升级（而非被动跟随）；③ 建立**升级回归清单**（打开 EPUB、翻页、TTS、同步、移动端启动）；④ 跟踪 `/wails/runtime` 与 Android bridge 相关 PR，作为安全升级的触发条件 | 综合 |
| 最大不确定性 | 移动端不在稳定性承诺内 → 任何 minor 都可能影响移动端 | FAQ |

### 9.4 迁移自 Tauri v2 的额外成本（本次决策变更的代价）

| 项 | 说明 |
|---|---|
| 前端重写 | React → Vue 3（DONE 级工作量：组件、状态、路由、i18n 全线重写） |
| 绑定层重写 | Tauri `invoke` + `tauri.conf.json` capabilities → Wails services + `generate bindings` |
| 安全模型重建 | Tauri 的 CSP 配置 + capability 授权 → **Wails 无对应物，必须自建**（第 11 节 A1–A4） |
| 移动端风险重新评估 | Tauri 移动端有 Readest 生产案例；Wails 移动端**无已知上架案例** |
| 生态库替换 | `tauri-plugin-*` → Wails 内置 API 或自研 |
| 正面收益 | ① Server 构建模式（Web 版一条命令）；② 后端 Go（若团队 Go 更强）；③ Taskfile 透明度；④ MIT 更宽松 |

---

## 10. 横向对比：Wails v3 vs Tauri v2（限定三约束）

约束：**① 阅读器场景 ② 需要渲染不可信 EPUB ③ 需要上移动端**。评分是研究员判断（1–5），非实测。

| 维度 | 权重 | Wails v3 | Tauri v2 | 依据 |
|---|---|---|---|---|
| **不可信内容隔离能力** | 20 | **1** | **3** | Wails 官方原文：「Treat any iframe you embed as having access to your bound Go methods」「Do not embed untrusted same-origin content」；无 CSP 配置项、无 capability 授权模型。Tauri 有 `tauri.conf.json` CSP 配置 + capabilities 授权 |
| **移动端成熟度** | 18 | **2** | **4** | Wails：官方标注**实验性**、不在稳定性承诺内、GA 仅 7 天、**无已知上架案例**。Tauri：2024-10-02 移动端稳定、Readest 双商店生产验证、官方自认 DX 未达桌面 |
| **移动端上架链路** | 10 | **4** | **4** | Wails：AAB / upload key / IPA / Xcode 归档指引齐全。Tauri：App Store / Google Play 分发指南 + Readest 实证 |
| **桌面稳定性** | 10 | **4** | **5** | Wails：v3.0.0 是桌面稳定版，但周更 + 内部高强度重构。Tauri：2.12.3（2026-10-10），节奏更缓、生产案例更多 |
| **Server / Web 部署** | 12 | **5** | **2** | Wails：`-tags server` 一等公民 + `/health` + Dockerfile.server（**真实优势**）。Tauri：无对应模式，Web 需另建 |
| **单代码库覆盖六端** | 10 | **4** | **5** | 两者都能共享前端；Wails 额外提供 server 目标，但移动端能力受限（仅首窗）与实验性削弱了「覆盖」的成色 |
| **Android WebView 碎片化应对** | 8 | **1** | **4** | Wails：无等价方案。Tauri：`tauri-plugin-webview-upgrade`（Readest 已实测量产） |
| **绑定 / 服务模型** | 6 | **4** | **4** | Wails：导出方法静态生成 TS、生命周期钩子、streams、raw messages（设计良好）。Tauri：commands + channels；两者可比 |
| **本地数据库生态** | 4 | **3** | **3** | 两者都无官方 DB；Wails 示例用 cgo 驱动，Tauri 侧有 `tauri-plugin-turso` 等先例（Readest） |
| **许可宽松度** | 2 | **5** | **5** | Wails MIT；Tauri Apache-2.0。均可闭源商用 |
| **后端语言契合** | — | Go | Rust | 取决于团队；本项目选择 Go（用户已拍板） |
| **加权总分（/5）** | 100 | **2.94** | **3.72** |

> **结论（坦率版）**：在「渲染不可信 EPUB + 上移动端」这两个最强约束下，**Tauri v2 的加权得分明显更高**，主要差距来自 **① 内容隔离模型（20 分权重，Wails 只有 1 分）** 与 **② 移动端成熟度（18 分权重，Wails 只有 2 分）**。Wails 的**唯一显著优势是 Server 构建模式**（12 分权重）。
>
> **但对决策的准确表述是**：Wails **不是不能做**，而是**必须在架构上额外补偿 5 类缺口**（第 11 节），并且**移动端需要一次专门的 Go/No-Go 验证**。如果用户已拍板 Wails（事实如此），本文的任务就是把补偿清单做实，而不是重新争论选型。

### 10.1 三约束下的具体取舍

| 约束 | Wails v3 的现实 | 必须的应对 |
|---|---|---|
| **渲染不可信 EPUB** | 框架**明确不提供**隔离；官方让我们「不要嵌不可信内容」——但阅读器**必须**渲染外部 EPUB | 第 11 节 A1–A4：自建隔离（独立 origin + 严格 CSP + 绑定访问控制 + 内容净化） |
| **上移动端** | 实验性、不在稳定性承诺内、无上架先例 | 第 11 节 A6–A7：M0 阶段做**移动端专项验证**（含老旧 WebView）；准备**降级路线**（详见下） |
| **阅读器功能** | 多窗口在移动端不可用；save/open-directory 对话框在移动端不可用 | 第 11 节 A5：单窗口内 pane 布局；文件导入走「打开文件」+ 沙盒写入 |

### 10.2 若移动端验证失败，降级路线（承接 task-1 备选 A）

| 方案 | 内容 | 代价 |
|---|---|---|
| **降级 A** | Web + 桌面走 **Wails v3**（含 server 模式出 Web）；**移动端改用原生**（Readium Swift / Kotlin toolkit） | 移动端渲染层单独实现；但 Locator 定位模型与后端协议无需改 |
| **降级 B** | 移动端改用 **Tauri v2**（与桌面 Wails 并存，共享后端 Go 服务 + 共享定位模型） | 两套壳；但移动端有 Readest 级别的可行性证据 |
| **降级 C** | 移动端**暂缓**，先交付 Web（Wails server）+ 桌面 | 与 OPEN-QUESTIONS Q6「Web → 桌面 → 移动」一致，风险最低 |

> **建议**：在 M0 就明确选择「降级 C 为默认路径」，把移动端做成**可选增量**而非关键路径。这样移动端实验性带来的风险不会阻塞整个项目。

---

## 11. 🔧 Wails 方案下必须额外做的架构补偿（可执行清单）

> 这是本文件对架构决策**最直接可用**的输出。每条标注：**为什么必须做（证据）** + **怎么做**。

### A. 内容安全隔离（最高优先级，对应第 6 节的 L3 与 6.4）

| # | 必须做的事 | 为什么（证据） | 怎么做 |
|---|---|---|---|
| **A1** | **为 EPUB 内容使用独立 origin / 自定义协议，绝不与应用主文档同源** | v3.0.0 L3：「bound-method calls from child frames go over HTTP to `/wails/runtime`, so the guard does not restrict them」；L1：同源子 frame 在 Linux 上无法被守卫阻止 | 桌面：自定义 scheme（如 `epub://<bookId>/…`）或独立 loopback 源；移动：注意 `wails://` 与 `WebViewAssetLoader` 是同源模型（**需验证能否分离**）。**跨源隔离是本方案的唯一结构性防线** |
| **A2** | **自建绑定访问控制层**：给每个会话 / 窗口签发 token，在所有 service 方法入口校验 | 6.4：`/wails/runtime` **无 token、无鉴权**；无 `Origin` 的请求（`curl`）**被放行** | 在 `ServiceStartup` 里生成 per-session 随机 token 并注入前端；实现一个 `authorize(ctx, token, method)` 守卫，**每个导出方法首行调用**；或用 Wails 中间件（`guides/gin-routing.md` / `middleware`）在 `/wails/runtime` 前拦截 |
| **A3** | **为书籍文档设置严格 CSP**：`script-src 'none'`、`default-src 'none'`、只放开图片 / 样式 / 字体 | foliate-js 官方要求：「you **must** use CSP to block all scripts except `'self'`」；Wails **未提供** CSP 配置项 → 必须在**响应头**层面自行注入 | 在 asset server / 自定义协议响应中注入 `Content-Security-Policy`；**移除** `'unsafe-inline'` / `'unsafe-eval'`；对 EPUB 内的 `<script>` / `<iframe>` / `<object>` / `<embed>` 一律剥离 |
| **A4** | **EPUB 内容先净化再渲染**：解析 → 剥离脚本与远程资源 → 重写 URL → 再交给渲染引擎 | 见 A1/A3；且 foliate-js 明确不支持脚本化内容 | 用 DOMPurify（承接 task-1 结论）做净化；禁止远程 `@import` 与追踪像素；对 `srcdoc` / `about:blank` 这类**同源** iframe 特别处理（正是 L1 点名的形态） |
| **A5** | **不使用 iframe 嵌不可信内容的架构**（首选方案） | 官方唯一给出的建议就是「不要嵌不可信内容」。既然必须渲染 EPUB，最安全的做法是**不把它当 HTML 渲染** | 评估「**结构化渲染**」路线：解析 EPUB → 转成安全内部模型（段落 / 样式 / 图片）→ 用 **Vue 组件渲染**。**彻底绕开 iframe 与绑定暴露问题**。代价：牺牲部分 EPUB CSS 保真度，需按书籍类型分级（纯文本 / 图文用结构化；复杂排版用沙盒 WebView） |
| **A6** | **禁用 `WebSocketAllowAllOrigins`，最小化 `WebSocketOriginPatterns`** | server-build.md：「Unsafe; default: false」；「Add only trusted origins」 | 保持默认 false；反向代理场景把**公网 origin** 精确加入白名单（否则 403） |

### B. Server / Web 版的多用户改造（对应第 3.4 节）

| # | 必须做的事 | 为什么 | 怎么做 |
|---|---|---|---|
| **B1** | **不要直接把 Wails server 模式暴露到公网** | 6.4：`/wails/runtime` 无鉴权，非浏览器客户端被放行 | 默认绑定 **loopback**；公网入口走自建反向代理 + 鉴权，或**另建独立 HTTP API**（不暴露 `/wails/runtime`） |
| **B2** | **自建用户 / 会话 / 配额模型** | 3.4：server 模式把标签页当「窗口」（`browser-N`），**无账号概念** | 在 Wails 之外实现认证（OIDC / 自建）；把「当前用户」通过 `context` 或显式参数传入 service |
| **B3** | **禁止把「当前用户 / 当前书籍」存在 service 字段里** | 4.1：service 是**跨所有窗口 / 标签页共享的单例** | 所有请求级状态由前端传参；service 只持有无状态逻辑与全局资源（DB 连接池等） |
| **B4** | **Events 必须定向发送，禁止广播用户数据** | 3.4：Go 侧 `Emit` 是**广播到所有已连接浏览器**；`event.Sender` 可区分 `browser-N` | 用 `Sender` 定向；**注意**：定向发送的精确 API **未验证**，需在 M0 实测 |
| **B5** | **对 `/wails/runtime` 设更小的请求体上限** | 默认 **64 MiB**（超限 413） | 用应用中间件或反向代理压低到实际需要（如 8 MiB） |

### C. 平台能力抽象与移动端

| # | 必须做的事 | 为什么 | 怎么做 |
|---|---|---|---|
| **C1** | **引入平台能力抽象层（三实现模式）** | 3.3：窗口 / 托盘 / 菜单 / 对话框 / 屏幕在 server 模式不可用；移动端多窗口仅首窗、托盘菜单是 no-op | 定义 `Tray` / `ScreenInfo` / `FileDialog` / `NativeTTS` / `SecureStore` 接口，分别提供 desktop / mobile / server 实现（**借鉴 Readest 的 `AppService` 三实现模式**） |
| **C2** | **前端做能力探测，不假设 API 可用** | 2.3：移动端 save / open-directory 对话框 ❌；窗口几何 no-op | 用 `System.IsMobile()` / `System.IsServer()` 分支；对不可用能力给出 UI 降级（例如「导出到沙盒」而非「另存为」） |
| **C3** | **双栏 / 对照阅读不用多窗口实现（至少在移动端）** | 2.3：移动端**仅第一个窗口** | 用单窗口内 Vue pane 布局 + CSS 多栏；桌面可另用多窗口增强 |
| **C4** | **M0 阶段做移动端专项验证（Go/No-Go）** | 第 2 节：实验性 + 无上架先例 + Android WebView 碎片化无对策 | 至少覆盖：① iOS 模拟器 + 真机启动；2) Android 模拟器 + 真机；③ **一台老旧 WebView 设备（华为 / 无 Play AOSP / Onyx Boox 等 e-ink）**；④ IPA / AAB 产出与签名；⑤ `/wails/runtime` 的 Origin 与 token 行为 |
| **C5** | **自研 Android WebView 版本探测与降级** | 7.2：Wails **无** `tauri-plugin-webview-upgrade` 等价方案；Tauri 侧已实测白屏 | 启动时探测 WebView 包与版本（读取 `WebView.getCurrentWebViewPackage()` 等）；过旧则引导升级或降级渲染路径；必要时自写 Kotlin 插件 |

### D. 数据库与依赖

| # | 必须做的事 | 为什么 | 怎么做 |
|---|---|---|---|
| **D1** | **选择纯 Go SQLite（`modernc.org/sqlite`）而非 cgo 驱动** | 5.3：官方示例用 cgo 驱动，与「一份代码出六端 + distroless server」冲突 | 用纯 Go 驱动；自行验证 Android / iOS / server 三目标的编译与运行（**本文未验证其对该三目标的可用性**） |
| **D2** | **钉死 CLI 与运行时版本** | 1.5：周更 + nightly；官方建议 pin | `go.mod` 与 CI 中固定 `wails3` 与 `@wailsio/runtime` 到同一版本 |
| **D3** | **建立升级回归清单 + 跟踪安全 PR** | 1.5 / 9.3：内部重构强度高；移动端不在承诺内 | 每次升级跑：打开 EPUB → 翻页 → 标注 → TTS → 同步 → 三端启动；订阅 `/wails/runtime` 与 Android bridge 相关 PR |

### E. 验证缺口（需要实测才能定论）

| # | 待验证项 | 若结果不利的后果 |
|---|---|---|
| **E1** | `/wails/runtime` 在**桌面模式**是否同样只做 Origin 校验（文档只在 server 模式章节描述） | 桌面端绑定暴露风险比预期更高 |
| **E2** | Android 上 `window.wails` 是否仍暴露给所有 frame（3.1.0 是否实际修复） | 移动端不可嵌任何第三方内容 → 加剧 A5 的必要性 |
| **E3** | Wails 是否**确实**没有 CSP 配置项与 capability 授权模型 | 若确实没有 → A3/A2 必须 100% 自建 |
| **E4** | 自定义协议 / 独立 origin 在 **iOS / Android** 是否可行（`wails://` 与 `WebViewAssetLoader` 的隔离程度） | 若不可行 → A1 失效 → 必须转向 A5（结构化渲染） |
| **E5** | `modernc.org/sqlite` 在 Android / iOS / server 的可编译性与性能 | 影响 D1 |
| **E6** | Android 老旧 WebView（Chromium 83–99）上的实际渲染表现 | 影响 C5 与是否需要原生降级 |
| **E7** | Wails v3 是否有**任何**真实应用上架 App Store / Google Play | 影响移动端整体可行性判断 |

---

## 附录 A · 证据索引（链接 + 证据日期）

| # | 来源 | 链接 | 证据日期 |
|---|---|---|---|
| A1 | Wails 仓库元数据（MIT / stars / 推送时间） | https://api.github.com/repos/wailsapp/wails | 2026-11-02 |
| A2 | **v3.0.0 发布说明（含 Security 段与 Known limitations 原文）** | https://github.com/wailsapp/wails/releases/tag/v3.0.0 | 发布 2026-10-26；抓取 2026-11-02 |
| A3 | **v3.1.0 发布说明（周更清单，无安全条目）** | https://github.com/wailsapp/wails/releases/tag/v3.1.0 | 发布 2026-11-01；抓取 2026-11-02 |
| A4 | v3.2.0-nightly.20261101 说明 | https://github.com/wailsapp/wails/releases/tag/v3.2.0-nightly.20261101 | 2026-11-02 |
| A5 | tag 列表（证明 `v3.0.1` 不存在） | https://api.github.com/repos/wailsapp/wails/tags?per_page=100 | 2026-11-02 |
| A6 | releases 列表（发布线时间轴） | https://api.github.com/repos/wailsapp/wails/releases?per_page=40 | 2026-11-02 |
| A7 | **官方 FAQ（平台要求 + 移动端实验性 + 生产就绪声明）** | https://v3.wails.io/zh-cn/faq/ | 2026-11-01 |
| A8 | **Server Build 指南（ServerOptions / Origin 校验 / Loopback Host 检查 / 差异表）** | https://wails.io/guides/server-build/ · 源文件 `docs/mpress/content/guides/server-build.md` | 2026-11-02 |
| A9 | Mobile Overview（能力矩阵 / 构建标签规则 / 工具链） | https://wails.io/guides/mobile/ · 源文件 `guides/mobile/index.md` | 2026-11-02 |
| A10 | iOS 指南（要求 / 打包 / 签名 / minIOSVersion） | 源文件 `guides/mobile/ios.md` | 2026-11-02 |
| A11 | Android 指南（SDK 35 / NDK 26.3.x / AAB / upload key） | 源文件 `guides/mobile/android.md` | 2026-11-02 |
| A12 | Services 绑定文档（单例 / 导出方法 / 生命周期 / 生成物路径） | 源文件 `features/bindings/services.md` | 2026-11-02 |
| A13 | 官方安全指南（通用最佳实践，无 iframe 隔离内容） | 源文件 `guides/security.md` | 2026-11-02 |
| A14 | 文档目录结构（证明无 database 专题） | https://api.github.com/repos/wailsapp/wails/contents/docs/mpress/content/features | 2026-11-02 |
| A15 | npm `@wailsio/runtime` 3.1.0（MIT） | https://registry.npmjs.org/@wailsio/runtime | 2026-11-02 |
| A16 | 第三方报道（移动端实验性 / 3.0.1 与 GHSA 待办） | 检索所得独立媒体分析 | 2026-11-02 |
| A17 | Tauri 侧对照：tauri-plugin-webview-upgrade（Android 老旧 WebView 白屏） | https://github.com/readest/tauri-plugin-webview-upgrade | 2026-11-02 |
| A18 | Tauri 2.0 发布文（移动端稳定 + DX 自评） | https://tauri.app/blog/tauri-20/ | 2024-10-02 |
| A19 | Readest Tauri 配置（CSP + capabilities，Tauri 侧对照） | https://github.com/readest/readest/blob/main/apps/readest-app/src-tauri/tauri.conf.json | 2026-11-02 |
| A20 | foliate-js Security 段（要求 CSP 阻止脚本）——承接 task-1 | https://github.com/johnfactotum/foliate-js | 2026-11-02 |
| A21 | `SECURITY.md`（Supported Versions 滞后，**经第三方镜像，未验证**） | 第三方镜像 | 2026-11-02 |

## 附录 B · 对 Vue 3 决策的直接影响

| 议题 | 结论 | 依据 |
|---|---|---|
| Vue 3 能否作为 Wails 前端 | **可以**。Wails 与前端框架无关（HTML / JS / CSS）；官方 v2 模板集含 `vue` / `vue-ts`（Vite） | v2 模板列表（第三方记录，2023-09-26）。**v3 官方模板清单未验证** |
| 生成的 TS 绑定是否框架无关 | **是**。`wails3 generate bindings` 产出普通 TS 模块，Vue 3 可直接 `import` | `features/bindings/services.md` |
| 需要额外封装什么 | 建议加一层 **composable 包装**（`useService()` / `useEvent()`）统一 loading / error / 重试 / 离线降级，并把 `System.IsMobile()` 的能力探测集中处理 | 4.2 + 2.3 的降级需求 |
| Vue 3 的 SSR / Web 部署 | 不需要 SSR。Web 版由 **Wails server 模式**提供同一份 SPA；若要 SEO 或多用户门户，另建独立前端 | `guides/server-build.md` |
| Vue 生态替代 React 生态的缺口 | React 侧的 `@assistant-ui/react`（Readest 用的 AI 对话 UI）在 Vue 侧**无直接对应**；TTS / 虚拟列表 / 富文本组件需重新选型 | task-1 结论交叉引用。**Vue 侧具体替代库未在本文件中评估** |

## 附录 C · 一句话交接

> **Wails v3 的桌面端 + Server 构建是可用的、许可宽松的真实优势；但它的移动端是官方标注的实验性能力且无上架先例，并且它明确不提供「让 iframe 无法调用绑定」的隔离机制——而这恰是 EPUB 阅读器最需要的。**
> **因此本项目的架构重点不是「怎么用 Wails」，而是「在 Wails 之上补齐隔离、鉴权、平台抽象与移动端验证这四件事」（第 11 节 A1–A6、B1–B5、C1–C5、D1–D3），并把移动端设为可选增量、M0 做 Go/No-Go。**

---

**文档结束** · 相关文件：docs/research/10-client-frontend.md（跨端框架调研，Tauri 基线）、docs/DESIGN.md、docs/OPEN-QUESTIONS.md。
