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

# 构建桌面 exe（顺序不能错：先 build 前端，再 go build）
cd ..
corepack pnpm --dir frontend run build
go build -o bin\hpfreader.exe .
.\bin\hpfreader.exe
```

> ★ **关键事实**：前端通过 `main.go` 的 `//go:embed all:frontend/dist` **在编译期嵌入**
> exe（`application.AssetFileServerFS` 从嵌入的 FS 提供资源）。**只改前端不重编 exe，
> 桌面应用不会生效**——必须先 `pnpm run build` 再 `go build`。细节见 STATUS.md §3.3。

## 目录

- `main.go`：Wails 入口；`//go:embed all:frontend/dist` 嵌入前端产物
- `frontend/`：Vue 3 前端（阅读器、书库、设置、AI 功能、性能测量台）
- `libraryservice.go` / `proxyservice.go`：Go 侧服务（书库、代理）
- `bin/hpfreader.exe`：构建产物（编译期嵌入当时的 `frontend/dist`）

## 文档

- **[STATUS.md](STATUS.md)**：项目状态、关键决策、踩坑记录、各轮优化详情
  （§11 动效/高刷适配、§12 状态栏/目录默认收起、§13 排版性能排查与修复）
- **[frontend/README.md](frontend/README.md)**：前端 IDE 与 `.vue` 类型配置
