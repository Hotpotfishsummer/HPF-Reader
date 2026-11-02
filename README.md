# HPF-Reader

自托管的全平台阅读器：**Go 服务端（Docker 部署）+ Vue 3 / Wails v3 客户端（桌面与移动）**。
对标 Readest，但后端自建、数据自持，支持多用户、进度同步、LLM 辅助阅读。

> 当前阶段：**开发中**（骨架搭建）。方案与调研见 [docs/](docs/README.md)。

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

## 排期闸门

| 闸门 | 内容 | 状态 |
|---|---|---|
| G2 隔离 PoC | C-01 中间件能否拦到 `/wails/runtime`；C-09 窗口头可否伪造 | 进行中（spikes/isolation） |
| G1 移动端 | iOS/Android 真机 + e-ink 机型验证（**Windows 上无法构建 iOS**，需 macOS） | 待 G2 后启动 |
| M1 | 骨架与阅读闭环 | 进行中 |

## 文档索引

见 [docs/README.md](docs/README.md)。
