# tests/ — 测试代码与测试资产

**所有测试都住在这里**（除框架强制同目录的单元测试，见下表）。`apps/` 只放生产代码，
不放测试用例、测试夹具、测试证据、测试工具。

## 目录职责

```
tests/
├─ e2e/            # Playwright 端到端用例（真实 Chrome + vite preview）
├─ integration/    # 跨端全链路集成测试（72 项断言，直打 Docker 后端）
├─ smoke/          # 黑盒脚本：Docker 容器内冒烟 + 上传/下载人工验证
├─ fixtures/books/ # 测试用真实公版书（Gutenberg）+ 自造的大书 / 单章超长书
├─ evidence/       # 测试产出的证据（入库，是交付材料的一部分）
│  ├─ client/      #   客户端侧：截图、性能 JSON、原始输出
│  └─ server/      #   服务端侧：抓包与原始响应
└─ tools/          # 测试专用工具：造夹具、抓证据
```

| 目录 | 放什么 | 不放什么 |
|---|---|---|
| `e2e/` | `*.spec.ts` 用例、共用的页面钩子（`reader-chrome.ts`） | 被应用 import 的源码 |
| `integration/` | 用例套件 `suite-*.ts`、驱动 `runner.ts` / `run-all.mjs`、`README.md` | 服务端业务逻辑 |
| `smoke/` | 在容器/真实服务上跑的黑盒脚本 | 单元测试 |
| `fixtures/` | 电子书、样例数据等**只读**素材 | 测试输出、可再造的构建镜像 |
| `evidence/` | 跑出来的截图 / JSON / 原始终端输出（**入库**，不是构建产物） | 可随时再生的产物（入 `tests/integration/.build/`，已被 gitignore） |
| `tools/` | 造夹具与抓证据的脚本 | 产品构建管线（那是仓库根 `scripts/`） |

## tools/ 里的工具

```powershell
# 造「大书」（20 章 × 120 段 + 120 张图）→ tests/fixtures/books/large-book.epub
node tests/tools/make-large-epub.mjs

# 造「单章超长书」（1 章 4000 段 + 400 张图）→ tests/fixtures/books/single-chapter-large.epub
node tests/tools/make-single-chapter-epub.mjs

# 抓一轮交付证据（build / 兼容审计 / 单测 / E2E 的原始命令与原始输出）
pwsh -NoProfile -File tests/tools/capture-evidence.ps1

# 在**真实运行的客户端**里点一次「Aa」排版按钮，验证面板能打开（需要 HPF_DEBUG_CDP）
#   客户端启动：set HPF_DEBUG_CDP=9222 && apps\client\client.exe
node tests/tools/verify-typography-panel.mjs --port 9222
pwsh -NoProfile -File tests/tools/capture-evidence.ps1 -SkipE2E
```

两个 `make-*.mjs` 都是零依赖脚本（只用 `node:zlib` 手写 ZIP），产物落在
`tests/fixtures/books/`，用于排版性能判别，**不要**把它们当交付素材。

## 为什么有些测试不在 tests/

这是**框架约束**，不是遗漏：

| 层 | 位置 | 为什么不能在 tests/ |
|---|---|---|
| Go 单元测试 | `apps/*/**/*_test.go` | Go 强制：`*_test.go` 必须与被测 `package` 同目录，否则编译不进该包 |
| 前端单元测试 | `apps/client/frontend/src/**/*.spec.ts` | vitest `include` 是 `src/**/*.spec.ts`，就近放置才能共用别名与类型上下文 |
| 前端架构闸门 | `apps/client/frontend/tests/architecture.spec.ts` | 它用 `node:fs` / `node:path` 扫源码树，而前端 tsconfig 的 `types` 只有 `vite/client`（没有 node 全局）；放进 `src/` 会被 `vue-tsc` 判 `TS2591`，只能待在 `src/` 之外、由 vitest 的 `tests/**` 收编 |
| Playwright 配置 | `apps/client/frontend/playwright.config.ts` | Node 从**配置文件所在目录**向上解析 `@playwright/test`，移到仓库根会解析失败 |
| vitest 配置 | `apps/client/frontend/vitest.config.ts` | 同上，且需要 vue 插件与 `@` 别名 |

除上表这几类，**任何新增测试都必须建在 `tests/` 下**（按上表选子目录），
不要往 `apps/` 里塞脚本、夹具或截图。

### 为什么 Go 单测必须与源码同目录（不是偷懒）

Go 里「一个 package = 一个目录下的所有 `.go` 文件」，目录边界就是包边界，**没有第二种含义**。
把 `apps/client/apirelay_test.go` 挪到任何子目录，必然撞上两条死路（实测报错原文）：

| 挪法 | 结果 |
|---|---|
| 挪到 `apirelay/` 里仍写 `package main`、调父包的 `parseRelayTarget()` | `undefined: parseRelayTarget` —— 子目录是**另一个包**，看不见父包的非导出标识符 |
| 挪到 `apirelay/` 里改写 `package apirelay`、去 `import` 父包 | `import "…/client" is a program, not an importable package` —— `apps/client` 是 `package main`，**main 包不可被 import**，因此它的测试在物理上无处可去 |

另外 `.test.go` 后缀是**构建约束**而非命名习惯：`go build` / `go run` / 我们的
`go build -tags production -o bin/hpfreader.exe .` 都不会编译它。
`go list` 会把同一目录的文件分成两组，可直接核对：

```
$ go list -f '{{.GoFiles}} | {{.TestGoFiles}}' .        # 在 apps/client 下
GoFiles     : [apirelay.go appservice.go … proxyservice_windows.go]   # 进 exe 的
TestGoFiles : [apirelay_earlyresponse_test.go apirelay_test.go … proxyservice_test.go]  # 只进测试二进制
```

所以 `apps/client/` 根目录里那 9 个 `*_test.go` 是**不可再分的最小混合集**：它们是源码包的
测试半边，不是「被误放进来的测试文件」。能被搬走的（e2e / 冒烟 / 集成 / 夹具 / 证据 / 工具）
已经全部搬到本目录了。

## 怎么跑

```powershell
# 端到端（先在 apps/client/frontend 下构建 dist，e2e 用 vite preview 起服务）
corepack pnpm --dir apps/client/frontend run build
corepack pnpm --dir apps/client/frontend run test:e2e

# 单跑某个用例
corepack pnpm --dir apps/client/frontend exec playwright test tests/e2e/reader.spec.ts

# 端到端 + Docker 冒烟 + 集成测试
powershell -ExecutionPolicy Bypass -File ./scripts/test-integration.ps1

# 只跑 Docker 内 95 项冒烟
powershell -ExecutionPolicy Bypass -File ./scripts/test-integration.ps1 -RunSmokeDocker

# 黑盒验证脚本（需先起服务端）
pwsh -File .\tests\smoke\verify-book-download.ps1 -Base http://127.0.0.1:8099
pwsh -File .\tests\smoke\verify-upload-dedup-ab.ps1 -OldExe a.exe -NewExe b.exe
```

## 路径约定（改目录前必读）

**spec 里的路径用 `process.cwd()` 解析，而 `cwd` 恒为 `apps/client/frontend/`**
（Playwright 由该目录的 config 启动）。因此：

- 仓库根 → `path.resolve(process.cwd(), '../../..')`
- 书 → `path.join(REPO_ROOT, 'tests', 'fixtures', 'books', ...)`
- 证据 → `path.resolve(process.cwd(), '../../../tests/evidence/client')`

`playwright.config.ts` 里对应写的是 `testDir: '../../../tests/e2e'`。

## 证据目录

`tests/evidence/` 由测试写入，内容**入库**（是交付证据的一部分，不是构建产物）。
如果只想留最近一次结果，先清空对应子目录再跑。

> 历史证据（`tests/evidence/**` 里 `task-*.txt`、`*-2026-11-12.*` 等）记录的是**当时的**路径与输出，
> 搬迁目录后**不要回改**它们，否则等于篡改证据。
