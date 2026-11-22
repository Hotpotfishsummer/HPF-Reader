# HPF-Reader Agent Guidelines & Workspace Rules

本项目规则由所有在 HPF-Reader 代码库中工作的 AI Agent 必须严格遵守。

---

## 核心强制要求：任何开发更新后必须重建全部产物（前端 + 后端 + EXE）

> **重要规则（用户指定）**
>
> 以后**所有开发更新操作**（前端、客户端 Go、服务端 Go 的修改、修复、调整）完成后，
> **在交付回答前必须执行最新的前端与后端构建，并生成可执行文件**。
> 不允许只改源码不打包；不允许出现「只更新/编译了前端 dist、桌面 exe 里还是旧前端」的情况。

### 一键构建命令（交付前必跑）

在仓库根目录下执行（一次完成前端 + 服务端 + 客户端 EXE）：

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/build-all.ps1
```

`build-all.ps1` 会按顺序重建：前端 `dist` → 服务端 `api.exe` / `migrate.exe` → 客户端
`bin/hpfreader.exe` 与 `client.exe`。每一步都校验原生命令退出码与产物，任何一步失败都会直接抛错
终止（杜绝「假成功」）。

若只改了前端 / 客户端，也可只跑客户端构建：

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/build-client.ps1
```

该脚本先清空并重建 `frontend/dist`，再重编 exe，并**从 exe 二进制里验证最新前端产物确实被嵌入**。

### 交付验收标准

| 产物 | 要求 |
|---|---|
| `apps/client/frontend/dist/index.html` | 为本次最新构建 |
| `apps/server/bin/api.exe` | 为本次最新编译 |
| `apps/server/bin/migrate.exe` | 为本次最新编译 |
| `apps/client/bin/hpfreader.exe` | 为本次最新编译，且嵌入最新前端产物 |
| `apps/client/client.exe` | 与 `bin/hpfreader.exe` SHA-256 相同 |

---

## 质量与测试保证

| 检查 | 命令 |
|---|---|
| 前端单元测试 | `corepack pnpm --dir apps/client/frontend run test` |
| 前端类型检查（0 报错） | `corepack pnpm --dir apps/client/frontend run typecheck` |
| 服务端单元测试 | `cd apps/server; go test ./... -count=1` |
| 服务端编译与静态检查 | `cd apps/server; go build ./...; go vet ./...` |
| 跨端集成测试 | `powershell -ExecutionPolicy Bypass -File ./scripts/test-integration.ps1` |

---

## 标准完整构建步骤（不用一键脚本时，必须按此顺序）

```powershell
# 1. 加载开发环境
. ./scripts/dev-env.ps1

# 2. 构建前端并更新 dist（被 //go:embed all:frontend/dist 打进二进制）
cd apps/client/frontend
corepack pnpm run build

# 3. 编译服务端 exe
cd ../../server
go build -trimpath -o bin/api.exe ./cmd/api
go build -trimpath -o bin/migrate.exe ./cmd/migrate

# 4. 编译客户端 exe
cd ../client
go build -trimpath -tags production -ldflags="-w -s -H windowsgui" -o bin/hpfreader.exe .
Copy-Item bin/hpfreader.exe client.exe -Force
```

> ⚠️ **顺序不可颠倒**：`main.go` 用 `//go:embed all:frontend/dist` 在**编译期**嵌入前端，
> 所以必须先 `pnpm run build` 再 `go build`，否则嵌进去的是旧 `dist`。

---

## 开发环境参考路径

| 工具 | 路径 / 用法 |
|---|---|
| Go 1.22 / 1.26 | `C:/Users/HOTPOTFISH/go-portable/go/bin/go.exe`（`GOTOOLCHAIN=auto`） |
| Wails3 CLI | `C:/Users/HOTPOTFISH/go/bin/wails3.exe` |
| Node.js | `C:/Program Files/nodejs/node.exe` |
| 包管理器 | 一律用 `corepack pnpm`（仓库为 pnpm 布局，不要用 `npm install`） |
| 环境变量脚本 | `./scripts/dev-env.ps1` |

---

## 文档入口

- [README.md](README.md)：项目总览、技术选型、构建与测试管线、交付状态。
- [docs/README.md](docs/README.md)：完整文档索引（设计、ADR、调研底稿、状态报告）。
