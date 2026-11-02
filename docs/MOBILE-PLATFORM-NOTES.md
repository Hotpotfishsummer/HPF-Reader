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
