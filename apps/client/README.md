# HPF Reader 桌面客户端

HPF-Reader 的桌面客户端：**Wails v3 外壳** + **Vue 3 / Vite / Tailwind 4 前端** +
**foliate-js** 阅读内核（vendored 在 `frontend/src/vendor/foliate-js`）。

## 快速开始

**完整管线（环境前提、开发、测试、构建、排障）见 [STATUS.md §3](STATUS.md#3-开发测试与编译调试管线windows--powershell)**，
这是唯一权威说明。这里只给最常用的几条：

```powershell
# 前端热重载（浏览器里直接看，不需要 Go 侧）
cd frontend
corepack pnpm install
corepack pnpm run dev          # → http://127.0.0.1:9245/#/reader/sample

# 类型检查 + 单元测试 + E2E
corepack pnpm exec vue-tsc --noEmit
corepack pnpm run test
corepack pnpm run test:e2e

# 构建全部产物（前端 dist + 桌面 exe；改了服务端则跑全栈构建）
# ① 只改前端/客户端：一键客户端构建（重建 dist 并验证 exe 嵌入最新前端）
powershell -ExecutionPolicy Bypass -File ../scripts/build-client.ps1

# ② 全栈（前端 + 服务端 + 客户端）：交付前推荐入口
powershell -ExecutionPolicy Bypass -File ../scripts/build-all.ps1

.\bin\hpfreader.exe
```

> ★ **关键事实**：前端通过 `main.go` 的 `//go:embed all:frontend/dist` **在编译期嵌入**
> exe（`application.AssetFileServerFS` 从嵌入的 FS 提供资源）。**只改前端不重编 exe，
> 桌面应用不会生效**——必须先 `pnpm run build` 再 `go build`。细节见 STATUS.md §3.3；
> `build-client.ps1` 还会用 `dist/index.html` 的主入口产物路径校验 exe 确实嵌入了最新前端，
> 并保证 `client.exe` 与 `bin/hpfreader.exe` 的 SHA-256 一致。

## 目录

- `main.go`：Wails 入口；`//go:embed all:frontend/dist` 嵌入前端产物
- `frontend/`：Vue 3 前端（阅读器、书库、设置、AI 功能、性能测量台）
- `libraryservice.go` / `proxyservice.go`：Go 侧服务（书库、代理）
- `bin/hpfreader.exe`：构建产物（编译期嵌入当时的 `frontend/dist`）

## 文档

- **[STATUS.md](STATUS.md)**：项目状态、关键决策、踩坑记录、各轮优化详情
  （§11 动效/高刷适配、§12 状态栏/目录默认收起、§13 排版性能排查与修复）
- **[frontend/README.md](frontend/README.md)**：前端 IDE 与 `.vue` 类型配置
