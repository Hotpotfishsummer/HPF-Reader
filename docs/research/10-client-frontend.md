# 10 · 客户端/前端技术调研：全平台阅读器的渲染与跨端框架

> **任务**：task-1 ｜ **交付**：docs/research/10-client-frontend.md
> **撰写日期**：2026-11-02 ｜ **证据采集日期**：2026-11-02（除单独标注外）
> **配套文档**：docs/DESIGN.md、docs/OPEN-QUESTIONS.md（Q3/Q4/Q6 与本文件强相关）
> **方法说明**：关键结论均附可验证链接。GitHub 数据来自 GitHub REST API 与仓库内文件原文；版本号来自官方 npm registry / pub.dev API；规范条款来自 Apple、WebKit、Tauri、Readium 官方站点。**主观评分部分已显式标注为「研究员判断」，不是实测数据**。未能验证的内容统一写入 6.2 节，本文不编造仓库名、API、字段或数字。

---

## 0. 结论速览（TL;DR）

| 项目 | 结论 |
|---|---|
| **首选方案** | **Tauri v2 + TypeScript/React 单代码库 + 自持 foliate-js 分支 + 自研后端**（即 Readest 形态，但去掉 Supabase/Stripe/IAP 强绑定） |
| **移动端备选** | 若 Tauri mobile 在 M2 前仍不能同时满足「iOS 可上架 + Android 老旧 WebView 可用」，移动端降级为 **原生壳（Readium Kotlin / Readium Swift）+ 共享协议与数据层** |
| **Web 端** | 与桌面同一份前端代码，Next.js 静态导出/SSR 部署；PWA 作为 Web 的增强，**不作为独立交付形态** |
| **渲染引擎** | foliate-js（MIT）**必须 fork 并自持**（上游无 release、自称 unstable），PDF 走 pdf.js，定位模型对齐 **Readium Locator** |
| **明确否决** | Electron（无官方移动端、包体）、Flutter（EPUB 仍必须嵌 WebView，pub.dev 阅读生态薄）、React Native + Expo（无任何 Readium 官方 toolkit、无桌面复用）、Kotlin Multiplatform（渲染层等于双倍自研）、纯 PWA（iOS 文件系统/后台/存储三重限制） |
| **最大风险** | ① foliate-js 上游不稳定，必须自养引擎；② Android 系统 WebView 版本碎片化（Readest 为此专门写了 Kotlin 插件，其官方 README 承认「UI 可能白屏」）；③ iOS 只有 WebKit，且「下载/执行代码」受 App Store 2.5.2 限制；④ 阅读器类应用的「外部购买链接」规则（3.1.3(a)） |
| **必须预留的工程量** | 渲染引擎自持（1 人月级持续投入）、CSP/来源隔离安全设计、iOS + Android 双套签名与上架链路 |

---

## 1. Readest 真实架构核实（一手证据）

### 1.1 仓库事实基线

| 项目 | 事实 | 证据来源 | 证据日期 |
|---|---|---|---|
| 仓库 | `readest/readest`，Organization 为 `readest` | GitHub API `/repos/readest/readest` | 2026-11-02 |
| 创建时间 | 2024-10-12T23:16:55Z | 同上 | 2026-11-02 |
| 最近推送 | 2026-11-02T10:33:50Z（当天仍在提交） | 同上 | 2026-11-02 |
| Stars / Forks / Open Issues | 25,854 / 1,803 / 121 | 同上 | 2026-11-02 |
| 主语言 / 许可 | TypeScript / **AGPL-3.0** | 同上 | 2026-11-02 |
| 仓库 topics | `nextjs`, `tauri`, `foliate`, `epub`, `mobi`, `pdf`, `opds`, `koreader`, `tts`, `webdav`, `calibre`, `cross-platform` | 同上 | 2026-11-02 |
| 定位（官方原文） | "Built as a modern rewrite of Foliate, it leverages **Next.js 16** and **Tauri v2** to deliver a smooth, cross-platform experience across macOS, Windows, Linux, Android, iOS, and the Web." | [README.md](https://github.com/readest/readest/blob/main/README.md) | 2026-11-02 |

**任务书中待核实的假设，全部为真**：框架 = Tauri v2；前端 = Next.js + React；渲染 = foliate-js 分支；支持格式含 EPUB/PDF/MOBI/AZW3；除 Tauri 外确实有 Web 版本，且移动端已上架 App Store（id6738622779）与 Google Play（`com.bilingify.readest`）。

### 1.2 支持格式（官方 README 原文）

> "Support **EPUB, PDF, MOBI, KF8 (AZW3), FB2, CBZ, TXT, HTML, MD (Markdown)**"

注意：这比上游 foliate-js 自称支持的格式（EPUB/MOBI/KF8/FB2/CBZ/PDF）**多了 TXT / HTML / Markdown**——说明 Readest 在自己的分支或上层补了这三种格式的解析。HPF-Reader 若要做同样的格式矩阵，这部分工作量不可省。

来源：[README.md Features 表](https://github.com/readest/readest/blob/main/README.md)（证据日期 2026-11-02）

### 1.3 Monorepo 与目录结构

根 `package.json`：`"name": "@readest/monorepo"`，`"packageManager": "pnpm@11.1.1"`，格式化用 Biome，Git hooks 用 Husky。

| 目录 | 内容 | 证据 |
|---|---|---|
| `apps/readest-app` | **唯一主应用**（version `0.12.16`），同时编译出桌面/移动/Web | GitHub Contents API |
| `apps/readest-calibre-plugin` | Calibre 插件 | 同上 |
| `apps/readest-crosspoint-plugin` | CrossPoint 插件 | 同上 |
| `apps/readest.koplugin` | KOReader 插件（Lua） | 同上 |
| `packages/foliate-js` | **git submodule** → `https://github.com/readest/foliate-js.git` | GitHub Contents API（`type: submodule`、`submodule_git_url`） |
| `packages/js-mdict` | MDict（.mdx/.mdd）词典解析 | 同上 |
| `packages/qcms` | 色彩管理（ICC） | 同上 |
| `packages/simplecc-wasm` | 简繁转换（WASM） | 同上 |
| `packages/swift-rs` | Rust↔Swift 桥 | 同上 |
| `packages/tauri` | Tauri 相关封装 | 同上 |
| `packages/tauri-runtime-cef-stub` | **CEF 运行时桩**（实际用途未验证，见 6.2） | 同上 |

> 证据日期 2026-11-02，来源 [GitHub Contents API: /apps](https://api.github.com/repos/readest/readest/contents/apps)、`/packages`。

### 1.4 关键技术选型（来自 `apps/readest-app/package.json`，证据日期 2026-11-02）

| 层 | 选型 | 版本（原始声明） |
|---|---|---|
| 框架 | Next.js | `16.4.2` |
| UI | React / React DOM | `19.2.8` |
| 状态 | **Zustand** | `5.0.10` |
| 渲染引擎 | **foliate-js** | `workspace:*`（即本地 submodule） |
| Tauri API | `@tauri-apps/api` | `2.11.1`（锁死） |
| 本地数据库 | `@readest/turso-database-wasm`（libSQL/Turso 的 WASM 分支） | `0.7.0-pre.3-readest.0` |
| 服务端 | `@supabase/supabase-js` | `^2.76.1` |
| Web 部署 | `@opennextjs/cloudflare` | `^1.20.13` |
| 离线 | `@serwist/next` | `^9.5.6` |
| HTML 净化 | `dompurify` | `^3.4.16` |
| 正文抽取 | `@mozilla/readability` | `^0.6.0` |
| 中文分词 | `jieba-wasm` | `^2.4.0` |
| 语种识别 | `franc-min` | `^6.2.0` |
| 全文检索 | `lunr` | `^2.3.9` |
| 数学公式 | `katex` | `^0.18.11` |
| DOCX | `mammoth` | `^1.12.0` |
| AI 对话 UI | `@assistant-ui/react` + Vercel `ai` SDK | `0.11.58` / `^6.0.299` |
| 支付 | `stripe` / `@stripe/react-stripe-js` | `^22.0.2` / `^6.2.0` |
| 埋点 | `posthog-js` | `^1.246.0` |
| 虚拟列表 | `react-virtuoso` / `react-window` / `virtua` | 三个都在用 |
| Tauri 插件 | fs, http, dialog, shell, os, process, log, updater, websocket, deep-link, clipboard-manager, biometric, haptics, oauth, sharekit, device-info, cli | `@tauri-apps/plugin-*` |

**观察**：AI 能力用 Vercel AI SDK + OpenAI-compatible 适配器 + `ai-sdk-ollama`（支持本地 Ollama），即「服务端代理 + 可换 provider」，与 HPF-Reader 的 LLM 规划（OPEN-QUESTIONS Q7）方向一致。

### 1.5 运行时边界与平台抽象（来自仓库内 `apps/readest-app/docs/architecture.md`，证据日期 2026-11-02）

这是本次调研**信息密度最高的单一来源**，官方原文要点：

| 主题 | 原文要点 |
|---|---|
| 一份代码多目标 | "Readest is a single TypeScript/React codebase (`apps/readest-app`) compiled into multiple targets"：桌面（Tauri v2）、移动（Tauri v2 mobile）、Web（Next.js / Cloudflare Workers via OpenNext）、浏览器扩展、Windows 缩略图 shell 扩展 |
| 三个运行时 | Browser（React UI + foliate-js + service worker + Turso WASM）、Tauri native host（Rust）、Next.js server（Worker/Node） |
| 平台抽象 | `src/services/appService.ts` 定义 `AppService` 接口，实现为 `nativeAppService`（Tauri）/ `webAppService`（浏览器）/ `nodeAppService`（测试/CLI），由 `environment.ts` 运行时选择 |
| 数据库抽象 | 同样三实现：`webDatabaseService`（Turso WASM）/ `nativeDatabaseService`（`tauri-plugin-turso`）/ `nodeDatabaseService`，共享 `migrate.ts` 与 `migrations/*` |
| **COOP/COEP 硬依赖** | `middleware.ts` 对每个文档设 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`，因为「Turso WASM 线程池需要 `SharedArrayBuffer`；没有这些响应头 `initThreadPool` 会挂起」 |
| 运行时配置注入 | `/runtime-config.js` 输出 `window.__READEST_RUNTIME_CONFIG`，让**同一个 Docker 镜像**在部署时切换 Supabase 项目 / S3 端点 / 配额，无需重新构建 |
| 服务端路由 | Pages Router 承担 sync/storage/email（`sync/replicas.ts`、`storage/upload.ts`、`send/inbox.ts`…）；App Router 承担较新的 ai/tts/stripe/IAP/metadata/opds |
| 原生壳很薄 | `src-tauri/src` 只有 `lib.rs`、`clip_url.rs`、`browser_fetch.rs`、`browser_cookies_macos.rs`、`dir_scanner.rs`、`transfer_file.rs`、`discord_rpc.rs` + 各平台胶水 |
| **安全闸门** | `lib.rs` 的 `allow_paths_in_scopes` 只对「Tauri dialog 插件或 persisted-scope 已授权过的路径」扩展 `fs_scope` 与 `asset_protocol_scope`。文档明确写：没有这道闸门，「任何前端代码路径——包括通过书籍内容、OPDS HTML 或受损依赖触发的假想 XSS——都能通过 asset protocol 给自己授予读取用户主目录的权限」 |

### 1.6 同步与后端（同 architecture.md）

三条并存的同步路径，对**离线优先 + 多用户**目标极具参考价值：

| 路径 | 机制 | 对我们的意义 |
|---|---|---|
| ① KOSync 兼容（legacy） | `KOSyncClient.ts` → `pages/api/sync.ts` / `kosync.ts` | KOReader 生态兼容，成本低、可后置 |
| ② **Replica sync（现代主线）** | 本地用口令派生密钥加密每个 replica（`replicaCryptoMiddleware.ts`、`passphraseGate.ts`），**发布增量 delta**，按类别 adapter 应用（annotations/settings/dictionaries/fonts/textures/OPDS）；`replicaCursorStore` 记录「上次拉到哪」 | **端到端加密 + 增量 + 按类别**，正是「字段级 LWW + 冲突可解释」想要的基础形态 |
| ③ 第三方文件同步 | provider 无关引擎 + WebDAV / Google Drive / S3 / OneDrive / iCloud adapter，把共享书架元数据写进 `library.json` | 与「自托管 + 可选对象存储」兼容 |

云书库（区别于 replica sync）：book bytes 走 S3 预签名上传/下载；本地以 `Books/<hash>/` 存放，或「原地保留」（in-place）模式；删除有本地/云端/两者对称语义。

AI/RAG：`src/services/ai` + `/api/ai/chat`（流式）+ `/api/ai/embed`；文档称 reader 可做 book-scoped RAG，把章节在本地向量化后查询。

TTS：**四后端统一接口**（`src/services/tts`）——`WebSpeechClient`（浏览器）、`NativeTTSClient`（Tauri，走 `tauri-plugin-native-tts`）、`EdgeTTSClient`（服务端流式）、`MediaOverlayClient`（EPUB3 Media Overlay / 本地音频配对）。并用 `TTSCapabilities`（`wordBoundaries`、`mediaClock`、`gapControl`、`liveRateChange`、`continuousTimeline`、`textHighlight`）做**能力降级**，而不是比较客户端身份。

翻译：DeepL / Google / Azure / Yandex 四家 adapter；DeepL 走服务端代理以隐藏 API Key。

### 1.7 构建与发布（官方 architecture.md + package.json scripts）

| 目标 | 构建 | 产物 |
|---|---|---|
| Web | `next build` + `@opennextjs/cloudflare` | Cloudflare Workers（web.readest.com）；**同时有自托管 Docker 镜像**（`ghcr.io/readest/readest`，工作流 `.github/workflows/docker-image.yml`） |
| 桌面 | `next build` → `tauri build` | `dmg`（macOS universal）/ `nsis`（Windows x64、arm64）/ `appimage`（Linux） |
| 移动 | `tauri android build` / `tauri ios build` | `aab` / `ipa` |
| 商店 | `tauri.appstore.conf.json` + `tauri.macos-nonstore.conf.json` 双配置；`fastlane release_ios` / `release_macos`；`release-google-play.sh`、`@googleapis/androidpublisher` | App Store / Google Play |

签名与商店配置通过 `dotenv` 切换环境文件（`.env.tauri`、`.env.tauri.local`、`.env.apple-appstore.local`、`.env.ios-appstore.local`、`.env.google-play.local`）。

### 1.8 Readest 的「自持」仓库（Organization 级证据，2026-11-02）

这一栏最能说明「用 Tauri 做全平台阅读器实际要付出什么」：

| 仓库 | 语言 | Stars | 最后推送 | 说明（官方原文） |
|---|---|---|---|---|
| `readest/foliate-js` | JavaScript | 19 | 2026-10-26 | "Render e-books in the browser"（**上游 fork**） |
| `readest/tauri-plugin-turso` | Rust | 3 | 2026-09-05 | "Bring turso + encryption + drizzle orm to Tauri apps" |
| `readest/tauri-plugin-webview-upgrade` | Kotlin | 4 | 2026-10-18 | "Redirect a Tauri Android app's in-process WebView loader to a sideloaded WebView." |
| `readest/turso` | Rust | 0 | 2026-05-26 | libSQL/Turso fork |
| `readest/flathub-readest` | — | 0 | 2026-07-08 | Flatpak 打包 |
| `readest/localsend` / `readest/tauri` / `readest/tao` | — | 0–1 | 2026-08 ~ 2026-10 | 相关上游 fork |

来源：[GitHub API: /orgs/readest/repos](https://api.github.com/orgs/readest/repos)（证据日期 2026-11-02）

> **推论（明确标注为推论）**：一个 2.6 万星的成熟项目，仍需要自己维护 foliate-js 分支、自己写 Turso 的 Tauri 插件、自己写 Android WebView 降级插件。HPF-Reader 若走同一条路，**必须把「引擎自持 + 平台插件自写」计入预算**，而不是假设「选 Tauri 就免费得到全平台」。

---

## 2. 跨端框架横评（严格限定「阅读器」场景）

### 2.1 候选与版本现状（证据日期 2026-11-02）

| 框架 | 最新版本 | 发布时间 | 证据来源 |
|---|---|---|---|
| Tauri | crate `2.12.3` / `@tauri-apps/api` npm `2.12.4` | 2026-10-10 / 2026-10-14 | [tauri.app/release](https://tauri.app/release/)、npm registry |
| Electron | `45.2.1` | 2026-10-31 | [npm registry: electron](https://registry.npmjs.org/electron) |
| Capacitor | `@capacitor/core` `8.6.0` | 2026-10-28 | [npm registry: @capacitor/core](https://registry.npmjs.org/@capacitor/core) |
| Flutter | 版本号本次未从官方渠道取证 | — | **未验证**（见 6.2） |
| React Native / Expo | 版本号本次未从官方渠道取证 | — | **未验证**（见 6.2） |
| Kotlin Multiplatform / Compose MP | 版本号本次未从官方渠道取证 | — | **未验证**（见 6.2） |
| PWA | 无「版本」，受浏览器实现约束 | — | WebKit 存储策略文章 2023-08-10 |

Tauri 主仓库：`tauri-apps/tauri`，**112,431 stars**，最后推送 2026-10-31，Apache-2.0，open issues 1,506（GitHub API，证据日期 2026-11-02）。

### 2.2 阅读器场景的 11 个关键维度（定义）

| # | 维度 | 为什么阅读器场景特殊 |
|---|---|---|
| D1 | **全平台覆盖** | 目标是 Web + Win/macOS/Linux + iOS + Android 六端同一账号 |
| D2 | **EPUB 内嵌 HTML/CSS 渲染保真度** | EPUB 就是打包的 HTML/CSS；排版引擎弱 = 书排版错乱，这是**生死线**，不是普通 App 的 UI 问题 |
| D3 | **渲染引擎一致性（跨平台）** | 同一本书在 Windows/macOS/iOS/Android 上排版必须接近；引擎越多，分页/断行/字体差异越大 |
| D4 | **PDF 渲染** | 扫描版 PDF、文本层、标注层，是重度阅读者刚需 |
| D5 | **文件系统与本地书库权限** | 需要「导入 5000 本本地书 + 原地保留 + 大文件随机读」，iOS/Android 沙盒是硬约束 |
| D6 | **后台任务** | 下载、同步、TTS 音频缓存、格式转换都需要后台执行 |
| D7 | **安装包体** | 桌面端用户对 100MB+ 安装包敏感；移动端影响下载转化 |
| D8 | **长文性能（滚动/分页）** | 单章 20 万字、整书 500 万字；分页重排是 O(内容) 操作 |
| D9 | **开发效率（单代码库复用率）** | 全平台是 6 个交付物，重复实现 = 项目必死 |
| D10 | **阅读器相关生态** | 是否有可复用的 EPUB/PDF/定位/标注库，决定 6 人月还是 24 人月 |
| D11 | **Web 端复用与上架合规** | 一份代码能否出 Web；以及能否通过 App Store / Google Play 审核 |

### 2.3 总评分表（**研究员主观评分 1–5 分，非实测**）

权重按「阅读器场景」而非通用 App 场景设定。

| 维度 | 权重 | Tauri v2 | Electron | Flutter | RN + Expo | Kotlin MP | Capacitor | 纯 PWA |
|---|---|---|---|---|---|---|---|---|
| D1 全平台覆盖 | 12 | **5** | 2 | **5** | 4 | 4 | 4 | **5** |
| D2 EPUB 渲染保真度 | 18 | **5** | **5** | 3 | 3 | 3 | **5** | **5** |
| D3 引擎一致性 | 10 | 3 | **5** | 4 | 3 | 2 | 3 | 3 |
| D4 PDF 渲染 | 8 | 4 | 4 | 4 | 3 | 2 | 4 | 4 |
| D5 文件系统/沙盒 | 9 | 4 | **5** | 4 | 3 | 4 | 3 | 1 |
| D6 后台任务 | 7 | 3 | **5** | 4 | 3 | 4 | 3 | 1 |
| D7 包体 | 4 | **5** | 1 | 4 | 3 | 4 | 4 | **5** |
| D8 长文性能 | 9 | 3 | 4 | 4 | 3 | 4 | 3 | 3 |
| D9 开发效率 | 10 | **5** | 2 | 4 | 3 | 2 | 4 | **5** |
| D10 阅读器生态 | 8 | 3 | 4 | 2 | 2 | 2 | 4 | 4 |
| D11 Web 复用/合规 | 5 | **5** | 4 | 2 | 2 | 2 | **5** | **5** |
| **加权总分（/5）** | 100 | **4.15** | 3.88 | 3.68 | 2.99 | 3.00 | 3.88 | 3.82 |

> 评分口径：分数代表「对该维度的满足程度」，不是「质量排名」。例如 Electron 的 D2/D3/D5/D6 都是 5 分，但 D1 只有 2 分（官方不支持 iOS/Android），加权后即被拉平——这正是「通用场景会误判、阅读器场景必须加权」的地方。

### 2.4 逐维度深评

#### D1 全平台覆盖（权重最高）

| 框架 | 官方支持的平台 | 证据 |
|---|---|---|
| Tauri v2 | 桌面（macOS/Linux/Windows）+ **移动（iOS/Android）**。官方原话："Tauri is a framework for building tiny and fast binaries for all major desktop (macOS, linux, windows) and mobile (iOS, Android) platforms." | [Tauri 2.0 Stable Release, 2024-10-02](https://tauri.app/blog/tauri-20/) |
| Electron | 桌面三平台；**无官方移动端** | Electron 官方 platform support 文档已迁至仓库 README（[docs/latest/tutorial/support](https://www.electronjs.org/docs/latest/tutorial/support)），本次未取到 README 原文，见 6.2 |
| Flutter | 移动 + 桌面 + Web（Web 端长文选择/排版的成熟度存疑，未验证） | 本次未取证官方页面，见 6.2 |
| RN + Expo | 移动为主，Web 为社区方案，桌面无官方 | 本次未取证，见 6.2 |
| Kotlin MP | Android/iOS/桌面/JVM；Web(Wasm) 尚在演进 | 本次未取证，见 6.2 |
| Capacitor | iOS / Android / Web；桌面需搭配 Electron | 本次未取证官方页面，见 6.2 |
| PWA | 任意现代浏览器 | — |

#### D2 EPUB 渲染保真度（阅读器专属，权重最高）

**结论：除 Flutter / RN / KMP 之外，其余方案最终都是「在某个 WebView 里渲染 HTML」，保真度取决于 WebView 而非框架。**

关键反证：Flutter 生态里被广泛使用的 EPUB 方案**最终仍要嵌 WebView**：

| Flutter 包 | 最新版本 | 发布时间 | 官方描述 | 判断 |
|---|---|---|---|---|
| `epub_view` | 3.3.0 | 2026-08-20 | "Flutter widget for view EPUB documents… Based on dart-epub package" | 纯 Dart 渲染，CSS 支持受限于 Flutter 排版，非浏览器级保真 |
| `flutter_epub_viewer` | 2.2.1 | 2026-10-28 | "developed by combining the power of **Epubjs and flutter_inappwebview**" | **自认是 WebView + epub.js** |
| `vocsy_epub_viewer` | 3.0.0 | 2024-09-02 | "encapsulates the **folioreader** framework" | 依赖原生 FolioReader，包内维护度低 |
| `epubx` | 4.0.0 | **2023-06-30** | "Epub Parser for Dart" | 近 3 年未发布 |
| `epub_parser` | 3.0.1 | **2022-04-20** | "Epub Parser for Dart" | 已停滞 |

来源：[pub.dev API](https://pub.dev/api/packages/epub_view)（证据日期 2026-11-02）

**真实案例佐证**：开源阅读器 **Anx Reader**（v1.14.0）用 Flutter 开发，其 `pubspec.yaml` 直接依赖 `flutter_inappwebview`，且**作者 fork 了三个关键依赖**：

- `flutter_inappwebview` → `github.com/Anxcye/flutter_inappwebview`（ref `4a275c3`）
- `flutter_tts` → `github.com/Anxcye/flutter_tts`
- `webdav_client` → `github.com/Anxcye/webdav_client`

同时依赖 `html`、`flutter_html`、`sqflite`、`flutter_riverpod`、`chinese_font_library`。

来源：[Anxcye/anx-reader pubspec.yaml](https://github.com/Anxcye/anx-reader/blob/main/pubspec.yaml)（证据日期 2026-11-02）

> **可验证的推论**：Flutter 做阅读器，一旦要「浏览器级 EPUB 排版 + TTS + WebDAV」，就必须嵌 WebView 并 fork 原生插件；此时已经放弃了 Flutter「自绘引擎、跨端一致」的核心卖点，却仍承担 Flutter 的生态成本。这是把 Flutter 列为**否决**而非「备选」的主要依据。

#### D3 引擎一致性

Tauri 在五个平台的 WebView 分别是：Windows = **WebView2 (Chromium)**、macOS/iOS = **WKWebView (WebKit)**、Linux = **WebKitGTK 4.1**、Android = **系统 Android WebView (Chromium)**。Tauri 官方 Linux 依赖清单即要求 `webkit2gtk-4.1`（[Prerequisites](https://v2.tauri.app/start/prerequisites/)，证据日期 2026-11-02）。

Tauri 官方 2024-10-02 的 2.0 发布文在 Roadmap 中列出两个「统一引擎」的远期想法，正说明这是**已知痛点**：

> "Providing or Bundling Chromium Embedded Framework (CEF) for Linux as an alternative to WebKit2GTK"；"**Servo** as Tauri WebView (POC in Wry)"

后续进展：官方 2025-03-17 发布 [Experimental Tauri Verso Integration](https://tauri.app/blog/tauri-verso-integration/)（基于 Servo 的 `tauri-runtime-verso`），但文中明确 "still in active development"、"We currently only support a small subset of features in Tauri"、"as currently you need to compile Verso yourself"。**证据日期 2025-03-17，至 2026-11-02 是否已可用于生产：未验证。**

Electron 唯一的优势就在这一项：**捆绑同一份 Chromium**，跨端渲染完全一致。代价是包体（见 D7）。

#### D4 PDF 渲染

所有 WebView 类方案都可以用 pdf.js，Readest 即是：architecture.md 明确写 "PDF rendering goes through `pdfjs-dist`"，且运行时只把 worker、WASM 解码器、cmaps、标准字体、layer CSS 复制到 `public/vendor/pdfjs`（`pnpm setup-pdfjs`）。

Readium 原生 toolkit 的 PDF 支持更「原生」：

| 能力 | EPUB (reflow) | EPUB FXL | PDF |
|---|---|---|---|
| 分页 Pagination | ✅ | ✅ | ✅ |
| 滚动 Scrolling | ✅ | 👀 | ✅ |
| RTL | ✅ | ✅ | ✅ |
| 文本搜索 | ✅ | ✅ | 👀 |
| 高亮（Decoration API） | ✅ | ✅ | 👀 |
| TTS | ✅ | ✅ | 👀 |

图例：✅ 已实现 / 🚧 部分 / 📆 计划 / 👀 想做 / ❓ 不计划。

来源：[readium/kotlin-toolkit README](https://github.com/readium/kotlin-toolkit/blob/develop/README.md)（证据日期 2026-11-02）

**注意 PDF 行的 👀**：Readium 原生 toolkit 的 PDF **搜索/高亮/TTS 目前都只是「想做」**。也就是说走原生路线在 PDF 标注上并不比 pdf.js 强多少（pdf.js 自带 text layer + annotation layer，Readest 已在生产使用）。

#### D5 文件系统与本地书库权限

- Readest 在 Tauri 上实现了完整本地库：`src-tauri/src/dir_scanner.rs`（递归目录扫描）、`transfer_file.rs`（大文件分块上传/下载），并用 `allow_paths_in_scopes` 把 `fs_scope` / `asset_protocol_scope` 的扩展**限制在用户通过 dialog 选过的路径**上（architecture.md 第 7 节）。
- 这意味着 Tauri 的文件访问模型是「**用户授权 + 作用域**」，而不是 Electron 的「Node 全盘访问」。对阅读器来说这更安全，但**在移动端会明显受沙盒限制**：iOS 上无法像桌面一样扫描用户的整个书库目录，只能通过 document picker / 分享 / iCloud 容器。
- Electron 具备完整 Node.js 文件系统能力（Koodo Reader 依赖 `better-sqlite3`、`fs-extra` 直接操作本地库：[package.json](https://github.com/koodo-reader/koodo-reader/blob/master/package.json)，版本 2.4.7，证据日期 2026-11-02）。
- **iOS Safari / WKWebView 的文件系统能力：未验证**（见 6.2）。

#### D6 后台任务

- Electron 有完整 Node.js 进程，后台任务最自由（Koodo 用它做 S3/WebDAV/FTP 同步、`better-sqlite3` 本地库）。
- Tauri 的 Rust 侧可以做后台线程；但**移动端的后台执行受 iOS/Android 系统策略限制**，与框架无关。Readest 的做法是把长任务放进原生侧：`transfer_file.rs`（分块传输）、`ttsDownloadManager`（离线音频队列，"a durable, per-book queue… resumes when that book next has an active reader session"）。
- Tauri 官方插件在桌面/移动的逐项支持矩阵：**本次未逐项取证**，Tauri 的 [plugin 页面](https://tauri.app/plugin/) 提供交互式 Support Table，需按需核对，见 6.2。

#### D7 包体

- Tauri = 系统 WebView + Rust 二进制，官方宣传 "tiny and fast binaries"（[Tauri 2.0 blog](https://tauri.app/blog/tauri-20/)，2024-10-02）。
- Electron = 捆绑 Chromium + Node，`electron` npm 包 45.2.1（2026-10-31）。
- **具体包体数字本文未实测，不引用任何未经证实的「XX MB」说法**（见 6.2）。判断依据仅为架构事实（是否捆绑引擎）。

#### D8 长文性能

- Readest 同时使用 `react-virtuoso`、`react-window`、`virtua` 三个虚拟化库（package.json，证据日期 2026-11-02）——说明「长列表 + 长书」在 WebView 里确实需要专门优化。
- foliate-js 的设计声明对性能有利："Does not require loading whole file into memory"（[foliate-js README](https://github.com/johnfactotum/foliate-js)，证据日期 2026-11-02）。
- **各框架在中端手机上的滚动帧率、分页耗时：未实测**，本文不给具体数字（DESIGN.md 里的 fps 目标属于目标值，不是实测）。

#### D9 开发效率

**这是 Tauri 的决定性优势**：Readest 用**一份 `apps/readest-app` 源码**产出 6 个平台目标，且 Web 版就是同一份 Next.js 应用（architecture.md 第 1 节流程图与第 8 节 Build/Deploy 图）。

| 方案 | 若要覆盖「Web + 3 桌面 + iOS + Android」需要维护几套渲染实现 |
|---|---|
| Tauri v2 + Web | **1 套**（WebView 内同一份 React） |
| Electron + Web | 2 套（桌面 Electron + 移动另找方案） |
| Capacitor + Electron | 2 套（移动 Capacitor + 桌面 Electron/其它） |
| Flutter | 1 套 UI + **每端的 WebView 集成与原生插件**（Anx Reader 已 fork 3 个依赖） |
| RN + Expo | 1 套 UI（移动优先）+ Web 需 RN Web + 桌面无官方 |
| Kotlin MP | 1 套业务 + **每端渲染集成**（Readium Kotlin 仅 Android，Readium Swift 仅 Apple） |
| 纯 PWA | 1 套，但功能被浏览器能力封顶 |

#### D10 阅读器相关生态

| 生态 | 可复用的阅读器库 |
|---|---|
| JS/TS（Tauri / Electron / Capacitor / PWA 共用） | foliate-js（MIT）、pdf.js、**Readium TS toolkit**（BSD-3）、Readium CSS、epub.js（已停滞，见 3.2）、DOMPurify、Readability、katex、jieba-wasm |
| Swift | **Readium Swift toolkit**（BSD-3，574 stars，最后推送 2026-11-02） |
| Kotlin | **Readium Kotlin toolkit**（BSD-3，395 stars，最后推送 2026-10-16） |
| Dart/Flutter | 见 D2 表，最佳方案仍绕回 WebView + epub.js |
| RN | Readium 官方 toolkit 列表中**没有 React Native** |

**Readium 官方 toolkit 清单（决定性证据）**，原文：

> **Toolkits**
> - Readium Mobile
>   - Swift toolkit for iOS, iPadOS and macOS
>   - Kotlin toolkit for Android and Chrome OS
> - Readium Web
>   - TS toolkit primarily used for client-side applications
>   - Go toolkit primarily used for server-side applications

来源：[readium.org/awesome-readium](https://readium.org/awesome-readium/)（证据日期 2026-11-02）

**没有 React Native、没有 Flutter、没有 KMP 版本**。选择这三个框架，就等于放弃 Readium 官方渲染层。

#### D11 Web 复用与上架合规

- Tauri/Electron/Capacitor 均可用同一份 Web 代码出 Web 版。
- Flutter Web、RN Web 在「文本选择/滚动/字体渲染」上的表现与浏览器原生的差异——**本次未取证，不评价**。
- 上架合规是独立硬约束，见第 5.4 与第 6 节。

### 2.5 Tauri v2 移动端成熟度专章

本节是本任务明确要求「优先核实」的部分，证据按重要性排序。

#### 证据 1：官方自认移动 DX 未达桌面水平（2024-10-02）

> "We support development with an emulator or a real device and provide a lot of tooling… **We are not completely happy about the developer experience at the moment** but are actively improving to bring it up to par with the desktop experience."
> "**On mobile not all of the official plugins are supported.** Some are by design not a good fit for mobile and some are just not implemented to support mobile yet."

来源：[Tauri 2.0 Stable Release, 2024-10-02](https://tauri.app/blog/tauri-20/)

#### 证据 2：官方 Roadmap 把「改进移动开发体验」列为 2.x 首要方向（2024-10-02）

> "We mainly want to focus on improving this major version with a better developer experience… **We want to improve especially the mobile development experience** and make the whole flow from idea to published application as seamless as possible."

来源同上。

#### 证据 3：移动端已连续迭代两年，功能在补（2026）

- Tauri 2.12（[2026-09-26](https://tauri.app/blog/tauri-2.12/)）：新增 `on_permission_request`（WebView 权限请求拦截）、MSRV 提升到 1.90、官方弃用 Windows 7；Notable changes 明确 "**On mobile, loading the page through dev web servers should be much faster**"——即移动端 dev server 加载速度此前是痛点。
- 官方文档已出现专门的移动端内容：`Mobile Plugin Development`、`Multi-Window on Mobile`、`File Associations on Mobile`，以及 iOS/Android 各自的签名与 App Store / Google Play 分发指南。
- 核心版本节奏稳定：tauri crate 2.12.3（2026-10-10）、`@tauri-apps/api` 2.12.4（2026-10-14）。

来源：[tauri.app/release](https://tauri.app/release/)（证据日期 2026-11-02）

#### 证据 4（**最关键**）：Android 系统 WebView 碎片化会直接导致白屏

Readest 为解决该问题专门写了 Kotlin 插件 `tauri-plugin-webview-upgrade`。其 README 原文：

> "Redirect a Tauri Android app's **in-process** WebView loader to a sideloaded `com.google.android.webview` when the device's system WebView is stuck on an old Chromium version. iOS and desktop are intentional no-ops.
> This unblocks Tauri apps on devices where the system WebView can't be updated through normal channels — **Huawei phones (`com.huawei.webview`), e-ink readers on Rockchip / Moaan / Onyx / Boox builds with `com.android.webview` 83-99, AOSP forks without Play Store**, and so on. **Modern Tauri / Wry-rendered UIs typically render as a blank screen on those WebViews**; with this plugin installed, the user can sideload a recent `com.google.android.webview` APK and the app picks it up on next launch."

来源：[readest/tauri-plugin-webview-upgrade README](https://github.com/readest/tauri-plugin-webview-upgrade)（证据日期 2026-11-02）

> **对本项目的直接含义**：受影响机型里包含 **e-ink 阅读器（Onyx Boox、Moaan 等）**——这恰恰是电子书阅读器的核心用户群之一。如果 HPF-Reader 面向 Android 中文阅读用户，**这个问题一定会遇到**，且必须在 M2 之前验证应对方案。

#### 证据 5：Tauri 团队自己在探索替换 WebView 引擎（说明系统 WebView 是结构性依赖）

见 2.4 D3 的 Verso/Servo 与 CEF 证据。

#### Tauri v2 移动端成熟度小结

| 判断项 | 结论 | 依据强度 |
|---|---|---|
| 移动端「能不能用」 | **能**：Readest 已在 App Store（id6738622779）与 Google Play（`com.bilingify.readest`）上线 | 强（README 下载区 + tauri.conf identifier） |
| 移动端 DX 与桌面是否同级 | **否**：官方自认未达 | 强（官方原文） |
| 官方插件移动覆盖是否完整 | **否**：官方自认 "not all… supported" | 强（官方原文） |
| Android 老旧 WebView 是否导致 UI 不可用 | **是**：会白屏，需额外插件/引导 | 强（一手插件 README，由 Readest 实测驱动） |
| iOS 是否可用于生产 | **倾向可以**：Readest 已上架 App Store，且该插件在 iOS 为 no-op | 中（上架事实 + 插件声明；未做 iOS 专项可用性测试） |
| 是否需要自写原生插件 | **很可能需要**：Readest 自写了 native-bridge / native-tts / turso / webview-upgrade | 强（架构文档 + org 仓库） |

---

## 3. 渲染引擎候选

### 3.1 foliate-js（首选，但必须 fork 自持）

| 项目 | 事实 | 证据 |
|---|---|---|
| 仓库 | `johnfactotum/foliate-js` | GitHub API |
| 许可 | **MIT**（`license.spdx_id = MIT`） | GitHub API，2026-11-02 |
| Stars / Forks / Open Issues | 1,146 / 296 / 69 | 同上 |
| 创建 / 最后推送 | 2022-10-18 / **2026-05-01** | 同上 |
| 支持格式（官方 README） | "Supports **EPUB, MOBI, KF8 (AZW3), FB2, CBZ, PDF (experimental; requires PDF.js)**" | [README](https://github.com/johnfactotum/foliate-js) |
| 稳定性自评 | "It works reasonably well, and has been used in several stable releases of Foliate. This library itself is, however, **not stable. Expect it to break and the API to change at any time. Use it at your own risk.**" | 同上 |
| 分发方式自评 | "**since there's no release yet**, it is recommended that you include the library as a **git submodule** in your project" | 同上 |
| npm 包 | `foliate-js@1.0.1`，发布者 **`shmandadi`**（非作者 `johnfactotum`），仅 2 个版本，全部发布于 2025-04-21 | [npm registry](https://registry.npmjs.org/foliate-js)，2026-11-02 |
| 内存特性 | "Does not require loading whole file into memory" | README |
| 架构 | 原生 ES modules，无构建步骤；`view.js` 为总入口；`epubcfi.js` 实现 CFI | README |

**必须写进技术方案的三条推论**：

1. **不要依赖 npm 上的 `foliate-js`**：该包发布者不是上游作者，且自 2025-04-21 未更新。上游明确建议用 **git submodule**。Readest 正是用 submodule（`packages/foliate-js` → `github.com/readest/foliate-js.git`）。
2. **上游 6 个月未推送（2026-05-01 至 2026-11-02）、无正式 release**。HPF-Reader 必须 **fork 并自持**，预留持续的引擎维护人力。
3. MIT 许可意味着 fork 后**可以闭源**——这是相对 Readest 本体（AGPL-3.0）的关键许可优势，直接回答 OPEN-QUESTIONS Q4。

### 3.2 epub.js（否决）

| 项目 | 事实 | 证据 |
|---|---|---|
| 仓库 | `futurepress/epub.js` | GitHub API |
| Stars / Forks / Open Issues | 6,967 / 1,185 / **516** | 同上，2026-11-02 |
| 最后推送 | 2026-03-24 | 同上 |
| npm `epubjs` latest | **0.3.93，发布于 2022-02-16** | [npm registry](https://registry.npmjs.org/epubjs) |
| npm 包最后修改 | **2023-09-26**（最后一版是 `0.5.0-alpha.3`） | 同上 |
| 版本历史 | 0.3.92 (2022-01-07) → 0.3.93 (2022-02-16) → 0.5.0-alpha.0/1/2/3 (2023-01 ~ 2023-09) | 同上 |

**判断**：稳定版 4 年半未发；alpha 线 3 年未动；516 个未处理 issue。虽然仓库在 2026 年仍有零星提交，但**作为新项目的渲染内核不可接受**。它对 EPUB 之外的格式（MOBI/PDF/CBZ/TXT）也没有支持。

### 3.3 Readium（TS / Kotlin / Swift）

| 项目 | 平台 | Stars | 最后推送 | 许可 | 活跃度证据 |
|---|---|---|---|---|---|
| `readium/ts-toolkit` | Web（客户端） | 159 | 2026-10-23 | BSD-3-Clause | npm `@readium/navigator` **2.14.0（2026-10-23，自 2024-10-18 起 110 个版本）** |
| `readium/kotlin-toolkit` | Android / Chrome OS | 395 | 2026-10-16 | BSD-3-Clause | 最新 3.4.0；`develop` 要求 min SDK 24 / compile SDK 37 |
| `readium/swift-toolkit` | iOS / iPadOS / macOS | 574 | 2026-11-02 | BSD-3-Clause | 当天仍在推送 |
| `readium/go-toolkit` | 服务端 | — | — | — | 见 awesome-readium 清单 |

npm 上的 Readium 包（证据日期 2026-11-02，来源 [npm registry](https://registry.npmjs.org/@readium%2Fnavigator)）：

| 包 | 最新版本 | 发布时间 |
|---|---|---|
| `@readium/navigator` | 2.14.0 | 2026-10-23 |
| `@readium/shared` | 2.8.0 | 2026-10-09 |
| `@readium/navigator-html-injectables` | 2.9.2 | 2026-10-23 |
| `@readium/css` | 2.0.5 | 2026-05-13 |

Readium Mobile 官方能力：EPUB 2.x/3.x、EPUB Fixed Layout、PDF、有声书；用户偏好、夜间/护眼模式、EPUB 搜索、高亮/标注、TTS、分页与滚动、**RTL 与竖排滚动**；Roadmap 为 EPUB 3 Media Overlays 与 Divina。官方称 "With **100+ applications**, it's the most popular toolkit for building reading applications on smartphones and tablets."（[readium.org/mobile](https://readium.org/mobile)，证据日期 2026-11-02）

**Readium TS 的定位（必须注意）**：官方 README 自述 "Next generation SDK for publications in **Web Apps**"，只提供三个包（shared / navigator-html-injectables / navigator）。它**不覆盖 PDF、MOBI、TXT**，也没有打包/解析层。因此无法单独充当「全格式阅读器内核」。

**Readium 的真正价值（建议采纳的部分）**：① **Locator 定位模型**作为跨端进度与标注的交换格式（见 4.3）；② **Readium CSS** 作为排版/主题参考实现；③ 若移动端降级为原生方案，**Kotlin/Swift toolkit 是唯一有百级应用验证的选择**。

### 3.4 自研渲染引擎

**否决**。EPUB 的 CSS 支持面、CFI 实现、分页算法、竖排/RTL、字体混淆（IDPF 去混淆需要 SHA-1）、固定版式、CBZ 等加起来是**年**级工程，且无差异化收益（用户不会因为「分页算法是自己写的」而付费）。DESIGN.md 1.2 已明确不做移动端原生渲染内核自研，这里进一步建议**连 Web 端内核也不自研**。

### 3.5 渲染引擎对比与推荐

| 候选 | 许可 | 格式覆盖 | 定位模型 | 活跃度 | 结论 |
|---|---|---|---|---|---|
| **foliate-js（fork 自持）** | MIT | EPUB / MOBI / KF8 / FB2 / CBZ / PDF（实验，需 pdf.js） | 内置 `epubcfi.js` | 上游 2026-05-01 后停滞；Readest fork 2026-10-26 活跃 | ✅ **首选内核** |
| pdf.js | Apache-2.0 | PDF | 非 EPUB | 极活跃 | ✅ **PDF 专用** |
| Readium TS toolkit | BSD-3 | EPUB（需服务端/打包层） | **Locator（规范）** | 很活跃（110 版本/2 年） | ✅ **采纳其 Locator 模型 + CSS 参考**，不作主内核 |
| epub.js | 见仓库 | EPUB | CFI | 停滞 | ❌ 否决 |
| Readium Kotlin / Swift | BSD-3 | EPUB2/3、FXL、PDF、有声书 | Locator | 活跃 | ⚠️ **仅在移动端降级原生时启用** |
| 自研 | — | — | — | — | ❌ 否决 |

**推荐组合**：渲染内核 = foliate-js（自持 fork）+ pdf.js；定位模型 = Readium Locator；排版参考 = Readium CSS；HTML 净化 = DOMPurify；安全边界 = 独立 origin 自定义协议 + 严格 CSP。

### 3.6 EPUB 内嵌内容的安全隔离（**本节是最重要的安全结论**）

foliate-js 官方 README 的 Security 一节原文：

> "EPUB books can contain **scripted content** (i.e. JavaScript in the e-book), which is potentially dangerous, and is **not supported by this library** because
> - It is currently impossible to do so securely due to the content being served from **the same origin (using `blob:` URLs)**.
> - Due to **[WebKit Bug 218086](https://bugs.webkit.org/show_bug.cgi?id=218086)**, the `allow-scripts` attribute is **required** on iframes, which renders iframe sandbox useless.
>
> It is therefore imperative that you use **Content Security Policy (CSP)** to block all scripts except `'self'`…"

来源：[foliate-js README · Security](https://github.com/johnfactotum/foliate-js)（证据日期 2026-11-02）

**WebKit Bug 218086 状态核实**：标题 "Same domain sandboxed iframe events blocked from parent listener without allow-scripts"，**Reported 2020-10-22**，本次抓取时状态为 **NEW**（未修复）。来源：[bugs.webkit.org](https://bugs.webkit.org/show_bug.cgi?id=218086)（证据日期 2026-11-02）

**对照 Readest 的实际做法**（`apps/readest-app/src-tauri/tauri.conf.json`，证据日期 2026-11-02）：

- 使用自定义协议 `asset:` / `http://asset.localhost`，并另有 `rangefile:` 协议（`connect-src` 中出现 `http://rangefile.localhost`）。
- 主 WebView 的 `script-src` 为：`'self' 'unsafe-inline' 'unsafe-eval' data: blob: asset: http://asset.localhost https://*.sentry.io https://*.posthog.com https://*.stripe.com`。
- `connect-src` 白名单了 Supabase / Cloudflare Storage / 多个翻译服务 / Microsoft 端点。

> **必须指出的张力（事实陈述，非指控）**：foliate-js 官方要求 "block all scripts except `'self'`"，而 Readest 主文档的 `script-src` 含 `'unsafe-inline'`、`'unsafe-eval'`、`data:`、`blob:`。二者存在明显差距。**本文未验证 Readest 是否为书籍内容使用单独 origin/CSP**（见 6.2），因此不将其作为「Readest 不安全」的结论；但 HPF-Reader 自研时应采取更严格设计：

| 设计决策 | 推荐做法 | 理由 |
|---|---|---|
| 书籍内容来源 | **每本书使用独立 origin 的自定义协议**（如 `book-<bookId>://…`），而非 `blob:` 同源 | 让 iframe sandbox 重新具备意义；`blob:` 同源特性是 foliate-js 明确的失败原因 |
| 书籍文档 CSP | `default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self'` | EPUB 排版依赖内联 style，故 `style-src` 需放宽；但**脚本一律禁止** |
| SVG / 外部资源 | 一律视为不可信，禁止 `object`/`embed`/`iframe` 嵌套与远程 `@import` | 防止内容越权访问宿主 |
| 主应用 CSP | **不放 `'unsafe-eval'`**；`'unsafe-inline'` 仅在被 nonce/hash 取代前临时使用 | `'unsafe-eval'` 与 App Store 2.5.2 的「不得下载/执行代码」精神冲突（见 6.1） |
| Tauri 作用域 | 复刻 `allow_paths_in_scopes` 思路：只对用户已授权路径扩展 `fs_scope` / `asset_protocol_scope` | 阻断「通过恶意书籍内容自我提权读取用户主目录」 |
| 网络 | 书籍内容默认**无网络**（`connect-src 'none'`）；需要联网时由宿主代理 | 阻断追踪像素与外链数据外泄 |

> 上表是**设计建议**，不是已实现事实。依据为 foliate-js 官方 Security 说明 + WebKit Bug 218086 + Tauri 作用域机制。

### 3.7 排版与阅读实现要点（设计建议）

| 能力 | 实现要点 | 依据 |
|---|---|---|
| **分页 vs 滚动** | foliate-js 提供两个 renderer：`paginator.js`（reflowable 分页）与 `fixed-layout.js`（固定版式）；按书籍 `rendition:layout` 选择 | foliate-js README 模块清单 |
| **分栏/双栏** | 分页模式下由 CSS multi-column 或容器切分；Readest 用 `parallelViewStore` 支持双窗格。**双栏会改变每页字数，必须触发分页重算** | Readest architecture.md（Zustand store 列表） |
| **竖排 / RTL** | Readium Mobile 明确列出 RTL 与竖排滚动支持；Readest reader 层含 "vertical/Warichu support" 的内容变换服务 | [readium.org/mobile](https://readium.org/mobile)；architecture.md 3.3 |
| **注音（ruby）** | EPUB3 用 `<ruby>`；CJK 需处理 `ruby-position`/`ruby-align` 的 WebKit 差异——**具体兼容矩阵未验证** | 见 6.2 |
| **自定义字体** | Readest 有 `customFontStore`；字体加载需同时处理 **IDPF 字体去混淆**（foliate-js 指出需要 SHA-1，默认用 Web Crypto，**仅安全上下文可用**） | foliate-js README |
| **主题/CSS 覆盖** | 建议三层 CSS：书籍自带 → 用户样式（Readium CSS 风格）→ 宿主注入（强制覆盖）；注入层必须能压过书籍的 `!important` | 设计建议 |
| **固定版式（FXL）** | 用 `fixed-layout.js`，缩放与双页铺排需单独处理 | foliate-js 模块清单 |

---

## 4. 阅读体验层设计要点

### 4.1 横竖屏与多栏适配

| 场景 | 建议策略 |
|---|---|
| 手机竖屏 | 单栏 + 分页为主；上下滑动为辅（用户可切换并按书记忆） |
| 手机横屏 | 单栏加宽，或双栏（字距/行距自适应） |
| 平板横屏 | 双栏为主（Readest 支持 `parallelViewStore` 双窗格对照阅读） |
| 桌面宽窗 | 双栏 + 可拖拽分栏；窗口尺寸变化必须防抖触发分页重算 |
| 分页缓存键 | **必须包含**：viewport 尺寸、字号、字体、行距、边距、栏数、书写方向。任一变化即失效 |

> 设计建议。Readest 的 `readerStore`（active views / layout / ribbon）与 `parallelViewStore` 可作为状态划分参考（architecture.md 3.2 节）。

### 4.2 RTL 与竖排

- Readium Mobile 官方特性列表包含 "Support for right-to-left (RTL) and vertical scrolling"（[readium.org/mobile](https://readium.org/mobile)，证据日期 2026-11-02）。
- Readest 的 reader 层明确包含 "vertical/Warichu support" 的内容变换服务（architecture.md 3.3：`src/services/transformers`）。
- 建议：竖排与简繁转换实现为**内容变换层**（transform pipeline），而不是散落在渲染代码里——Readest 的 `src/services/transformers` 就是这个模式。

> **竖排/ruby 在各 WebView 的具体兼容问题：未验证**（见 6.2）。

### 4.3 定位：EPUB CFI vs Readium Locator（**架构级决策**）

| 方案 | 优点 | 缺点 | 建议 |
|---|---|---|---|
| **EPUB CFI** | EPUB 标准；foliate-js 内置 `epubcfi.js`；精度高、可定位到字符 | 只适用于 EPUB 系格式；TXT/PDF/CBZ 无 CFI；字符串冗长，跨引擎实现可能有差异 | 作为**渲染器内部**的定位表达 |
| **Readium Locator** | Readium 官方规范，**面向「可存储、可共享」设计**；字段为 `href` + `type` + `title` + `locations` + `text`；被 Swift/Kotlin/TS 三端 toolkit 共同采用 | 精度依赖 `locations.fragments`/`progression`/`position` 组合；非 EPUB 格式需自行定义 `href` 语义 | 作为**跨端同步与持久化**的交换格式 |

Readium Locator 规范原文要点（[readium.org/architecture/models/locators](https://readium.org/architecture/models/locators/)，证据日期 2026-11-02）：

- 每个 locator **必须**包含资源的 `href` 与 `type`；`href` **不得**指向资源内的 fragment（fragment 必须放 `locations.fragments`）。
- 可选 `title`、`locations`、`text`。
- 用途明确列出：报告与保存当前进度、书签、高亮与标注、搜索结果、可分享引用、跳转、增强目录。

> **推荐双表示**：渲染器内部用 CFI（对 EPUB）保证精度；同步/持久化/导出统一转成 Locator。好处：① 未来移动端若改用 Readium Kotlin/Swift，进度数据**无需迁移**；② 天然支持与 KOReader/第三方阅读器互通（DESIGN.md 4.4 的 P2 目标）。非 EPUB 格式（TXT/PDF/CBZ）需自定义 `href` + `locations` 语义，**规范未覆盖，属自有设计，需在 TECH-PLAN 定稿**。

### 4.4 标注高亮

| 要点 | 说明 |
|---|---|
| 渲染 | foliate-js 提供 `overlayer.js` 专门用于 "rendering annotations"（README 模块清单） |
| 存储 | 建议 Locator 的 `text`（前后文 + 高亮文本）+ `locations`（起点/终点）双字段，以便**重排后重新锚定** |
| 冲突 | 同一段被多设备标注 → 需要「按标注实体 ID 的集合合并」而非整篇覆盖（Readest replica sync 的「按类别 adapter + delta」就是这个思路） |
| 安全 | 标注文本是用户生成内容，渲染进宿主 UI 前**必须净化**（DOMPurify） |

### 4.5 TTS

Readest 的四后端 + 能力矩阵设计值得**直接采用其模式**（`TTSCapabilities`：`wordBoundaries`、`mediaClock`、`gapControl`、`liveRateChange`、`continuousTimeline`、`textHighlight`）：

| 后端 | 适用 | 优点 | 缺点 |
|---|---|---|---|
| Web Speech（`speechSynthesis`） | 浏览器 / 部分 WebView | 零成本、零部署 | **在嵌入式 WebView 中的可用性与一致性未验证**；控制粒度低 |
| 原生 TTS 插件 | Tauri 桌面/移动 | 系统语音、离线、稳定 | 需写平台插件（Readest 即自写 `tauri-plugin-native-tts`） |
| 服务端 TTS（如 Edge TTS） | 全平台 | 音质好、多语言一致 | 需网络与成本；Readest 用 `/api/tts/edge` 流式 |
| Media Overlay / 有声书 | EPUB3 MO / 本地音频 | 精确朗读同步 | 需音源；分句对齐是难点 |

> **建议**：不依赖 `speechSynthesis` 作为唯一路径；把 TTS 设计为**能力可降级的多后端**。Readest 还实现了「离线音频下载的持久队列」（`ttsDownloadManager` + `ttsDownloadStore`，缓存位于 `Cache/tts-cache/<bookHash>/`），是「后台任务 + 缓存」的实际参考。

### 4.6 分页缓存与性能

| 策略 | 说明 |
|---|---|
| 按需加载 | foliate-js 声明 "Does not require loading whole file into memory"；保持章节级按需解析 |
| 邻章预取 | 预加载当前章节前后各 1 章，避免翻页白屏 |
| 分页结果缓存 | 缓存 `(bookHash, sectionIndex, layoutKey) → 分页边界数组`；`layoutKey` 见 4.1 |
| 虚拟滚动 | Readest 同时使用 `react-virtuoso`、`react-window`、`virtua`，说明长列表需专门虚拟化 |
| 大文件 | Readest `src-tauri/src/transfer_file.rs` 做分块传输，并用 `rangefile:` 协议做范围读取——**大 PDF/大 EPUB 不应整文件进内存** |

---

## 5. 各平台交付形态与工程组织

### 5.1 Monorepo 建议（参考 Readest 已验证结构）

| 路径 | 职责 | 参考 |
|---|---|---|
| `apps/reader` | 主应用（Next.js + React，同时产出 Web/桌面/移动） | `apps/readest-app` |
| `packages/foliate-js` | **自持 fork（git submodule 或 vendor）** | `packages/foliate-js`（submodule） |
| `packages/*` | 自研共享库（简繁、词典、AI 客户端等） | `packages/simplecc-wasm`、`js-mdict`、`qcms` |
| `apps/koplugin` 等 | 生态插件（可后置） | `apps/readest.koplugin` |
| `server/` 或 `apps/api` | **自研后端**（替代 Readest 的 Supabase） | 与 Readest 的关键差异点 |
| `docs/` | 设计文档 | — |

**关键差异**：Readest 的后端就在 `apps/readest-app` 内部（Next.js API routes + Supabase）。HPF-Reader 要「自托管 + 多用户 + 配额 + 管理后台」，建议**后端独立成服务**（可由 Next.js API 起步，但数据层必须自己掌控），避免被 BaaS 绑定。

### 5.2 各平台交付与发布链路

| 平台 | 交付形态 | 签名/证书 | 分发渠道 | 证据参考 |
|---|---|---|---|---|
| Web | 静态导出 / SSR（Docker 自托管可选） | HTTPS 证书 | 自有域名 / Cloudflare | Readest：`next build` + `@opennextjs/cloudflare` + `docker/compose.yaml` |
| Windows | `nsis` 安装包（x64 / arm64） | **代码签名证书**（EV/OV 对 SmartScreen 的影响未验证） | 官网直下 / Microsoft Store | `build-win-x64`、`build-win-arm64` |
| macOS（非商店） | `dmg`（universal） | **Developer ID 签名 + 公证（notarization）** | 官网直下 | `tauri.macos-nonstore.conf.json` |
| macOS（商店） | `.app` → App Store | App Store 分发证书 + provisioning | Mac App Store | `tauri.appstore.conf.json` + `release-mac-appstore.sh` |
| iOS / iPadOS | `.ipa` → App Store / TestFlight | Apple Distribution + provisioning profile | App Store / TestFlight | `build-ios-appstore`、`submit-appstore-ios`（fastlane） |
| Android | `.aab`（上架）/ `.apk`（侧载） | **上传密钥 + Play App Signing** | Google Play / 官网 APK | `dev-android`、`release-google-play.sh` |
| Linux | `AppImage` / Flatpak / deb / rpm | 无强制签名 | 官网 / Flathub / AUR | `build-linux-x64`、`readest/flathub-readest` |
| 浏览器扩展（可选） | 打包 zip | 商店开发者账号 | Chrome Web Store 等 | `apps/readest-app/extension/send-to-readest` |

**按平台签名与发布是独立于功能的工程风险源**。OPEN-QUESTIONS Q6 建议「先把 Web/桌面跑通」，本文支持：iOS 链路（Xcode + 证书 + 公证 + 审核）本身就值得单独排一个里程碑。

### 5.3 CI 建议

| 环节 | 建议 |
|---|---|
| Lint / 类型 | `tsc --noEmit` + 格式化检查（Readest 用 Biome）+ `cargo clippy -D warnings` + `cargo fmt --check` |
| 单测 | Vitest（前端）+ Rust 单测（`cargo test -p <crate> --lib`） |
| 端到端 | Playwright（Web）+ WebDriver（Tauri）。Readest 两者都有（`test:e2e`、`test:e2e:web`、`test:tauri`） |
| 构建矩阵 | Linux runner 出 Web/AppImage；macOS runner 出 dmg/app/ipa；Windows runner 出 nsis；Android 可在 Linux runner |
| 产物分发 | Docker 镜像推 GHCR（Readest：`ghcr.io/readest/readest`，工作流 `docker-image.yml`） |
| 密钥管理 | 全部走 CI secrets；本地用 `dotenv` 切换 `.env.*.local`（Readest 模式），**`.env.*.local` 必须 gitignore** |
| 运行时配置 | 复刻 `/runtime-config.js` 思路：一个镜像通过运行时注入切换后端地址/对象存储/配额，避免「每次改配置都重新打包」 |

### 5.4 上架合规前置检查清单

| 检查项 | 结论/依据 |
|---|---|
| iOS 是否必须用 WebKit | **是**。App Store 指南 **2.5.6**："Apps that browse the web must use the appropriate WebKit framework and WebKit JavaScript. You may apply for an entitlement to use an alternative web browser engine… for the EU and Japan." → Tauri 在 iOS 用 WKWebView **天然合规**；Electron/CEF 方案在 iOS 上**不可行** |
| 能否下载/执行代码 | 高风险。指南 **2.5.2**："Apps should be self-contained in their bundles… **nor may they download, install, or execute code which introduces or changes features or functionality of the app**" → 任何「从网络下载脚本/插件并执行」的设计在 iOS 都是审核风险 |
| 阅读器类应用的外部购买入口 | 指南 **3.1.3(a) "Reader" Apps**：可访问已购内容/订阅（杂志、报纸、**书籍**、音频、音乐、视频）；可申请 External Link Account Entitlement；美国店面另有豁免规则 |
| 书源/第三方内容 | 指南 **4.7** 允许 HTML5/JavaScript mini apps 与 plug-ins 存在于二进制之外，但**开发者对所有此类软件负责**，且须满足 4.7.1–4.7.5（内容过滤、举报、屏蔽滥用用户等） → 直接决定 OPEN-QUESTIONS Q5：**商店版不应包含第三方侵权书源** |
| Android | Google Play 政策本次未逐条取证，见 6.2 |

来源：[Apple App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)（证据日期 2026-11-02）

---

## 6. 风险、坑与未知项

### 6.1 风险登记册

| # | 风险 | 触发条件 | 影响 | 概率 | 缓解措施 |
|---|---|---|---|---|---|
| R1 | **foliate-js 上游停滞/无 release** | 上游 2026-05-01 后无推送；无正式版本 | 引擎 bug 无法上游修复；API 不稳定 | 高 | fork 自持、锁定 commit、把与引擎的接口收敛到少数 adapter 层；预留持续维护人力 |
| R2 | **Android 老旧系统 WebView 白屏** | 华为机型、AOSP 无 Play、**e-ink 阅读器（Onyx Boox 等）** | 应用完全不可用 | 中高 | 复刻 Readest 的 WebView 升级插件思路；启动时探测当前 WebView 包并给出引导；或对这些设备降级原生渲染 |
| R3 | **多 WebView 引擎导致排版不一致** | Windows=WebView2、macOS/iOS=WKWebView、Linux=WebKitGTK、Android=系统 WebView | 同一本书跨端断行/分页/字体不同；同步位置偏移 | 高 | 位置用 Locator + 文本上下文双保险；建立跨引擎渲染回归测试集；考虑 Linux 捆绑 CEF（成本高，可行性未验证） |
| R4 | **EPUB 脚本内容的 XSS/提权** | 恶意 EPUB 含 JS；iframe sandbox 在 WebKit 上因 Bug 218086 失效 | 读取用户文件、外泄数据 | 中 | 独立 origin 自定义协议 + `script-src 'none'` + Tauri 作用域闸门（见 3.6） |
| R5 | **iOS 审核 2.5.2（下载/执行代码）** | 任何「下载书源规则/插件并执行」的功能 | 无法上架 | 中 | 书源规则限定为**声明式 JSON**（DESIGN.md 4.5 已如此规划）；商店版关闭第三方源；不做动态脚本执行 |
| R6 | **iOS 审核 3.1.3(a) 外部购买链接** | 在 App 内引导用户到站外订阅 | 拒审 | 中 | 商店版不出现站外购买引导；如需要则申请 External Link Account Entitlement |
| R7 | **iOS 沙盒限制本地书库** | 用户期望「像桌面一样扫描整个书库目录」 | 功能预期落差 | 高 | 明确 iOS 采用 document picker / 分享 / 应用容器；文档写清平台差异；不做无法实现的承诺 |
| R8 | **移动端后台任务受限** | 大文件下载、TTS 音频生成需后台执行 | 任务中断、体验差 | 高 | 参考 Readest 的「持久化下载队列 + 下次进入阅读会话时续跑」；不假设后台可常驻 |
| R9 | **Tauri 移动 DX 低于桌面** | 官方自认（2024-10-02）；移动端插件不全 | 开发速度与调试成本上升 | 高 | 排期给移动端**额外缓冲**；先做 Web/桌面（OPEN-QUESTIONS Q6 的 A/D） |
| R10 | **PDF 大文件内存/性能** | 300MB 扫描版 PDF | 崩溃或卡顿 | 中 | 范围读取（`rangefile` 协议思路）+ pdf.js 分片 + 不做全文件载入 |
| R11 | **AGPL 传染** | 直接复制 Readest 代码 | 本项目须 AGPL 开源 | 高（若参考代码） | 只参考**架构思路**，不复制代码；foliate-js 为 MIT，可安全 fork（回答 Q4） |
| R12 | **AI/LLM 成本与合规** | 整书翻译、RAG 向量化 | 成本失控 | 中 | BYOK + 服务端默认低价模型 + 缓存（非本文件范围，交叉引用 LLM 调研文档） |

### 6.2 明确的「未验证 / 不确定」清单

以下内容**本文没有取得可验证证据**，因此不作结论，需在 TECH-PLAN 阶段补证：

1. **Flutter / React Native / Kotlin Multiplatform 的当前版本号与官方平台支持矩阵**（未从官方渠道取证）。
2. **各框架的实际安装包体积数字**（未实测；本文只依据「是否捆绑浏览器引擎」作定性判断）。
3. **Tauri 官方插件的逐平台支持矩阵**（[tauri.app/plugin](https://tauri.app/plugin/) 的 Support Table 是交互式表格，本次未逐行取证）。
4. **Web Speech API（`speechSynthesis`）在 WKWebView / Android System WebView 中的可用性与一致性**。
5. **iOS Safari / WKWebView 对 File System Access API 的支持状态**。
6. **Readest 是否为其书籍内容使用独立的 origin / 独立 CSP**（仅确认主 WebView 的 CSP 含 `'unsafe-eval'`；不能据此推断书籍内容的安全性）。
7. **`packages/tauri-runtime-cef-stub` 的实际用途**（目录存在，但本次未读取其内容即下结论）。
8. **Tauri Verso（Servo）运行时是否已可用于生产**（2025-03-17 官方称实验性，此后状态未追踪）。
9. **WebKit Bug 218086 在 2026 年的实际影响范围**（页面状态显示 NEW，但未确认所有 iOS 版本均复现）。
10. **EPUB3 `<ruby>` 注音在五大 WebView 的兼容性与 `ruby-align`/`ruby-position` 差异**。
11. **Google Play 关于阅读器/第三方内容的具体政策条款**（本次只取证 Apple 一侧）。
12. **Windows 代码签名（EV/OV）对 SmartScreen 警告的实际影响**。
13. **Anx Reader 的许可协议**（本文只核对其 `pubspec.yaml` 技术栈，未核对 LICENSE 文本）。
14. **Koodo Reader 的移动端实现方式**：其 `package.json` 明确是 Electron（含 `electron-is-dev`、`electron-log`、`electron-store`、`better-sqlite3`），但官网声称支持 Android/iOS——**移动端如何实现未验证**。

---

## 7. 最终推荐

### 7.1 首选方案：Tauri v2 + TS/React 单代码库 + 自持 foliate-js

| 层 | 选型 | 核心理由（可验证） |
|---|---|---|
| 客户端壳 | **Tauri v2** | 唯一同时满足「6 端一份代码」（D1=5、D9=5）且包体小的方案；有 Readest 这个 2.6 万星的**生产级同构案例**（已上架 App Store / Google Play） |
| 前端 | **Next.js + React + TypeScript**（与 Readest 同栈） | Web 端复用率最高（D11=5）；生态最大 |
| 状态/数据 | Zustand 多 store + 本地 SQLite（WASM / 原生插件） | 参考 Readest 的 store 划分与三实现数据库抽象 |
| 渲染内核 | **foliate-js（MIT，fork 自持）** + **pdf.js** | 单引擎覆盖 EPUB/MOBI/KF8/FB2/CBZ/PDF；MIT 允许闭源（回答 Q4）；上游不稳定→必须自持 |
| 定位模型 | **内部 CFI + 对外 Readium Locator** | 跨端同步；未来切换原生 toolkit 无需迁移数据 |
| 排版 | 参考 **Readium CSS**；自建「三层 CSS」覆盖 | — |
| 安全 | 独立 origin 自定义协议 + `script-src 'none'` + Tauri 作用域闸门 | 依据 foliate-js 官方 Security 警告与 WebKit Bug 218086 |
| Web 交付 | 同一份前端代码出 Web + 自托管 Docker | 参考 Readest 的 `/runtime-config.js` 运行时注入 |
| 移动端 | 先 Tauri mobile；**M2 前必须完成 Android 老旧 WebView + iOS 上架专项验证** | R2/R9 是硬风险，必须先验证再大规模投入 |

**为什么是首选**：它是唯一在阅读器场景下同时通过 6 项高权重维度（D1=5、D2=5、D7=5、D9=5、D11=5，且 D3/D5/D6/D8 至少 3 分）的方案，且有 Readest 这样一个**当天仍在提交**的开源实现作为可行性证据。它最大的代价（引擎自持、移动端 DX、WebView 碎片化）是**已知且可量化的**，而不是未知风险。

### 7.2 备选方案

| 备选 | 触发条件 | 方案内容 | 代价 |
|---|---|---|---|
| **备选 A：移动端原生双栈** | Tauri mobile 在 M2 仍无法同时满足「iOS 可上架 + Android 老旧 WebView 可用」（R2/R9 成真） | Web + 桌面继续 Tauri + React + foliate-js；**iOS 用 Readium Swift toolkit，Android 用 Readium Kotlin toolkit**（BSD-3，100+ 应用验证） | 渲染层两份实现；但 Locator 定位模型与后端协议**不需要改**（这正是 4.3 选 Locator 的价值） |
| **备选 B：Capacitor（放弃桌面原生壳时）** | 目标收缩为「移动 + Web」，桌面接受 Web 或 Electron 打包 | Capacitor 8.x + 同一份 React 代码 + foliate-js | 桌面端需额外壳；后台任务与文件系统能力弱于 Tauri |
| **备选 C：先做 Web + PWA（快速验证）** | 目标是「最快让 1–5 个用户用起来」（OPEN-QUESTIONS Q2 选 A） | 纯 Web 应用 + PWA 安装 + 自托管后端 | 无法满足「本地大书库 + 离线大文件」（D5=1、D6=1）；仅作验证手段，不是终态 |

> **备选优先级：A > B > C。** 备选 A 与首选共用前端与协议，切换成本最低——这是把「移动端风险」隔离成可替换模块的设计。

### 7.3 被否方案与理由

| 被否方案 | 否决理由（可验证证据） |
|---|---|
| **Electron（作为全平台主方案）** | **无官方 iOS/Android 支持**（D1=2）。它可以在桌面做到最好（D2/D3/D5/D6 全 5），但「全平台」是项目第一目标。另有包体代价（捆绑 Chromium + Node）。注意：**Thorium Reader**（EDRLab，3.6.0-beta.1，Electron + Readium，面向 Windows/macOS/Linux）与 **Koodo Reader**（2.4.7，Electron + React）都是成功的**桌面**阅读器——所以否决的是「作为全平台方案」，不是否定 Electron 本身 |
| **Flutter** | EPUB 渲染最终仍要嵌 WebView（`flutter_epub_viewer` 自述 "combining the power of Epubjs and flutter_inappwebview"），此时已放弃「自绘引擎一致渲染」的核心优势；pub.dev 阅读生态薄（`epubx` 2023-06 停更、`epub_parser` 2022-04 停更）；真实案例 Anx Reader 需 fork 3 个依赖。且 Readium 官方**无 Flutter toolkit** |
| **React Native + Expo** | Readium 官方 toolkit **无 React Native**（awesome-readium 官方清单只有 Swift/Kotlin/TS/Go）；无桌面端官方方案（D1=4、D9=3）；EPUB 渲染同样要嵌 WebView |
| **Kotlin Multiplatform** | 渲染层最弱（D3=2、D4=2）：Readium Kotlin 仅 Android（min SDK 24）、Readium Swift 仅 Apple，选 KMP 等于**两端各写一次渲染集成**；Web 与桌面的 EPUB 渲染无共享方案；D10=2 |
| **纯 PWA（作为独立终态）** | D5=1、D6=1：WebKit 存储策略下 origin quota 对非浏览器应用约 **15% 磁盘**、overall 约 **20%**，且存在 LRU 驱逐（"Storage Eviction… the data of an origin will be deleted as a whole… least-recently-used policy"，[WebKit, 2023-08-10](https://webkit.org/blog/14403/updates-to-storage-policy/)）；iOS 无 File System Access、后台同步受限。**无法承载「本地大书库 + 离线大文件」**。但 PWA 应作为 **Web 端增强**（Home Screen Web App 可获得与浏览器应用同等配额，官方原文明确），而不是被完全放弃 |
| **自研渲染引擎** | 工程量以年计，无差异化收益；DESIGN.md 1.2 已明确不做 |
| **epub.js 作为内核** | npm 最新稳定版 **0.3.93 发布于 2022-02-16**，包最后修改 2023-09-26；仓库 516 个 open issue；不支持 MOBI/PDF/CBZ/TXT |
| **Fork Readest 本体** | Readest 为 **AGPL-3.0**；且强绑定 Supabase + Stripe + IAP，与「自托管、可脱离商业 SaaS」冲突。**参考架构而不复制代码**是更优解（回答 Q4 选项 C） |

### 7.4 分阶段落地建议（与 OPEN-QUESTIONS Q6 对齐）

| 阶段 | 目标 | 客户端范围 | 出口标准 |
|---|---|---|---|
| M1 | 让「能读书」跑起来 | **Web + Windows/macOS 桌面**（Tauri 桌面） | 打开 10MB EPUB 首屏可读；分页/滚动、目录、主题、字体、进度持久化 |
| M2 | 同步与标注闭环 | 上述 + **Android** | 跨设备进度/高亮同步；**完成 Android 老旧 WebView 专项验证**（R2）；确定移动端是否继续 Tauri |
| M3 | 移动端完整化 | **+ iOS/iPadOS** | iOS 上架链路跑通（含 2.5.2 / 3.1.3(a) / 4.7 合规自查）；TTS 多后端可用 |
| M4 | 扩展与差异化 | 全平台 | PDF 标注、书源插件（声明式）、LLM 实体归一化（交叉引用 LLM 调研文档） |

**M2 的「Android 老旧 WebView 专项验证」是本项目客户端侧最关键的 Go/No-Go 决策点**：它决定移动端继续走 Tauri 还是切到备选 A（Readium 原生双栈）。建议在 M1 期间就用一台 Onyx Boox 或 AOSP 设备做最小验证。

---

## 附录 A · 证据索引（链接 + 证据日期）

| # | 来源 | 链接 | 证据日期 |
|---|---|---|---|
| A1 | Readest 仓库元数据（stars/forks/license/推送时间） | https://api.github.com/repos/readest/readest | 2026-11-02 |
| A2 | Readest README（定位、格式列表、下载渠道） | https://github.com/readest/readest/blob/main/README.md | 2026-11-02 |
| A3 | Readest 架构文档（运行时边界、AppService、同步三路径、TTS 四后端、构建发布） | https://github.com/readest/readest/blob/main/apps/readest-app/docs/architecture.md | 2026-11-02 |
| A4 | Readest 主应用依赖与脚本 | https://github.com/readest/readest/blob/main/apps/readest-app/package.json | 2026-11-02 |
| A5 | Readest Tauri 配置（CSP、capabilities、自定义协议） | https://github.com/readest/readest/blob/main/apps/readest-app/src-tauri/tauri.conf.json | 2026-11-02 |
| A6 | readest Organization 仓库列表 | https://api.github.com/orgs/readest/repos | 2026-11-02 |
| A7 | tauri-plugin-webview-upgrade README（Android WebView 白屏问题） | https://github.com/readest/tauri-plugin-webview-upgrade | 2026-11-02 |
| A8 | foliate-js 上游仓库与 README（格式、稳定性、Security） | https://github.com/johnfactotum/foliate-js | 2026-11-02 |
| A9 | npm: foliate-js（非官方发布者） | https://registry.npmjs.org/foliate-js | 2026-11-02 |
| A10 | npm: epubjs（0.3.93 / 2022-02-16） | https://registry.npmjs.org/epubjs | 2026-11-02 |
| A11 | npm: @readium/navigator 等 | https://registry.npmjs.org/@readium%2Fnavigator | 2026-11-02 |
| A12 | Readium awesome-readium（官方 toolkit 清单，无 RN/Flutter/KMP） | https://readium.org/awesome-readium/ | 2026-11-02 |
| A13 | Readium Mobile 能力与 Roadmap | https://readium.org/mobile | 2026-11-02 |
| A14 | Readium Kotlin toolkit README（格式/特性矩阵、min SDK） | https://github.com/readium/kotlin-toolkit/blob/develop/README.md | 2026-11-02 |
| A15 | Readium TS toolkit README（Web 定位） | https://github.com/readium/ts-toolkit | 2026-11-02 |
| A16 | Readium Locator 规范 | https://readium.org/architecture/models/locators/ | 2026-11-02 |
| A17 | Tauri 2.0 稳定版发布文（移动支持、DX 自评、插件不全、Roadmap） | https://tauri.app/blog/tauri-20/ | 2024-10-02 |
| A18 | Tauri 2.12 发布文（MSRV、移动 dev server、权限请求） | https://tauri.app/blog/tauri-2.12/ | 2026-09-26 |
| A19 | Tauri Verso 实验集成（Servo 运行时，实验性） | https://tauri.app/blog/tauri-verso-integration/ | 2025-03-17 |
| A20 | Tauri 生态版本总览（2.12.3 / 2026-10-10） | https://tauri.app/release/ | 2026-11-02 |
| A21 | Tauri 前置依赖（Linux WebKitGTK 4.1 / macOS Xcode / Windows WebView2） | https://v2.tauri.app/start/prerequisites/ | 2026-11-02 |
| A22 | Tauri 插件目录与 Support Table | https://tauri.app/plugin/ | 2026-11-02 |
| A23 | npm: electron 45.2.1 | https://registry.npmjs.org/electron | 2026-11-02 |
| A24 | npm: @capacitor/core 8.6.0 | https://registry.npmjs.org/@capacitor/core | 2026-11-02 |
| A25 | pub.dev: epub_view / flutter_epub_viewer / epubx / vocsy_epub_viewer | https://pub.dev/api/packages/epub_view | 2026-11-02 |
| A26 | Anx Reader pubspec.yaml（Flutter + inappwebview + fork 依赖） | https://github.com/Anxcye/anx-reader/blob/main/pubspec.yaml | 2026-11-02 |
| A27 | Koodo Reader package.json（Electron 技术栈） | https://github.com/koodo-reader/koodo-reader/blob/master/package.json | 2026-11-02 |
| A28 | Thorium Reader package.json（Electron + Readium，3.6.0-beta.1） | https://github.com/edrlab/thorium-reader/blob/develop/package.json | 2026-11-02 |
| A29 | Apple App Store Review Guidelines（2.5.2 / 2.5.6 / 3.1.3(a) / 4.7） | https://developer.apple.com/app-store/review/guidelines/ | 2026-11-02 |
| A30 | WebKit Bug 218086（iframe sandbox，状态 NEW） | https://bugs.webkit.org/show_bug.cgi?id=218086 | 报告 2020-10-22；抓取 2026-11-02 |
| A31 | WebKit 存储策略（配额与驱逐） | https://webkit.org/blog/14403/updates-to-storage-policy/ | 2023-08-10 |
| A32 | WebKit Web Push for Home Screen web apps（iOS 16.4） | https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ | 2023-02-16 |
| A33 | GitHub REST API 速率限制（本次调研中触发，已改用 jsDelivr/官方站点补证） | https://api.github.com/rate_limit | 2026-11-02 |

> **取证方法备注**：`web_search` 内置工具在本次会话中不可用（端点未配置），全部检索改用 SearXNG MCP；GitHub REST API 在调研中段触发匿名速率限制（60 次/小时），改用 jsDelivr CDN（`cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/<path>`）与官方站点补证。凡因限额或工具限制未能取证者，均列入 6.2。

## 附录 B · 对 docs/DESIGN.md 与 OPEN-QUESTIONS.md 的直接回应

| 待决问题 | 本文件的证据结论 |
|---|---|
| **Q3 是否上架商店** | 上架**可行**（Tauri 在 iOS 用 WKWebView，符合 2.5.6）。但 2.5.2（不得下载/执行代码）与 4.7（第三方软件责任）意味着**商店版必须关闭第三方书源与非声明式插件**。建议采纳 Q3 选项 C（双版本），且差异做成**编译期开关**而非运行时下载 |
| **Q4 Fork Readest 还是自研** | **强烈建议不要 fork Readest 本体**（AGPL-3.0 + Supabase/Stripe/IAP 强绑定，与「自托管」目标冲突）。建议 Q4 选项 **C**：自研客户端，**foliate-js 已核实为 MIT**（GitHub API `license.spdx_id = MIT`），可安全 fork 并闭源；架构思路借鉴 Readest 但不复制代码 |
| **Q6 平台优先级** | 支持 **A（Web → 桌面 → 移动）** 或 **D（Web + 桌面并行，移动延后）**。证据：移动端风险是**独立的**（R2 Android WebView 白屏、R7 iOS 沙盒、R9 Tauri 移动 DX），且 Tauri 官方自认移动 DX 未达桌面水平（A17） |
| **DESIGN.md 1.2「用 WebView 方案」** | **确认可行且是正确取舍**：D2（EPUB 保真度）只有在 WebView 里才能达到浏览器级；Flutter/RN/KMP 想要同等级保真度**最终也要嵌 WebView**（A25/A26） |
| **DESIGN.md「渲染层基于成熟的 foliate-js 生态」** | 需要**修正措辞**：foliate-js 上游自称 "**not stable**"、"**no release**"（A8），它**不是「成熟库」**，而是「功能可用但 API 不稳定的库」。方案中必须写明 **fork 自持 + 锁定 commit + adapter 隔离**（R1） |

---

**文档结束** · 如需补充实测数据（包体、帧率、跨引擎渲染回归、iOS 专项验证），建议在 M1 阶段产出 docs/research/10b-client-benchmark.md。
