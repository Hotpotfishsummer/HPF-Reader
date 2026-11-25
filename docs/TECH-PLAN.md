# HotPotFish Reader 技术方案（v0.2 · 待评审）

> 状态：**待用户确认**。本阶段不写业务代码。
> 配套：docs/DESIGN.md（产品设计）、docs/OPEN-QUESTIONS.md（待确认决策）、docs/research/*（调研证据）
> 关键前置假设：服务器可装 Docker；客户端允许使用 WebView 方案；渲染内核采用 MIT 许可的 foliate-js。

---

## 1. 总体架构

~~~mermaid
flowchart TB
    subgraph Clients["客户端（一份 TS 代码库，多目标）"]
        Web["Web SPA<br/>浏览器 + PWA"]
        Desk["桌面<br/>Tauri v2 (Win/macOS/Linux)"]
        Mob["移动<br/>Tauri v2 (Android/iOS)"]
    end

    subgraph Local["客户端本地层（离线优先）"]
        R["渲染层 foliate-js + pdf.js"]
        DB["本地 SQLite<br/>(native sqlite / wa-sqlite+OPFS)"]
        OB["同步 Outbox 队列"]
        FS["文件缓存<br/>(OPFS / appData)"]
    end

    subgraph Server["自托管后端（模块化单体，Docker）"]
        GW["Caddy<br/>TLS / 反代 / 静态资源"]
        API["API 服务 (Fastify + TS)"]
        SYNC["同步引擎<br/>push/pull/changelog"]
        AI["AI 网关<br/>翻译/实体/摘要/RAG"]
        SRC["书源规则引擎"]
        WK["任务队列 (BullMQ)"]
    end

    subgraph Data["数据层"]
        PG[("PostgreSQL<br/>用户/书库/进度/标注")]
        RD[("Redis<br/>缓存/队列/限流")]
        S3[("MinIO / S3<br/>书籍文件/封面")]
    end

    subgraph Ext["外部服务（可替换）"]
        LLM["LLM: DeepSeek / OpenAI / Ollama"]
        LEGAL["合法书源: Gutenberg / OpenLibrary / IA / OPDS"]
        META["元数据: Google Books / OpenLibrary"]
    end

    Web --> R
    Desk --> R
    Mob --> R
    R --> DB
    DB --> OB
    DB --> FS
    OB -->|HTTPS| GW
    Web --> GW
    Desk --> GW
    Mob --> GW
    GW --> API
    API --> SYNC
    API --> AI
    API --> SRC
    API --> WK
    SYNC --> PG
    AI --> PG
    AI --> LLM
    SRC --> LEGAL
    API --> S3
    API --> RD
    WK --> S3
    API --> META
~~~

**架构要点**
1. **离线优先**：客户端本地 SQLite 是「用户操作的第一落点」，网络只是复制通道。断网时全部功能可用（除下载/AI/书源）。
2. **一份代码多目标**：业务代码只写一遍，平台差异收敛在 `服务抽象层` 与构建配置里。
3. **后端是模块化单体**：先不拆微服务。同步、AI、书源、书库是同一进程内的模块，通过接口隔离，未来可独立拆出。
4. **可替换外部依赖**：LLM、对象存储、书源都走接口，避免被单一供应商锁定。

---

## 2. 技术选型总表

| 层 | 首选 | 备选 | 选择理由 | 主要风险 |
|---|---|---|---|---|
| 客户端语言 | TypeScript 5.x（前端）+ **Go 1.26+**（外壳与本地核心） | — | 外壳改为 Wails 后 Go 成为必需；前端仍是 TS | 两门语言并行，CI 与规范需同时覆盖 |
| 客户端框架 | **Vue 3 + Vite** | Nuxt（若需 SSR/SEO） | 阅读器是重交互 SPA；Vue 组合式 API 在大量局部 UI 状态下更省样板（用户决策，见 ADR-002） | 生态小于 React；foliate-js 需按 markRaw/shallowRef 约定接入 |
| 跨端壳 | **Wails v3（Go）** | Tauri v2 / Electron | 内置签名、安装器与 updater；可能共用 server build 做 Web；本机免装 Rust | **iOS/Android 官方标注 experimental**（闸门 G1）；子 frame 可触达原生绑定（闸门 G2）；周更节奏需锁版本 |
| Web 形态 | SPA + PWA（Service Worker）；**优先复用 Wails server build** | 独立前端产物 + 后端 API | 一套代码多端；server build 若可用则 Web 与桌面同源 | server build 的多用户可用性待 task-4 核实；浏览器无本地 SQLite 时离线能力受限 |
| 渲染内核 | **foliate-js（MIT）**，EPUB/FB2/MOBI(AZW3)/CBZ/TXT | Readium ts-toolkit(BSD-3) / 自研 | MIT 可闭源商用；被 Foliate 与 Readest 生产验证；格式覆盖最广 | **上游不承诺稳定**（README 自称 not stable、无 release、约 6 个月无提交，npm 上同名包非作者发布）→ **必须 fork 自持 + 固定 commit** |
| PDF 渲染 | **pdf.js（Apache-2.0）** | PDFium / MuPDF | 纯 JS、跨端一致、文本层可选 | 大文件内存占用 |
| 本地数据库 | **Go 侧 SQLite（纯 Go 驱动，免 cgo）**，经 bindings 暴露给 Vue | WASM SQLite（仅 Web 端需要） | 真正的 SQLite；无 OPFS / SharedArrayBuffer / COOP-COEP 复杂度；桌面与移动共用 | 驱动选型与 bindings 设计待 task-6 回填 |
| 前端状态 | Pinia（UI 状态）+ TanStack Query 的 Vue 适配（服务端状态） | Vuex | Pinia 更适合中大型状态；同步队列**不走** Query 缓存 | 同步引擎状态需独立 store |
| UI 组件 | **Reka UI（Radix 的 Vue 移植）+ Tailwind CSS** | Naive UI / Element Plus | 无样式锁定、易做阅读器主题定制、包体可控 | 需自建设计系统；Reka UI 生态小于 Radix |
| 后端运行时 | **待定：Go（与外壳共用同步核心）vs TypeScript** | Node + Fastify / NestJS | 见 task-6 结论与 ADR-002 第 4 节的语言收敛策略 | 选错会导致合并逻辑出现两份实现 |
| 校验/契约 | **以 OpenAPI 为唯一契约**（由后端生成，前端生成类型化客户端） | zod（仅 TS 侧） | 后端语言未定时，OpenAPI 是唯一中立方案 | 需要代码生成步骤 |
| ORM/迁移 | **待定**：Go 侧 sqlc + goose/atlas ｜ TS 侧 Drizzle | Prisma | 取决于后端语言决策 | 迁移必须与镜像解耦（独立 runner） |
| 数据库 | **PostgreSQL 16** | SQLite（仅单机极简场景） | 并发、JSONB、FTS、pgvector、RLS 全都有 | 需要运维（备份） |
| 缓存/队列 | Redis 7 + **asynq/river（Go）或 BullMQ（TS）** | Postgres 轮询队列 | 翻译/转换/封面/抓取需要重试与限流 | 增加一个组件 |
| 对象存储 | **MinIO**（S3 兼容） | 本地磁盘目录 / 云 OSS | 自托管、S3 API、易迁移、支持分片上传 | 需磁盘容量规划 |
| 反向代理/TLS | **Caddy** | Nginx + certbot | 自动 HTTPS、配置极简 | 高级流量控制不如 Nginx |
| 认证 | 自研 JWT（access 15min + refresh 30d 轮换）+ Argon2id | better-auth / Keycloak | 完全可控、无额外依赖 | 需自行实现安全细节（限流、锁定、审计） |
| 搜索 | Postgres FTS（中文加 pg_bigm/zhparser） | Meilisearch | 先零成本起步 | 中文分词与规模上限 |
| 向量检索 | pgvector | Qdrant | 与主库同源，运维简单 | 规模大时性能下降 |
| AI 接入 | OpenAI 兼容协议（DeepSeek / OpenAI / Ollama 通吃） | 各家 SDK | 一套客户端适配所有供应商 | 各家参数差异需适配层 |
| 部署 | Docker Compose | K8s / Nomad | 单机即可生产，迁移简单 | 单点故障（靠备份+镜像化缓解） |
| 监控 | Prometheus + Grafana + Loki，或 Uptime Kuma 起步 | Sentry 自托管（错误） | 先可用再完善 | 运维负担 |
| 测试 | Vitest + Vue Test Utils（前端）、Playwright（Web E2E）、Go test（外壳/本地核心）、Wails 构建冒烟 | — | 覆盖四层 | Wails 移动端自动化测试较弱 |

---

## 3. 前端技术方案

### 3.1 代码库组织（pnpm workspace monorepo）

~~~
hpf-reader/
├── apps/
│   ├── app/                 # 客户端主应用（React + Vite，同时被 Tauri 与浏览器加载）
│   │   ├── src/
│   │   │   ├── app/         # 路由与页面壳
│   │   │   ├── features/    # 按领域切分：library / reader / sync / ai / sources / settings / auth
│   │   │   ├── components/  # 通用 UI 组件（设计系统）
│   │   │   ├── platform/    # 平台抽象：fs / db / tts / share / secure-storage 的 web 与 native 实现
│   │   │   ├── stores/      # Zustand stores
│   │   │   ├── db/          # 本地 SQLite schema + repository
│   │   │   └── styles/      # Tailwind + 阅读器主题变量
│   │   ├── src-tauri/       # Tauri Rust 壳（commands、插件、权限配置、移动端配置）
│   │   └── index.html
│   ├── web/                 # （可选）落地页/文档站，与主应用分离
│   └── server/              # 后端 Fastify 应用
│       └── src/
│           ├── modules/     # auth / users / books / storage / sync / annotations / ai / sources / admin
│           ├── db/          # Drizzle schema + migrations
│           ├── plugins/     # Fastify 插件（auth、ratelimit、metrics、error）
│           └── workers/     # BullMQ 任务处理器
├── packages/
│   ├── shared/              # 前后端共享：Zod schema、领域类型、常量、错误码
│   ├── api-client/          # 由 OpenAPI 生成的类型化客户端（含 SSE 支持）
│   ├── reader-core/         # 渲染与排版（封装 foliate-js，含主题注入、CFI/Locator 工具）
│   └── ui/                  # 设计系统（可选，先内联在 app 中）
├── docker/                  # compose、Caddyfile、备份脚本
└── docs/
~~~

### 3.2 跨端策略

**同一份 React 代码，三个宿主：**
- **浏览器（Web/PWA）**：直接 `vite build` 产物；Service Worker 缓存应用外壳；文件存 OPFS；无本地文件系统权限，通过 File System Access API（Chrome）或上传/下载兜底。
- **桌面（Tauri v2）**：WebView 加载同一产物；Rust 侧提供文件扫描、系统关联、全局快捷键、托盘、加密存储、更新器。
- **移动（Tauri v2 mobile）**：同上；额外处理安全区、返回手势、后台任务限制、分享入口（Intent/Share Extension）。

**关键抽象（必须在 M1 就定好，否则后期返工）**：
~~~ts
// packages/shared 或 app/src/platform 中的接口示意（设计性伪代码，非实现）
interface PlatformFs {
  pickFiles(): Promise<LocalFile[]>
  readChunk(handle: FileHandle, offset: number, len: number): Promise<Uint8Array>
  writeAppData(path: string, data: Blob): Promise<void>
  scanFolder?(dir: string): AsyncIterable<LocalFile>   // 仅桌面
}
interface PlatformDb { exec(sql: string, params: unknown[]): Promise<void>; query<T>(sql, params): Promise<T[]> }
interface PlatformTts { speak(text, opts): Promise<void>; stop(): void }
interface PlatformSecureStore { get(k): Promise<string|null>; set(k, v): Promise<void> }
~~~
运行时按 `isTauri()` 选择实现，业务代码**永不直接调用** `@tauri-apps/api` 或 `localStorage`。

### 3.3 渲染与排版层（reader-core）

**解析与分页内核采用 foliate-js（MIT），不自研解析层。**

**foliate-js 的已知硬约束（必须写进工程规范，否则会踩坑）**
- **无正式 release、API 可能随时变** → 以 **git submodule 固定 commit** 引入，升级前跑完整格式回归；
- **不支持 EPUB 内嵌脚本** → 调用方必须用 CSP 阻断脚本，否则无法安全渲染不可信 EPUB；
- **IDPF 字体解混淆依赖 Web Crypto SHA-1** → 仅 secure context（HTTPS）可用；HTTP 环境需自带 SHA-1 实现；
- Adobe 字体混淆的算法细节其 README 未逐字给出（**未验证**），使用前需读源码确认。

**格式与库的许可证矩阵**（完整版见 docs/research/30-formats-zlib-llm.md 的 A.1 节）

| 格式 | 首选库 | 许可证 | 关键备注 |
|---|---|---|---|
| EPUB 2/3 | foliate-js（epub.js + epubcfi.js） | **MIT** | 备选 epub.js(BSD-2) / Readium ts-toolkit(BSD-3) |
| MOBI / AZW / AZW3(KF8) | foliate-js（mobi.js） | MIT | 备选 libmobi(LGPL-3.0，须动态链接) |
| FB2 / FBZ | foliate-js（fb2.js） | MIT | 结构简单，可自研兜底 |
| CBZ | foliate-js（comic-book.js） | MIT | 纯 zip，风险最低 |
| TXT | 自研分章 + jschardet 编码探测 | 0BSD | 必须流式读取，10MB+ 全量读入会 OOM |
| PDF | pdf.js / pdfjs-dist | **Apache-2.0** | **MuPDF 是 AGPL-3.0，商业闭源不可用** |
| 扫描件 OCR | tesseract.js（前端）/ OCRmyPDF（服务端） | Apache-2.0 / GPL-3.0 | 移动端优先走服务端 OCR（体积与性能） |
| DOCX | mammoth | BSD-2-Clause | 只转语义样式、丢弃版式（对阅读器反而是优点） |
| Markdown / HTML | markdown-it / 浏览器原生 + Readability | MIT | HTML 需先抽正文再进分页器 |
| CBR (RAR) | 无首选 | — | **UnRAR 许可限制属法务灰区，一期不做** |

**自研叠加层**
- **主题注入**：CSS 自定义属性 + 注入样式表控制字号/行距/字体/颜色；支持用户 CSS（高级设置）。
- **安全隔离**：书籍内容在 iframe 中渲染并禁用脚本（CSP script-src 'none'）。
- **定位抽象（关键）**：内部统一采用 **Readium Locator 规范**（href + type + locations{fragments, progression, position, totalProgression} + text{before, after, highlight}）。EPUB 的 CFI、PDF 的页码+矩形、TXT 的字符偏移全部塞进 locations.fragments，对外只暴露一个 SerializedLocator（JSON）。选它的理由：这是**唯一有正式规范**且跨 EPUB/PDF/有声书统一的定位模型，直接决定同步与标注能否跨端稳定。
- **双语对照**：段落级对齐渲染（原文段落 + 译文插入节点），依赖段落锚点 ID。
- **竖排/标点挤压**：P2，但样式层从 P0 就预留 writing-mode 与 text-combine 通路。
- **PDF 细节**：pdf.js 渲染到 canvas + 文本层 div；标注用「页号 + 归一化矩形」；默认**不做重排**（多栏学术 PDF 重排质量不可用），扫描件按需 OCR。

### 3.4 本地数据层

- **Schema 与云端同构但本地字段更多**：本地表额外带 `dirty`、`local_updated_at`、`sync_rev`、`deleted_at`。
- **Outbox 模式**：任何写操作在同一 SQLite 事务中写业务表 + 写 `outbox`；同步器只消费 outbox。保证「不丢操作」。
- **Web 端存储**：SQLite WASM 数据库文件存 OPFS（Origin Private File System），大文件（书籍）单独存 OPFS 目录，避免数据库膨胀。
- **容量治理**：显示本地占用、按书清理缓存、LRU 淘汰已同步的书籍文件（保留元数据与进度）。

### 3.5 状态与服务抽象

| 关注点 | 方案 |
|---|---|
| UI 交互状态 | Zustand store（reader/library/settings/ai），按域拆分，禁止跨 store 直接调用 |
| 服务端数据 | TanStack Query（书库列表、元数据）；同步数据走自研同步层（不走 Query 的缓存语义） |
| 实时流（AI） | SSE（`text/event-stream`），逐块渲染 |
| 错误处理 | 统一错误码（packages/shared），UI 层映射为可读提示 |
| 离线检测 | `navigator.onLine` + 主动心跳 + 请求失败退避 |

### 3.6 各端差异与降级矩阵

| 能力 | Web | 桌面 | 移动 | 降级策略 |
|---|---|---|---|---|
| 本地文件 | File System Access API（Chromium）/上传 | 完整 | 完整（沙盒内） | 不支持则走上传+云端回源 |
| 后台下载 | 受限（SW） | 完整 | 受限（iOS 更严） | 前台下载 + 断点续传 |
| TTS | Web Speech API（质量依浏览器） | 系统 TTS / Edge TTS | 系统 TTS | 云端 TTS 作为可选（P2） |
| 后台同步 | 页面存活时 | 完整（定时器/托盘） | 前台 + 有限后台 | 打开时/切前台时同步 |
| 应用锁 | 无（浏览器） | 支持 | 生物识别 | Web 端降级为重新登录 |
| 自动更新 | 天然 | Tauri updater | 应用商店/APK | — |

### 3.7 横竖屏与响应式实现

- **断点策略**：不以设备名判断，用 `useMediaQuery` 组合三要素：可用宽度（compact < 600 / medium 600–1024 / expanded > 1024）、是否触控、宽高比（landscape/portrait）。
- **阅读器布局引擎**：`layoutMode = f(containerWidth, orientation, userPrefs)` → 输出 `single | dual | dualWithSidebar`；切换布局时用当前 Locator 重新定位，禁止回到章首。
- **旋转处理**：监听 `orientationchange` 与 `ResizeObserver`，防抖 150ms 后重排；重排期间保持滚动锚点。
- **安全区**：CSS `env(safe-area-inset-*)`；移动端全屏阅读时隐藏状态栏（Android）与使用安全区（iOS）。
- **验收**：在 6 个视口（手机竖/横、平板竖/横、桌面宽/窄）× 2 种阅读模式（分页/滚动）下逐项走查。

### 3.8 构建与发布链路

| 目标 | 工具 | 产物 | 备注 |
|---|---|---|---|
| Web | Vite + SW 预缓存 | 静态站点（Caddy 托管） | 需 COOP/COEP 仅当使用 SharedArrayBuffer（本方案不用，可省） |
| Windows | Tauri + NSIS/MSI | 安装包 + 便携版 | 代码签名（可选，未签名会触发 SmartScreen 警告） |
| macOS | Tauri + 签名/公证 | .dmg | 需 Apple Developer 账号（$99/年） |
| Linux | Tauri + AppImage/deb/Flatpak | 包 | Flatpak 便于分发 |
| Android | Tauri mobile + Gradle | APK/AAB | 商店需 AAB；侧载用 APK |
| iOS | Tauri mobile + Xcode | .ipa | 需 Mac + Apple 账号；企业签名/TestFlight |

**CI（GitHub Actions 或自建）**：lint → typecheck → unit test → build（矩阵）→ E2E（Web）→ 产物归档。**商店版与完整版通过构建期环境变量区分功能开关。**

### 3.9 前端性能预算
| 指标 | 预算 |
|---|---|
| 首屏 JS（gzip） | < 350KB（阅读器路由按需加载） |
| 冷启动到书库可交互 | < 1.5s（桌面/Web），< 2.5s（中端手机） |
| 打开 10MB EPUB | < 1.5s 首屏可读 |
| 翻页响应 | < 100ms |
| 滚动帧率 | ≥ 50fps（中端手机 ≥ 40fps） |
| 内存（打开 50MB PDF） | < 600MB |

---

## 3.5 客户端落地基线（Vue 3 + Wails v3，2026-11-02 定稿）

> 依据：[40-wails-v3.md](research/40-wails-v3.md)、[50-vue3-reader-stack.md](research/50-vue3-reader-stack.md)、[60-webview-security-backend-lang.md](research/60-webview-security-backend-lang.md)、[70-isolation-feasibility.md](research/70-isolation-feasibility.md)。

### 3.5.1 版本基线（npm 实测 2026-11-02）

| 项 | 版本 | 备注 |
|---|---|---|
| Vue | **3.5.44** | 3.6 仍是 `rc.14`（2026-10-30）→ **Vapor 不上生产** |
| Vite | **8.3.5** | Rolldown 单打包器；`@vitejs/plugin-vue` 6.0.10 |
| TypeScript | 锁 **~6.0.2** | `latest` 已是 7.0.2，但 vue-tsc 在 TS7 上**未验证** |
| Pinia | **4.1.0** | setup stores + `pinia-plugin-persistedstate` 4.7.1 |
| TanStack Query (Vue) | 5.105.2 | **只放服务端权威数据**，同步引擎状态另置 |
| UI | **Reka UI 2.11.0 + Tailwind 4.3.3** | 否决 Element Plus 承载阅读器；Naive UI 仅备用于设置区 |
| 虚拟滚动 | `@tanstack/vue-virtual` 3.13.51 | 覆盖书库网格 / 目录树 / 搜索结果 |
| Node | **≥22.12** | 由 Vitest 5 / VueUse 15 的 engines 反推 |
| Go | **1.26+** | 当前机器未安装 |

### 3.5.2 渲染层隔离（L1–L5，取代原「iframe + CSP」一句话方案）

| 层 | 措施 | 可达性 |
|---|---|---|
| L1 | EPUB 解压预算（zip 炸弹防护）、禁用 XML 外部实体 | 确定 |
| **L2（主力）** | 用官方 `transformTarget` 钩子（README:115，唯一早于解析的变换点）逐节：剥 `script`/`on*`/`javascript:`/`foreignObject`、重写远程 URL、注入 `meta CSP: default-src 'none'; script-src 'none'; img-src data: blob:; style-src 'unsafe-inline'` | **确定可达，零引擎改动** |
| L3 | 去掉 iframe sandbox 的 `allow-scripts`（foliate-js 用它仅为绕 WebKit Bug 218086） | 需实测 |
| L4 | 阅读器窗口 + 自建中间件按 `x-wails-window-id` 拒绝 /wails/runtime | ✅ **已验证**（C-01/C-09 均成立，双窗口实测只拒阅读器窗口）；**仅限桌面/移动**，server 模式无原生注入故不可用 |
| L5 | A5 结构化渲染（foliate-js 仅作解析器，Vue 组件渲染） | 兜底 |

**三个决定整套方案成立的前提**：
1. foliate-js **不注入任何脚本**（`<script>` / `createElement('script')` / `document.write` 全文 0 命中）→ **CSP `script-src 'none'` 不会破坏分页**；
2. 但它**必须同源访问 `iframe.contentDocument`**（paginator.js `get document()` @7829，`load()` 第一步即用；opaque 下为 null 直接抛异常）→ **opaque 帧方案不可行**，这就是选 L2 而非「独立 origin」的原因；
3. 上游**不清理**书内脚本（`epub.js` @29072 注释明说不值得做）→ **净化必须我们做**。

### 3.5.3 Vue × foliate-js 工程铁律（违反即产生难查的怪 bug）

| # | 铁律 |
|---|---|
| 1 | foliate-js 实例**一律**放组件闭包普通变量，或 `shallowRef` + `markRaw`；**绝不能**放 `ref`/`reactive`（Vue 的 Proxy 会破坏其内部私有字段与标识比较） |
| 2 | `foliate-view` 是 **custom element**，不是 Vue 组件——用模板 ref 拿元素后命令式驱动 |
| 3 | 章节加载用 `loadRequest` + `WeakSet` 处理竞态（快速翻页时旧请求晚到） |
| 4 | 坐标系三空间换算必须集中在一个 `coords.ts`：Range 坐标是 **iframe 视口**坐标，overlayer SVG 在 paginator **shadow root** 内，主文档浮层需再叠加 `iframe.getBoundingClientRect()` |
| 5 | 多列分页下 `Range.getClientRects()` 会返回**不可见列**的矩形，必须过滤 |
| 6 | 主题必须**双写**：主文档 CSS 变量 + `renderer.setStyles()` 注入 iframe head；高亮用上游 `--overlayer-highlight-*` 变量 |
| 7 | 同步引擎用**独立单例 + `shallowRef`**，不进 Pinia、不进 Query 缓存 |
| 8 | **不要依赖 ES2024+ 内置对象，或必须在入口自带 polyfill**。foliate-js 的 `epub.js` 使用了 `Object.groupBy` / `Map.groupBy`（需 Chrome 117+），而 Android 系统 WebView 实测可为 **Chrome 91**（Android 12 模拟器镜像）→ 点开书直接抛 `Object.groupBy is not a function`。**运行时 builtin 缺失无法靠打包器降级修复**，必须 polyfill，并在 `vite.config.ts` 下调 `build.target` |
| 9 | 兼容性下限按 **Chrome 91 / Android 12** 设计（见 [MOBILE-PLATFORM-NOTES](MOBILE-PLATFORM-NOTES.md) 第 7 节）；新增依赖前先查其 ES 版本要求，启动时若检测到 WebView 过旧应给出可读提示而非白屏 |

### 3.5.4 平台能力抽象（三实现，借鉴 Readest 的 AppService 模式）

| 能力 | desktop | mobile | server(Web) |
|---|---|---|---|
| 窗口/托盘/菜单 | 完整 | 多窗口仅首窗、托盘 no-op | **不可用** |
| 文件对话框 | 完整 | save / 选目录 **不可用** → 降级为导出到沙盒 | 不可用 |
| 安全存储 | 系统钥匙串 | 系统钥匙串 | 服务端会话 |
| 本地数据库 | Go 侧 SQLite（纯 Go 驱动，免 cgo） | 同左 | **无** → 在线优先 |

约定：业务代码**不得**直接调用生成的 bindings，一律经 `platform/` 抽象层；启动时做能力探测，不假设 API 可用。另有硬约束：**service 内禁止持有请求级状态**（service 跨窗口共享单例）。

### 3.5.5 Web 版（Wails server 构建）必须做的改造

| # | 措施 | 原因 |
|---|---|---|
| B1 | 默认只绑 loopback；公网入口走自建反代 + 鉴权，或另建独立 HTTP API，**不暴露 /wails/runtime** | 该端点无鉴权，且**无 Origin 头的请求直接被放行**（实测 curl → 200 且泄露数据）；另：server 模式**无原生注入窗口头**，伪造 `x-wails-window-id` 被原样接受 → **Web 版不能用 L4** |
| B2 | 自建用户/会话/配额模型 | server 模式把标签页当窗口（`browser-N`），**无账号概念** |
| B3 | service 内禁止持有请求级状态（当前用户/当前书籍） | service 是跨窗口共享单例 |
| B4 | Events 定向发送，禁止广播用户数据 | Go 侧 `Emit` 广播到所有连接 |
| B5 | 压低 /wails/runtime 请求体上限（默认 64 MiB） | 缩小攻击面 |

### 3.5.6 依赖与升级纪律

- **foliate-js 必须 fork/vendor 固定 commit**：npm 上的 `foliate-js@1.0.1` 是**第三方冒名包**（维护者 `shmandadi`），上游 `package.json` 版本为 `0.0.0`；
- Vite 下需给 foliate-js 打补丁（`pdf.js` 的 `fetch(new URL(...))` 取 CSS → `?inline`；paginator 的 `data.replace` 加字符串守卫）；
- **Wails CLI 与 `@wailsio/runtime` 必须锁同一版本**（周更 + nightly 节奏）；
- 建立升级回归清单并跟踪安全 PR——**v3.0.1 从未发布**，安全修复只会出现在周更版里。

## 4. 后端技术方案

### 4.1 模块化单体结构

~~~
apps/server/src/modules/
├── auth/         注册/登录/刷新/找回密码/会话与设备
├── users/        资料/设置/配额/用量
├── books/        书库 CRUD、元数据、封面、格式解析结果缓存
├── storage/      分片上传、秒传、下载（Range）、MinIO 适配
├── sync/         change_log、push/pull、冲突合并、快照
├── annotations/  标注/书签/笔记（也走 sync，但提供 REST 方便第三方）
├── ai/           翻译、实体归一化、摘要、RAG（SSE 流式）
├── sources/      书源规则引擎、聚合搜索、下载任务
├── admin/        管理后台 API、审计日志
└── jobs/         BullMQ 任务定义（封面生成、格式转换、整书翻译、向量化）
~~~

### 4.2 数据模型（PostgreSQL，草案）

~~~sql
-- 用户与设备
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,               -- Argon2id
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'user', -- user | admin
  status        TEXT NOT NULL DEFAULT 'active',
  quota_bytes   BIGINT NOT NULL DEFAULT 5368709120,   -- 5GB
  quota_ai_calls INTEGER NOT NULL DEFAULT 1000,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT,
  platform   TEXT,                            -- web|windows|macos|linux|android|ios
  app_version TEXT,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 书库
CREATE TABLE books (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  author      TEXT,
  series      TEXT,
  language    TEXT,
  format      TEXT NOT NULL,                  -- epub|pdf|txt|mobi|azw3|fb2|cbz|html|md
  file_hash   TEXT NOT NULL,                  -- sha256，用于去重/秒传
  file_size   BIGINT NOT NULL,
  storage_key TEXT NOT NULL,                  -- 对象存储 key
  cover_key   TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',    -- 解析出的完整元数据
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX books_user_hash_idx ON books(user_id, file_hash) WHERE deleted_at IS NULL;

CREATE TABLE shelves (        -- 书架/文件夹
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE shelf_books (
  shelf_id UUID REFERENCES shelves(id) ON DELETE CASCADE,
  book_id  UUID REFERENCES books(id)   ON DELETE CASCADE,
  PRIMARY KEY (shelf_id, book_id)
);

-- 阅读状态（每用户每书一行 = 最后确认值）
-- locator 统一采用 Readium Locator 规范（href + type + locations{}），
-- 跨格式（EPUB CFI / PDF 页码+矩形 / TXT 字符偏移）全部塞进 locations.fragments。
CREATE TABLE reading_progress (
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id             UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  locator             JSONB NOT NULL,                   -- Readium Locator（精确位置）
  total_progression   REAL NOT NULL DEFAULT 0,          -- 归一化 0..1（跨副本只信它）
  furthest_locator    JSONB,                            -- 历史最远位置
  furthest_progression REAL NOT NULL DEFAULT 0,
  explicit_rewind     BOOLEAN NOT NULL DEFAULT false,   -- 用户主动回退（防被"取最远"拉回）
  hlc                 TEXT NOT NULL,                    -- 合并时钟（HLC 字符串）
  device_id           UUID,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 客户端事件时间（展示/排序）
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 服务端写入时间（仅审计，非游标）
  PRIMARY KEY (user_id, book_id)
);
CREATE INDEX reading_progress_recent_idx ON reading_progress(user_id, updated_at DESC);

-- 标注（高亮/书签/笔记）
CREATE TABLE annotations (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                   -- highlight|underline|bookmark|note
  locator    JSONB NOT NULL,                  -- {start,end} 或单点
  color      TEXT,
  text       TEXT,                            -- 被标注原文
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX annotations_book_idx ON annotations(user_id, book_id, updated_at);

-- 实体档案（人名/术语归一化）——差异化功能
CREATE TABLE entity_profiles (
  book_id    UUID PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language   TEXT,
  entities   JSONB NOT NULL,   -- [{canonical, aliases[], translation, type, firstSeen, notes}]
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 翻译记忆（避免重复计费）
CREATE TABLE translation_memory (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,        -- hash(原文 + 模型 + 提示词版本 + 目标语言 + 术语表版本)
  source_text TEXT NOT NULL,
  target_text TEXT NOT NULL,
  model TEXT, prompt_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tm_key_idx ON translation_memory(user_id, cache_key);

-- 同步日志（核心）：append-only，seq 就是客户端游标
CREATE TABLE change_log (
  seq        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- 服务端分配、全局单调
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity     TEXT NOT NULL,               -- book|progress|annotation|shelf|setting|entity_profile
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL,               -- upsert|delete
  payload    JSONB,                       -- 变更后的完整实体（简化客户端合并逻辑）
  hlc        TEXT NOT NULL,               -- 该变更的 HLC（字段级 LWW 裁决依据）
  device_id  UUID,
  op_id      UUID,                        -- 客户端操作 ID（幂等键）
  server_ts  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX change_log_user_seq_idx ON change_log(user_id, seq);

-- 幂等去重（保留 7 天，覆盖最长离线窗口）
CREATE TABLE sync_idempotency (
  op_id      UUID NOT NULL,
  user_id    UUID NOT NULL,
  device_id  UUID,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result     JSONB,
  PRIMARY KEY (user_id, op_id)
);
CREATE INDEX sync_idem_expire_idx ON sync_idempotency(applied_at);

-- 书源
CREATE TABLE book_sources (
  id UUID PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL,      -- builtin|user
  rules JSONB NOT NULL,                        -- 声明式规则
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- AI 用量与审计
CREATE TABLE ai_usage (
  id BIGSERIAL PRIMARY KEY, user_id UUID NOT NULL, feature TEXT NOT NULL,
  model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_cents INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY, user_id UUID, action TEXT NOT NULL,
  target TEXT, ip INET, ua TEXT, detail JSONB, created_at TIMESTAMPTZ DEFAULT now()
);
~~~

> 租户隔离：所有查询强制带 `user_id`（Repository 层统一注入），并**启用 PostgreSQL Row Level Security 作为兜底**。

### 4.3 同步引擎（本方案最核心的部分）

**设计目标**：离线可用、增量、幂等、可解释的冲突。

**协议**
~~~http
POST /v1/sync/push
{
  "device_id": "uuid",
  "ops": [
    { "op_id": "uuid", "entity": "progress", "entity_id": "<book_id>",
      "op": "upsert", "hlc": "0192a3f4c1b0-0000000a-7f3c9d21",
      "payload": { "locator": {...}, "total_progression": 0.42, "explicit_rewind": false } }
  ]
}
-> 200
{
  "results": [
    { "op_id": "uuid", "status": "applied", "server_rev": 12346 },
    { "op_id": "uuid2", "status": "conflict", "server_rev": 12350,
      "server_payload": {...}, "resolution": "client_wins|lww" }
  ],
  "cursor": 12350
}

GET /v1/sync/pull?cursor=12346&limit=500
-> 200 { "changes": [ { "seq": 12347, "entity": "annotation", "entity_id": "...", "op": "upsert", "payload": {...}, "hlc": "..." } ],
         "next_cursor": 12347, "has_more": false }

GET /v1/sync/snapshot     # 游标失效/新设备首同步
-> 200 { "cursor": 12350, "books": [...], "progress": [...], "annotations": [...], "shelves": [...], "settings": {...} }
~~~

**合并规则：字段级 LWW（HLC 裁决）+ remove-wins 墓碑**

| 实体 | 冲突策略 |
|---|---|
| reading_progress | 不用「取最大」，改用下方三条进度语义（已按 Readest 源码行为核实） |
| annotation（新建/删除） | **remove-wins**：墓碑写入后任何字段写入都不能复活（防止慢设备把已删除标注写回来） |
| annotation（文本/笔记编辑） | 字段级 LWW：逐字段比较 HLC，大者胜；同 HLC 比 deviceId 字典序（保证结果确定可复现） |
| shelf / 设置 | 字段级 LWW |
| entity_profile | 按实体数组元素合并（不同实体互不覆盖），同一实体按 HLC 决胜 |
| book（元数据） | 字段级 LWW；文件内容以 file_hash 为准（同 hash 即同一文件） |

**进度语义（最容易写错的地方，三条规则）**
1. **同一 content_hash（同一文件）**：以 HLC 较新的 locator 为准，且**允许用户主动回退**；回退须带 explicit_rewind=true，否则短时间内可能被另一设备的「更远位置」覆盖。
2. **不同 content_hash 但同一本书的不同副本**：只能比较归一化 total_progression，且**只允许单调前移**（epsilon 0.002）——因为 CFI 在字节不同的副本之间不可比。
3. **删除与重新导入**：删除走墓碑；重新导入分配新的 reincarnation 令牌，避免「重新下载后回到旧位置」。

**HLC（Hybrid Logical Clock）**
- 格式：13 位毫秒时间戳 + 8 位十六进制计数器 + 设备 ID 前 8 位，例 0192a3f4c1b0-0000000a-7f3c9d21；**字符串字典序 == 时间序**，可直接在 SQL 里用 > 比较。
- 生成：pt = max(墙钟毫秒, last_pt)；同毫秒 counter++，否则 counter 归零。
- 为什么不用服务端时间：分布式下服务端时间无法表达因果序；HLC 同时具备物理时间可读性与因果单调性，且不依赖中心时钟。
- **合并逻辑必须服务端与客户端同构**（同一算法 + 同一套测试向量），否则两端会发散——这是 Readest 踩过的坑。

**可靠性**
- 幂等：op 携带 op_id（UUID v7），服务端 sync_idempotency 表去重并保留 7 天（覆盖最长离线窗口）；超出窗口的重复推送按 HLC 合并，结果仍收敛。
- 原子性：一个 push 的全部 op 在**同一事务**内应用（全成或全败），用 INSERT ... ON CONFLICT DO UPDATE 单语句合并，避免并发下 fetch-then-upsert 交错。
- **游标必须服务端分配**（change_seq identity），**绝不能用客户端 updated_at 当游标**：服务端合并过的行不会获得新的客户端时间，其它设备就永远拉不到这次合并结果（Readest issue #4678 的真实教训）。
- 墓碑保留 30 天；客户端超过 30 天未上线则下次走 snapshot。
- 单次拉取必须支持 limit + hasMore；变更超过 200 条时 gzip；payload 用短字段名可省 30% 以上流量。

**测试**：用属性测试（fast-check）生成「多设备乱序操作序列」，断言「所有设备最终收敛到同一状态」且「进度不倒退（除非显式回退）」。

### 4.4 存储与秒传
- 上传：`POST /v1/uploads` 申请（携带 sha256 + size）→ 服务端查 `file_hash` 是否已存在 → 存在直接返回（**秒传**）→ 否则返回分片上传地址（MinIO presigned URL 或多段上传）→ 客户端分片并发上传 → `POST /v1/uploads/:id/complete` → 入队解析任务（元数据/封面/目录）。
- 下载：`GET /v1/books/:id/file` 支持 HTTP Range（PDF 大文件按需分片）、`ETag` 与 `If-None-Match`。
- 封面：解析后生成多尺寸（S/M/L）WebP 缓存。
- 去重：`(user_id, file_hash)` 唯一；跨用户去重需谨慎（隐私），可只做同用户去重。

### 4.5 认证与多租户
- 密码：Argon2id（内存 64MB、迭代 3、并行 4）。
- 会话：JWT access（15 分钟，内存保存）+ refresh token（30 天，HttpOnly Cookie 或安全存储，**轮换 + 重用检测**）。
- 限流：按 IP（登录 5 次/分钟）+ 按用户（AI 与书源接口）。
- 设备管理：`devices` 表 + refresh token 家族，支持「登出该设备」。
- 权限：`requireAuth` / `requireAdmin` 装饰器；Repository 强制 user_id 过滤 + RLS 兜底。
- 审计：登录、下载、删除、管理操作写 `audit_logs`。

### 4.6 AI 网关（差异化核心）
统一接口：`POST /v1/ai/*`，SSE 流式返回；后端持有 API Key（用户也可 BYOK，Key 加密存储）。

| 能力 | 实现要点 |
|---|---|
| 划词翻译 | 单次调用，注入本书术语表（取自 entity_profiles）+ 上下文（前后各 1 段）；结果写 translation_memory |
| 整章/整书翻译 | 分块 → BullMQ 任务 → 逐块产出 → 落库（可离线阅读已译内容）；支持断点续传与取消 |
| **实体归一化** | 五层流水线（L1 规则归一 → L2 NER 抽取 → L3 别名聚类：编辑距离/音译/embedding/共现图 → L4 **LLM 只做「裁定」不做「发现」**（仅把高不确定实体对交模型判定）→ L5 用户确认后固化进书籍术语表）。发现走便宜的确定性方法，LLM 只处理少量疑难对：**更省钱、更可解释、更可审计** |
| 译名一致性 | 后续所有翻译调用把已确认译名表作为术语表注入提示词；未确认时使用模型默认译名并标记 |
| 摘要 | 章节级（按章节正文）+ 全书级（章节摘要的摘要，Map-Reduce） |
| RAG 问答 | 分块（按章 + 重叠）→ 嵌入 → pgvector → 检索 Top-K → 带引用生成；答案必须附原文位置可跳转 |
| 成本控制 | 缓存（TM）+ 提示词版本化 + 按用户配额 + 模型路由（便宜模型做 NER/摘要，强模型做翻译/问答）+ 失败降级 |
| 隐私 | 默认对每次「发送正文」有明确告知；支持「仅元数据外发」与「禁用 AI」；支持 Ollama 本地模型 |

**成本估算（依据 2026-11-02 抓取的 DeepSeek 官方定价页；见 docs/research/30-formats-zlib-llm.md 的 C.2.3）**

| 场景 | 输入 / 输出 token | 单价档 | 整书一次（100 万字符） |
|---|---|---|---|
| 英文书、低峰、flash | 0.3M / 0.45M | $0.15 / $0.60 每 M | **≈ $0.32** |
| 中文书、低峰、flash | 0.8M / 0.8M | 同上 | **≈ $0.60** |
| 最贵：高峰 + pro 档 + 1.2M 输出 | 0.8M / 1.2M | $1.32 / $3.96 每 M | **≈ $5.81** |

→ 区间 **$0.24–$3.96 / 100 万字符**（约 ¥1.7–28）。**成本瓶颈是输出 token 与重试，不是输入**（缓存命中的输入低至 $0.003/M）。

降本优先级：① 段落级缓存（内容哈希，同一段永不重复付费）② 术语表只放在 system 前缀发一次（吃 prefix 缓存）③ 低峰跑批（官方低峰价为半价）④ 按需翻译（滚动到该章才译）⑤ 档位路由（普通段落 flash，术语密集段升 pro）。

> **上线前必须用目标模型的 tokenizer 实测「字符→token」换算**，这是成本估算里最大的不确定源；上表数字来自官方价目表推算，未做实测账单校验。**结论：默认 DeepSeek + 缓存后成本可忽略；昂贵模型一律 BYOK。**

### 4.7 书源规则引擎（声明式 JSON DSL）
~~~json
{
  "id": "gutenberg",
  "name": "Project Gutenberg",
  "version": 1,
  "search": {
    "url": "https://gutendex.com/books?search={{keyword}}&page={{page}}",
    "list": "$.results[*]",
    "fields": { "title": "$.title", "author": "$.authors[0].name",
                "cover": "$.formats.image/jpeg", "download": "$.formats.application/epub+zip" }
  },
  "detail": { "url": "https://gutendex.com/books/{{id}}", "fields": { "description": "$.summaries[0]" } }
}
~~~
- 表达式：JSONPath（结构化）+ CSS 选择器（HTML）+ 正则（文本），**不执行任意 JS**（安全、可审计、跨端一致）。
- 执行位置：**后端执行**（规避 CORS、隐藏 UA/限流、便于审计与缓存）；客户端只发起 `POST /v1/sources/search`。
- 内置源：Project Gutenberg（gutendex.com）、Standard Ebooks、Open Library、Internet Archive、用户自配 OPDS。
**Z-Library 的裁决（一期「否决内置」，见 docs/research/30-formats-zlib-llm.md 的 B.3.6）**

| 选项 | 裁决 | 理由 |
|---|---|---|
| 主应用内置 Z-Library 搜索/下载 | **否决** | 法务风险最高；商店审核结果不可预期；域名漂移与反爬会变成产品稳定性问题 |
| 官方插件市场提供 Z-Library 插件 | **否决（一期）** | 「官方提供」是最容易被认定为帮助侵权的形态，审核同样过不去 |
| 只提供通用书源接口 + 用户自行导入 | **备选，需法务书面确认** | 法律定位最接近「通用工具」，但上架版本可能仍须剥离该能力 |
| 只内置合法书源 + 用户导入自有文件 | **首选（一期）** | 风险最低、工程量最小、审核最稳 |

- 声明式 JSON 规则而**不执行任意脚本**，不是技术偏好，而是**合规与审核要求**：App Store 2.5.2 禁止「下载/执行代码」，4.7 要求开发者对第三方内容负责；执行任意 JS 的书源引擎在审核语境下等同于「下载并执行代码」。
- 官方仓库不托管、不分发、不索引任何第三方侵权源；第三方规则的获取与使用责任由用户自负，且上架版本必须在构建期关闭该入口。

### 4.8 全文搜索
- 书内搜索：由客户端渲染引擎完成（foliate-js 已支持），无需后端。
- 全库搜索：Postgres FTS（`tsvector` + 中文 `pg_bigm` 或 `zhparser`）→ 数据量超过 50 万段后迁 Meilisearch。

### 4.9 API 总览（草案）

| 分组 | 端点 |
|---|---|
| 认证 | `POST /v1/auth/login`、`/refresh`、`/logout`、`/password/forgot`、`/password/reset`（**无注册端点**：账号由运维用 `api createuser` 创建） |
| 用户 | `GET/PATCH /v1/me`、`GET /v1/me/devices`、`DELETE /v1/me/devices/:id`、`GET /v1/me/usage`、`DELETE /v1/me`（注销） |
| 书库 | `GET/POST /v1/books`、`GET/PATCH/DELETE /v1/books/:id`、`GET /v1/books/:id/cover`、`GET /v1/books/:id/file` |
| 上传 | `POST /v1/uploads`、`PUT /v1/uploads/:id/parts/:n`、`POST /v1/uploads/:id/complete` |
| 同步 | `POST /v1/sync/push`、`GET /v1/sync/pull`、`GET /v1/sync/snapshot` |
| 标注 | `GET/POST /v1/books/:id/annotations`、`PATCH/DELETE /v1/annotations/:id`、`GET /v1/books/:id/annotations/export` |
| 书架 | `GET/POST /v1/shelves`、`POST /v1/shelves/:id/books` |
| 书源 | `GET/POST /v1/sources`、`POST /v1/sources/search`、`POST /v1/sources/download` |
| AI | `POST /v1/ai/translate`、`/ai/summarize`、`/ai/entities/extract`、`/ai/chat`（均 SSE）、`GET /v1/books/:id/entity-profile`、`PUT /v1/books/:id/entity-profile` |
| 管理 | `GET /v1/admin/users`、`PATCH /v1/admin/users/:id`、`GET /v1/admin/stats`、`GET /v1/admin/audit` |
| 运维 | `GET /healthz`、`GET /readyz`、`GET /metrics` |

---

## 5. 前后端契约
- **唯一权威**：`packages/shared` 中的 Zod schema 定义所有请求/响应；服务端用同一 schema 校验，客户端用同一类型。
- 由 schema 生成 OpenAPI（`@fastify/swagger`），再由 OpenAPI 生成 `packages/api-client`。
- 契约变更必须走 PR + 版本号；破坏性变更提升 `/v2`。
- **本地 SQLite schema 与云端 schema 的映射表**单独维护（`packages/shared/src/sync-mapping.ts`），这是同步正确性的关键文档。

---

## 6. 部署与运维（自托管）

**最小生产拓扑（单机 Docker Compose）**
~~~
Internet ──► Caddy (443, 自动 HTTPS)
              ├── /            → 静态前端（apps/app 构建产物）
              ├── /v1/*        → api:3000 (Fastify)
              └── /files/*     → minio:9000 (或由 api 代理鉴权)
             api ──► postgres:5432 / redis:6379 / minio:9000
             worker（同镜像，不同入口）──► redis 消费队列
~~~
**资源建议**
| 规模 | 配置 | 说明 |
|---|---|---|
| 自用/家庭（≤20 人） | 2C4G + 100GB SSD | 全部组件可跑，AI 走外部 API |
| 小规模（≤1000 人） | 4C8G + 500GB SSD + 对象存储 | 建议对象存储外置/独立备份盘 |
| 更大规模 | api 多副本 + 托管 PG + 独立 MinIO | 先水平扩 api 与 worker |

**备份（必须做，不是可选）**
- PostgreSQL：每日 `pg_dump` + WAL 归档（PITR 可选）。
- 对象存储：`restic`/`rclone` 增量备份到异地（含加密）。
- 保留策略：日备 7 份、周备 4 份、月备 6 份。
- **每季度做一次恢复演练**（否则备份等于没有）。

**监控**：`/healthz` 探活、`/metrics`（Prometheus 格式）、Uptime Kuma 告警、日志（Loki 或文件 + logrotate）。

---

## 7. 安全与合规
| 项 | 措施 |
|---|---|
| 传输 | 全站 HTTPS（Caddy 自动证书），HSTS |
| 密码 | Argon2id；登录失败锁定与速率限制 |
| 会话 | 短 access + 轮换 refresh + 重用检测 |
| 注入 | 参数化查询（Drizzle）、上传文件类型与大小校验 |
| **恶意电子书（硬门槛，已验证）** | 主力防线 **L2**（同源 iframe + transformTarget 逐节净化 + 逐节注入 `default-src 'none'; script-src 'none'` + 剥离重写远程引用）→ 确定可达；**L4** 阅读器窗口按窗口标识拒绝 /wails/runtime → **C-01/C-09 两门已实测通过，双窗口限权生效**（仅桌面/移动）；**L5** 结构化渲染 → 兜底（约 10–16 人周）。依据见 [ADR-003](ADR-003-内容隔离架构.md) 第 9–10 节 |
| SSRF | 书源请求走白名单 + 禁止内网地址（169.254/10./127.） |
| 越权 | Repository 强制 user_id + RLS 兜底 |
| 数据导出/删除 | 提供 `GET /v1/me/export` 与 `DELETE /v1/me`（合规要求） |
| 审计 | 敏感操作写 audit_logs |
| 合规文档 | 若公开运营：用户协议、隐私政策、备案（大陆）；版权投诉通道（DMCA/通知-删除） |

---

## 8. 测试与质量
| 层 | 手段 | 覆盖目标 |
|---|---|---|
| 单元 | Vitest（前端与后端） | 核心逻辑 ≥ 70% |
| 同步 | 属性测试 + 多设备乱序模拟 | 收敛性与不变量 100% |
| 契约 | Zod schema 测试 + OpenAPI 快照 | 契约不漂移 |
| 格式 | 样本库（EPUB2/3、TXT 编码、MOBI/AZW3、PDF 文本/扫描、FB2、CBZ）回归快照 | 每格式 ≥ 5 个样本 |
| E2E | Playwright（Web：注册→导入→阅读→标注→同步） | 主流程 100% 通过 |
| 性能 | 基准脚本（打开/翻页/滚动/同步） | 满足 3.9 预算 |
| 安全 | 依赖扫描（`pnpm audit`）、ZAP 基线扫描 | 无高危 |

**合并门槛**：lint + typecheck + unit + E2E 全绿才可合并；主线保持可发布。

---

## 9. 里程碑细化

| 阶段 | 交付 | 关键验收 |
|---|---|---|
| **M0 方案冻结**（1 周） | 本文档定稿 + OPEN-QUESTIONS 全部回答 + 服务器就绪 | 决策清单勾选完成 |
| **G1 移动端 Spike**（2–3 天，先于一切业务代码） | Wails v3 空应用 + foliate-js 渲染真实 EPUB，构建 iOS/Android 真机包 | iOS 与 Android 均可打开并翻页；e-ink 机型不白屏；本地 SQLite 可读写；**失败则启动移动端预案（PWA / 延后 / 原生双栈）** |
| **G2 隔离 PoC**（2–3 天，并入 M1 验收） | 书籍 iframe 的 opaque-origin 隔离 + 桥 token 校验 | 从 iframe 内调用原生 API、读本地 DB、发起远程请求、注入主 frame **全部失败** |
| **M1 骨架与阅读闭环**（4–6 周） | Monorepo、后端（auth/用户/书库/上传/下载）、客户端壳（Web+桌面）、EPUB 导入与阅读、进度上报 | Web 与 Windows 上能导入 EPUB、阅读、进度存服务端 |
| **M2 多格式与标注同步**（4–6 周） | PDF/TXT/MOBI/AZW3、标注笔记、同步引擎（push/pull/冲突 UI） | 两设备乱序操作后收敛；PDF 可读可标注 |
| **M3 移动端与适配**（4 周） | Android/iOS 构建、横竖屏适配矩阵、离线队列、安全区 | 适配矩阵 6 视口 × 2 模式走查通过 |
| **M4 书源体系**（3 周） | 规则引擎、书源管理 UI、合法内置源、下载入库、元数据补全 | Gutenberg 搜索→下载→入库全链路 |
| **M5 LLM 能力**（4–6 周） | AI 网关、划词/整章翻译、双语对照、实体档案、摘要 | 生成人名表并影响后续翻译一致性 |
| **M6 多用户运营**（4 周） | 配额、管理后台、审计、备份脚本、监控、发布链路 | 备份恢复演练成功；管理后台可管用户 |

---

## 10. 技术风险与缓解
| 风险 | 等级 | 缓解 |
|---|---|---|
| Tauri v2 移动端成熟度不足（插件缺失、后台限制） | 中高 | **M0/M1 立即做技术验证**：Android + iOS 各出一个能打开 EPUB 的最小包；若不达标，移动端改用 Capacitor 或 PWA |
| foliate-js 上游停滞 + 长尾排版兼容 | 高 | 自持 fork；自建格式样本库与回归；保留替换为 Readium ts-toolkit 的接口边界（渲染层只暴露 reader-core 接口） |
| 旧版 Android WebView 白屏（e-ink / 国产 ROM / 无 GMS 设备） | 高 | **M2 Go/No-Go 决策点**；预案：WebView 升级路径、降级渲染、或移动端 Readium Swift/Kotlin 原生双栈 |
| Web 端 SQLite/WASM 性能与存储配额 | 中 | OPFS + 单写者队列；大书按需解包，不全量入库 |
| 同步正确性（最难出错的地方） | 高 | 属性测试 + 明确合并规则表 + 客户端可重建（snapshot 兜底） |
| iOS 上架与签名 | 中 | 无 Mac 则先出 PWA/TestFlight；把 iOS 放到 M3 末 |
| 单机单点故障 | 中 | 全量备份 + 镜像化部署 + 快速重建脚本 |
| LLM 成本失控 | 中 | 缓存 + 配额 + 模型路由 + BYOK |
| 恶意电子书/XSS | 高 | L1 解压预算 + L2 净化与逐节 CSP（主力，确定可达）+ L3 去 allow-scripts + L4 窗口限权 + L5 结构化渲染兜底；以 task-6 的 20 条 PoC 作为 M1 验收门槛 |

---

## 11. 待你确认的决策点

见 docs/OPEN-QUESTIONS.md（共 12 题）。**按紧迫度排序：**

| 优先级 | 题 | 为什么紧迫 |
|---|---|---|
| 🔴 阻塞 | **Q10** 隔离架构：批准 1–2 天收尾 PoC（C-01/C-09 两门）？失败是否启用 A5 退路？ | 决定渲染层能不能开工 |
| 🔴 阻塞 | **Q1 剩余 4 项**：CPU/内存/磁盘/带宽、操作系统、大陆或境外、有无对象存储 | 决定部署形态与能否直连境外模型 API |
| 🟠 高 | **Q12** 移动端策略：接受「不阻塞主线、按 Spike 结果决定形态」吗？ | 决定 M1 范围与排期风险 |
| 🟠 高 | **Q11** 后端语言：Go（弱推荐）还是 TypeScript（原方案未被推翻）？ | 决定 monorepo 结构与 CI |
| 🟡 中 | **Q4** 自研 vs fork Readest（AGPL）；**Q5** Z-Library 立场；**Q6** 平台优先级 | 决定法务边界与工作量 |
| 🟢 低 | Q2 规模、Q3 上架、Q7 LLM 预算、Q8 人力、Q9 现有资产 | 可后置 |

**两个前置闸门（批准后才动工程）**：**G1** 移动端 Spike（2–3 天）、**G2** 隔离 PoC（1–2 天）。两者都是验证性工作，不写业务代码。

---

## 12. 当前状态声明
> 本阶段**只有文档**：docs/DESIGN.md、docs/TECH-PLAN.md、docs/OPEN-QUESTIONS.md、docs/ADR-001~003、docs/research/10~70。**未初始化任何工程、未写任何业务代码。**
>
> 调研进度（2026-11-02）：7 个研究任务全部完成，共 4 份专题报告（客户端框架 / 后端同步 / 格式与法务 / Wails v3 / Vue 3 / 隔离可行性，其中后三份为本次决策变更后新增）。
>
> **下一步（等你批准）**：① G2 隔离 PoC 1–2 天（验 C-01 中间件能否拦到 /wails/runtime、C-09 `x-wails-window-id` 可否伪造）；② G1 移动端 Spike 2–3 天（iOS/Android 真机 + e-ink 机型）；③ 两者通过后进入 M1 项目初始化。
>
> 环境前置：需安装 **Go 1.26+** 与 **pnpm**（当前机器均未安装）。
