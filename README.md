# HPF-Reader

自托管的全平台阅读器：**Go 服务端（Docker 部署）+ Vue 3 / Wails v3 客户端（桌面与移动）**。
对标 Readest，但后端自建、数据自持，支持多用户、进度同步、LLM 辅助阅读。

> 当前阶段：**核心里程碑已全量交付（M1 ~ M5 / P0 ~ P4 全部完成并通过端到端实测验证）**。完整方案与状态索引见 [docs/README.md](docs/README.md)。

---

## 仓库结构

```
HPF-Reader/
├─ api/openapi.yaml       # 唯一跨端契约（服务端与客户端都以此为准）
├─ apps/
│  ├─ server/             # Go 服务端（chi + pgx + sqlc + goose + JWT）
│  └─ client/             # Wails v3 外壳 + Vue 3 前端 + foliate-js 渲染内核
├─ deploy/                # docker-compose / Caddyfile / .env.example
├─ spikes/                # 一次性验证工程（隔离 PoC 等）
├─ scripts/dev-env.ps1    # 本机环境变量（Go / wails3 / JDK / Android SDK）
└─ docs/                  # 调研报告、设计、技术方案、ADR
```

## 已定的技术选型

| 层 | 选型 | 依据 |
|---|---|---|
| 服务端 | Go 1.26 + chi + pgx + sqlc + goose + PostgreSQL 16 + Redis + MinIO | 用户决策 + [ADR-002](docs/ADR-002-客户端落地-Vue与Wails.md) |
| 部署 | Docker Compose（Caddy 自动 HTTPS） | 用户决策 |
| 客户端外壳 | Wails v3（Go），桌面 + 移动，另有 server 构建可做 Web | [ADR-002](docs/ADR-002-客户端落地-Vue与Wails.md) |
| 前端 | Vue 3.5 + Vite + Pinia + Reka UI + Tailwind | [50-vue3-reader-stack.md](docs/research/50-vue3-reader-stack.md) |
| 渲染内核 | foliate-js（MIT，**自持 fork 固定 commit**） | 同上 |
| 内容隔离 | L1–L5 分层，主力为「同源 iframe + 逐节净化 + 逐节 meta CSP」 | [ADR-003](docs/ADR-003-内容隔离架构.md) |
| 同步 | Readium Locator + HLC + 服务端权威合并 + 单调游标 | docs/TECH-PLAN.md §4.3 |

## 本机环境（已探测，无需再找）

| 工具 | 路径 / 用法 |
|---|---|
| Go | `C:\Users\HOTPOTFISH\go-portable\go\bin\go.exe`（1.22.10，靠 `GOTOOLCHAIN=auto` 自动切到 go1.26.10） |
| wails3 CLI | `C:\Users\HOTPOTFISH\go\bin\wails3.exe`（v3.1.0） |
| pnpm | `corepack pnpm <args>`（12.16.1，**不要直接用 pnpm**） |
| Node | `C:\Program Files\nodejs\node.exe`（v24.20.0） |
| Docker | Docker Desktop，已启动；Compose v2.39.2 |
| JDK | `C:\Program Files\Microsoft\jdk-21.0.4.7-hotspot`（Android 构建用） |
| Android SDK | `C:\Users\HOTPOTFISH\AppData\Local\Android\Sdk` |
| GOPROXY | `https://goproxy.cn`（国内镜像） |

### 开工前

```powershell
. .\scripts\dev-env.ps1
```

## 开发命令

```powershell
# 一键全栈构建与测试
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1

# 一键自动构建客户端最新版 EXE（修改前端或客户端后必跑）
powershell -ExecutionPolicy Bypass -File .\scripts\build-client.ps1

# 服务端
cd apps\server
go build ./...
go test ./...
go run ./cmd/api

# 客户端
cd apps\client
& $env:HPF_WAILS3 dev

# 部署（在仓库根）
docker compose -f deploy\docker-compose.yml up -d
```

> **开发规范（强制要求）**：凡是修改或修复了客户端前端或 Go 客户端代码，必须自动重新构建最新版本 EXE（运行 `.\scripts\build-client.ps1`），确保 `apps/client/client.exe` 和 `apps/client/bin/hpfreader.exe` 始终为最新构建。详细 Agent 规范见 [AGENTS.md](AGENTS.md)。

## 核心里程碑与交付状态

| 阶段 / 闸门 | 核心交付内容 | 验证与证据 | 状态 |
|---|---|---|---|
| **G2 内容安全隔离** | L2 内容隔离方案定案：同源 iframe + 逐节净化 + 逐节严格 meta CSP；消除 Wails 桥越权通路 | `spikes/isolation/` + 23 项 sanitize 单元测试 | ✅ 已完成并落地 |
| **G1 移动与兼容性** | Android (API 29~31 / WebView 91) 3个硬阻塞全解（builtin polyfill、deflate-raw 兜底、@layer 扁平化） | `apps/client/STATUS.md` §9-§10 + 双 ABI APK | ✅ 已完成并落地 |
| **M1 / P0 阅读排版** | 本地优先离线阅读闭环、横竖屏自适应双栏/单栏、字体字号主题切换、4色高亮与划线笔记 | 真实 `hpfreader.exe` 截图 + 172 项前端单测 | ✅ 已完成并落地 |
| **M2 / P1 双语与翻译** | 划词流式翻译气泡、整书后台任务翻译、双语对照阅读视图、分章节导出 Markdown | `api/openapi.yaml` + SSE 链路测试 | ✅ 已完成并落地 |
| **M3 / P2 云端与同步** | 账户登录/注册、CAS 内容寻址秒传、HLC 权威进度与书签漫游、标注跨端同步、云端书籍文件双向同步、服务器地址可配置 | 72 项跨端集成测试 + 95 项 Docker 冒烟测试 | ✅ 已完成并落地 |
| **M4 / P3 公版书源** | Project Gutenberg + Standard Ebooks OPDS 检索与一键入库、SSRF 与 DNS 重绑定防护 | `apps/server/STATUS.md` §8 | ✅ 已完成并落地 |
| **M5 AI 加固与术语** | 双维度成本与配额闸门（429 区分 calls/tokens）、断点续跑、服务端术语表、人名归一化与可重放修正日志 | `apps/server/STATUS.md` §7, §9, §10 + 真模型实测 | ✅ 已完成并落地 |
| **P4 格式扩展与外设** | TXT 智能分章转码、墨水屏（E-ink）零残影无动画高对比度模式、物理翻页键映射、TTS 语音朗读 | `txtParser.ts` + `TtsPlayer.vue` + 快捷键映射 | ✅ 已完成并落地 |

## 文档索引

见 [docs/README.md](docs/README.md)。
