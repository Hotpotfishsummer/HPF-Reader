# HPF-Reader

自托管的全平台阅读器：**Go 服务端（Docker 部署）+ Vue 3 / Wails v3 客户端（桌面与移动）**。
对标 Readest，但后端自建、数据自持，支持多用户、进度同步、LLM 辅助阅读。

> 当前阶段：核心里程碑已全量交付（M1 ~ M5 / P0 ~ P4）。完整方案、交付报告与调研底稿见
> [docs/README.md](docs/README.md)。

---

## 核心特性

- **本地优先阅读**：离线开书、横竖屏自适应排版、字体字号主题、高亮与划线笔记。
- **双语与翻译**：划词流式翻译、整书后台翻译、双语对照视图、按章导出 Markdown。
- **云端与同步**：账户体系、内容寻址秒传、Readium Locator + HLC 权威进度/书签漫游、标注跨端同步。
- **公版书源**：Project Gutenberg / Standard Ebooks OPDS 检索与一键入库（SSRF 与 DNS 重绑定防护）。
- **AI 辅助**：双维度成本与配额闸门、断点续跑、服务端术语表、确定性人名归一化。
- **安全隔离**：内容 L2 隔离（同源 iframe + 逐节净化 + 逐节严格 meta CSP），兼容老旧 WebView。

## 仓库结构

```
HPF-Reader/
├─ api/openapi.yaml       # 唯一跨端契约（服务端与客户端都以此为准）
├─ apps/
│  ├─ server/             # Go 服务端（chi + pgx + sqlc + goose + JWT）
│  └─ client/             # Wails v3 外壳 + Vue 3 前端 + foliate-js 渲染内核
├─ deploy/                # docker-compose / Caddyfile / .env.example
├─ scripts/               # 构建管线与本机环境脚本
├─ docs/                  # 设计、方案、ADR 与调研报告
├─ tests/integration/     # 跨端全链路集成测试
└─ spikes/                # 一次性验证工程（隔离 PoC 等）
```

## 技术选型

| 层 | 选型 | 依据 |
|---|---|---|
| 服务端 | Go 1.26 + chi + pgx + sqlc + goose + PostgreSQL 16 + Redis + MinIO | 用户决策 + [ADR-002](docs/ADR-002-客户端落地-Vue与Wails.md) |
| 部署 | Docker Compose（Caddy 自动 HTTPS） | 用户决策 |
| 客户端外壳 | Wails v3（Go），桌面 + 移动，另有 server 构建可做 Web | [ADR-002](docs/ADR-002-客户端落地-Vue与Wails.md) |
| 前端 | Vue 3.5 + Vite + Pinia + Reka UI + Tailwind | [50-vue3-reader-stack.md](docs/research/50-vue3-reader-stack.md) |
| 渲染内核 | foliate-js（MIT，**自持 fork 固定 commit**） | 同上 |
| 内容隔离 | L1–L5 分层，主力为「同源 iframe + 逐节净化 + 逐节 meta CSP」 | [ADR-003](docs/ADR-003-内容隔离架构.md) |
| 同步 | Readium Locator + HLC + 服务端权威合并 + 单调游标 | [TECH-PLAN.md](docs/TECH-PLAN.md) §4.3 |

## 开发环境

本机工具链（完整定义见 `scripts/dev-env.ps1`）：

| 工具 | 路径 / 用法 |
|---|---|
| Go | `C:\Users\HOTPOTFISH\go-portable\go\bin\go.exe`（1.22.10，靠 `GOTOOLCHAIN=auto` 自动切到 go1.26） |
| wails3 CLI | `C:\Users\HOTPOTFISH\go\bin\wails3.exe`（v3.1.0） |
| Node.js | `C:\Program Files\nodejs\node.exe`（v24.20.0） |
| pnpm | `corepack pnpm <args>`（12.16.1；不要直接用 `npm`，会破坏 pnpm 的 node_modules 布局） |
| Docker | Docker Desktop + Compose v2 |
| JDK | `C:\Program Files\Microsoft\jdk-21.0.4.7-hotspot`（Android 构建用） |
| Android SDK | `C:\Users\HOTPOTFISH\AppData\Local\Android\Sdk` |
| GOPROXY | `https://goproxy.cn`（国内镜像，由 `dev-env.ps1` 设置） |

```powershell
. .\scripts\dev-env.ps1   # 每个新终端先导入环境
```

## 构建与测试管线（交付前强制）

> **规则（用户指定）**：任何开发更新（前端、客户端 Go、服务端 Go）完成后，交付前必须执行
> 最新的前端与后端构建并生成可执行文件；不得只重建前端 `dist/` 而不重编 exe。

```powershell
# 一键全栈构建：前端 dist + 服务端 api.exe/migrate.exe + 客户端 client.exe/bin/hpfreader.exe
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1

# 只改前端/客户端时，可只跑客户端构建（重建 dist 并校验 exe 嵌入最新前端）
powershell -ExecutionPolicy Bypass -File .\scripts\build-client.ps1
```

两个脚本都会：校验每步原生命令退出码、构建前清空 `dist/`、对产物做存在性/大小/SHA-256 断言，
并从 exe 二进制中验证**最新前端产物确实被嵌入**，任一步失败即抛错终止（杜绝「假成功」）。

单独测试与开发：

```powershell
# 前端：类型检查 + 单元测试
corepack pnpm --dir apps/client/frontend run typecheck
corepack pnpm --dir apps/client/frontend run test

# 服务端：编译 / 静态检查 / 单测
cd apps/server
go build ./... && go vet ./... && go test ./... -count=1

# 客户端开发热重载
cd apps/client
& $env:HPF_WAILS3 dev
```

## 部署

在仓库根目录：

```powershell
docker compose -f deploy\docker-compose.yml up -d
```

配置与运维详见 [deploy/README.md](deploy/README.md)。

## 交付状态

| 阶段 / 闸门 | 核心交付 | 验证 | 状态 |
|---|---|---|---|
| G2 内容安全隔离 | L2 内容隔离：同源 iframe + 逐节净化 + 逐节严格 meta CSP，消除 Wails 桥越权通路 | `spikes/isolation/` + sanitize 单元测试 | ✅ |
| G1 移动与兼容性 | Android (API 29~31 / WebView 91) 三大硬阻塞全解：内置 polyfill、deflate-raw 兜底、`@layer` 扁平化 | 客户端 STATUS §9–§10 + 双 ABI APK | ✅ |
| M1 / P0 阅读排版 | 离线阅读闭环、横竖屏自适应、主题、高亮划线 | 前端单测 + 真实 exe 截图 | ✅ |
| M2 / P1 双语与翻译 | 划词翻译、整书翻译、双语对照、按章导出 | SSE 链路测试 | ✅ |
| M3 / P2 云端与同步 | 账户、秒传、HLC 进度/书签、标注同步、双向文件同步 | 72 项跨端集成 + 95 项 Docker 冒烟 | ✅ |
| M4 / P3 公版书源 | Gutenberg / Standard Ebooks OPDS、SSRF 防护 | 服务端测试 | ✅ |
| M5 AI 加固与术语 | 双维度配额、断点续跑、术语表、人名归一化 | 真模型实测 | ✅ |
| P4 格式与外设 | TXT 分章、墨水屏模式、翻页键、TTS | 组件测试 | ✅ |

> 验证基线（最新一次全栈构建实测）：前端单测 **325 passed / 27 文件**、服务端 Go 测试 **230 个用例（含子测试 248 项）**、跨端集成 **72 项**、Docker 容器冒烟 **95 项**，全部通过。

## 文档

完整文档索引（设计、ADR、调研底稿、状态报告）见 **[docs/README.md](docs/README.md)**。
开发规范与强制构建规则见 **[AGENTS.md](AGENTS.md)**。
