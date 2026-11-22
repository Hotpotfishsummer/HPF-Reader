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

## 核心强制要求：各类工作放进各自专门的目录（不得混放）

> **重要规则（用户指定）**
>
> 生产代码、测试代码、一次性验证、构建脚本、文档、设计素材**必须各自住在专门的目录**。
> 新增任何文件前先问「它属于哪一类」，再按下面的地图落位；**不要**因为「顺手」就塞进
> `apps/`（尤其是 `apps/client/frontend/scripts/` 与 `src/`）或仓库根。

### 目录地图（唯一权威）

| 目录 | 只放什么 | 不该出现在这里 |
|---|---|---|
| `api/` | 跨端契约 `openapi.yaml`（只读权威源） | 生成的类型（属 `apps/client/frontend/src/api/schema.d.ts`） |
| `apps/server/` | Go 服务端生产代码 + 同目录 `*_test.go` 单元测试 | E2E / 冒烟 / 集成用例、截图、测试书、测试工具 |
| `apps/client/` | Wails 外壳 + Vue 前端生产代码 + 同目录单元测试 | E2E 用例、测试证据、测试夹具、造夹具/抓证据脚本 |
| `apps/client/frontend/scripts/` | 前端**构建 / 代码生成 / 构建质量门禁**（`gen-api-types`、`audit-builtins`、`make-sample-epub`） | 造测试夹具、抓测试证据的脚本（→ `tests/tools/`） |
| `scripts/` | 仓库级构建、部署、环境、运维脚本（产品管线） | 测试用例、测试证据 |
| `tests/` | **全部测试**：`e2e/` `integration/` `smoke/` `fixtures/` `evidence/` `tools/` | 被应用 import 的源码 |
| `spikes/` | 一次性验证工程（PoC / 可行性实验），可丢弃、不进主管线 | 生产代码依赖 |
| `assets/` | 设计源素材（图标源图等） | 运行时资源（运行时资源在 `frontend/public/` 或 `apps/client/build/`） |
| `deploy/` | compose / Caddyfile / 环境模板 / 部署文档 | 测试脚本 |
| `docs/` | 设计、ADR、调研、状态报告、文档索引 | 可执行代码 |

### 落位判定（照着做）

1. **会被打进产物 / 被应用 import** → `apps/`
2. **验证行为、造测试数据、抓测试证据** → `tests/`（再选 `e2e` / `integration` / `smoke` / `fixtures` / `evidence` / `tools`）
3. **构建、打包、部署、环境** → `scripts/` 或 `deploy/`
4. **一次性可行性实验 + 留档结论** → `spikes/<主题>/`
5. **只对某个产物目录才有意义的工具**（审计 `dist`、生成 `public/` 资产）→ 留在该包内 `scripts/`

### 框架强制的例外（允许留在 `apps/`，不要搬）

- Go `*_test.go` 必须与被测 `package` 同目录，否则编译不进该包。
- 前端单测就近放 `src/**/*.spec.ts`（vitest `include` 只认 `src/**` 与 `tests/**`）。
- `apps/client/frontend/playwright.config.ts` / `vitest.config.ts` 必须留在前端包内
  （Node 从**配置文件所在目录**向上解析 `@playwright/test` 等依赖）。
- `apps/client/frontend/tests/architecture.spec.ts` 用 `node:fs` 扫源码树，而前端 tsconfig 的
  `types` 只有 `vite/client`（无 node 全局）；搬进 `src/` 会让 `vue-tsc` 报 `TS2591`。

> 除以上几类，**任何新增测试都必须建在 `tests/` 下**。完整说明与运行方式见
> [tests/README.md](tests/README.md)。

---

## 质量与测试保证

| 检查 | 命令 |
|---|---|
| 前端单元测试 | `corepack pnpm --dir apps/client/frontend run test` |
| 前端类型检查（0 报错） | `corepack pnpm --dir apps/client/frontend run typecheck` |
| 服务端单元测试 | `cd apps/server; go test ./... -count=1` |
| 服务端编译与静态检查 | `cd apps/server; go build ./...; go vet ./...` |
| 端到端（Playwright，需先构建 `dist`） | `corepack pnpm --dir apps/client/frontend run test:e2e` |
| Docker 容器冒烟（95 项） | `powershell -ExecutionPolicy Bypass -File ./scripts/test-integration.ps1 -RunSmokeDocker` |
| 跨端集成测试（72 项） | `powershell -ExecutionPolicy Bypass -File ./scripts/test-integration.ps1` |

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
- [tests/README.md](tests/README.md)：测试目录职责、运行方式、框架强制例外。
- [docs/README.md](docs/README.md)：完整文档索引（设计、ADR、调研底稿、状态报告）。
