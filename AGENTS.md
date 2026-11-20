# HPF-Reader Agent Guidelines & Workspace Rules

本项目规则由所有在 HPF-Reader 代码库中工作的 AI Agent 必须严格遵守。

---

## 核心强制要求：修改后必须自动构建新版本客户端 EXE

> **重要规则（用户指定）**：
> 凡是修改、修复或调整了客户端代码（包括 `apps/client/frontend` 前端界面、组件、样式、逻辑，以及 `apps/client` 的 Go 桌面外壳代码），**在交付回答前必须自动重新构建最新的客户端 EXE**。
> 不能只改源码不打包，必须保证最终的 `apps/client/client.exe` 和 `apps/client/bin/hpfreader.exe` 包含最新修改！

### 一键构建命令

在仓库根目录下执行：
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-client.ps1
```

### 标准完整构建步骤

如果分步执行，必须按以下顺序：
1. **加载开发环境**（本机专用 Go 与 Wails3 路径）：
   ```powershell
   . .\scripts\dev-env.ps1
   ```
2. **构建前端并更新 dist**：
   ```powershell
   cd apps\client\frontend
   npm run build
   ```
   *(产物输出到 `apps/client/frontend/dist`，将被 Go 的 `//go:embed all:frontend/dist` 打进二进制)*
3. **编译并输出最新版客户端 EXE**：
   ```powershell
   cd apps\client
   go build -trimpath -tags production -ldflags="-w -s -H windowsgui" -o bin/hpfreader.exe .
   Copy-Item bin/hpfreader.exe client.exe -Force
   ```

---

## 质量与测试保证

- **前端单元测试**：修改前端代码后确保测试通过：
  ```powershell
  npm --prefix apps/client/frontend run test
  ```
- **TypeScript 类型检查**：确保 0 报错：
  ```powershell
  npm --prefix apps/client/frontend run typecheck
  ```

---

## 开发环境参考路径

- **Go 1.22/1.26**：`C:\Users\HOTPOTFISH\go-portable\go\bin\go.exe`
- **Wails3 CLI**：`C:\Users\HOTPOTFISH\go\bin\wails3.exe`
- **Node.js**：`C:\Program Files\nodejs\node.exe`
- **环境变量脚本**：`.\scripts\dev-env.ps1`
