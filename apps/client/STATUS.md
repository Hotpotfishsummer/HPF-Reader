# apps/client 交付状态

> 覆盖 **task-9**（客户端骨架）、**task-12**（本地优先阅读闭环 + 横竖屏自适应）、
> **task-14**（老旧 WebView 兼容性）、**task-17**（`@layer` CSS 兼容性），
> 以及本轮的**动效 / 高刷适配 / 操作动线优化**（§11）。
> 最后核对时间：2026-11-21。
> 所有命令均在 Windows + PowerShell 下实测通过，原始输出见 `tests/evidence/client/`。

**状态：**
- task-9 骨架：已完成。
- task-12 阅读闭环 / 横竖屏：**已完成**（9/9 E2E 通过，含真实公版书）。
- task-14 老旧 WebView 兼容性：**已完成**（审计 + polyfill + 构建目标 + 单测 + E2E 模拟验证）。
- task-17 `@layer` 扁平化：**已完成**（§10，产物 CSS 中 `@layer` 由 5 → **0**）。
- task-12 的"真实 exe 截图"：**已完成**（4 张真实窗口截图，见 §8.3）。
- **动效 / 高刷适配 / 操作动线优化：已完成**（§11）。120 步拖动的重排耗时
  **902.8ms → 21.2ms**（真重排 240 次 → **2 次**），主线程长任务 **0** 次；
  单测 325 个、E2E 全绿。

**Android（WebView 91 / Android 12）的三个硬阻塞点，全部已解**：

| # | 阻塞点 | 类型 | 缺失版本 | 修法 | 详见 |
|---|--------|------|----------|------|------|
| 1 | `Object.groupBy` 等 14 个 builtin | JS 运行时 | Chrome 92~127 | 手写 polyfill | §9.1~9.6 |
| 2 | `DecompressionStream('deflate-raw')` | JS Web API 格式 | Chrome 103 | 复用 vendored fflate 窄兜底（**零新增依赖**） | §9.7 |
| 3 | **`@layer`**（Tailwind v4 输出） | **CSS 语法** | **Chrome 99** | **构建期扁平化** | **§10** |

> 关键教训：前两个能靠"运行时探测 + JS 兜底"解决，**第三个不能** —— CSS 无法 polyfill，
> 只能在构建期改写产物。所以兼容审计必须**同时扫源码和产物**，并覆盖
> **JS 能力 / CSS 语法 / Web API 格式**三类（前两次各漏了一类，见 §10.6）。

---

## 1. 已完成

### 1.1 外壳与工程结构

- [x] 真实 `hpfreader.exe` 窗口截图 4 张（§8.3，`PrintWindow` + `PW_RENDERFULLCONTENT`）。
- [x] `wails3 init`（v3.1.0）生成 vue 模板，产物**上提**到 `apps/client/` 根（模板默认会多套一层
      `apps/client/HPFReader/`，已拉平，见 §6 踩坑记录）。
- [x] `go.mod` module = `github.com/hotpotfish/hpfreader/client`；`main.go` 嵌入 `frontend/dist`。
- [x] 两个 Go service：`AppService`（版本/平台/数据目录）、`LibraryService`
      （书库 JSON 索引 + 进度 + 原生文件对话框 + `library:changed` 事件）。
- [x] `wails3 generate bindings -ts -i -clean=true` 生成前端 TS 绑定
      （2 services / 11 methods / 2 models / 1 event）。
- [x] `frontend/` 下 Vue 3.5 + Vite 8 + TS 6 + Tailwind 4 + Pinia + vue-router + vue-i18n +
      TanStack Query/Virtual + zod + reka-ui。

### 1.2 ★ L2 内容隔离（本任务的核心硬要求）

- [x] `frontend/src/reader/sanitize.ts`：挂在 `book.transformTarget` 的 `data` 事件上
      （foliate-js 里**唯一**早于解析的变换点）。
  - 删除 `script/iframe/frame/frameset/object/embed/applet/portal/foreignObject/base`
  - 删除全部 `on*` 事件属性与 `srcdoc`
  - URL 属性白名单：只允许 `data:`（仅栅格图片）、`blob:`、`about:`；
    **http/https/协议相对 `//` 一律拒绝**
  - CSS 文本净化（`url()` / `@import` 外链剔除）
  - 逐节注入 meta CSP：`default-src 'none'; script-src 'none'; img-src data: blob:; style-src 'unsafe-inline'`
  - **blob: 样式表内联**：foliate-js 把书籍 CSS 变成 `blob:` 的 `<link>`，
    严格 CSP 下会被拦；这里把它抓回来净化后内联成 `<style>` —— 既保排版又不放宽 CSP
- [x] `frontend/src/reader/__tests__/sanitize.spec.ts`：**23 个用例全绿**，
      其中包含 6 个恶意样本（内联 script / onerror / javascript: 链接 / 远程图片 /
      iframe+object+embed+foreignObject / CSS 外链），并逐字符断言 CSP 值。

### 1.3 阅读器（foliate-js 集成）

- [x] `frontend/src/vendor/foliate-js/`：**vendor 固定 commit**（npm 上同名包是冒名包），
      commit 与升级方法见 `frontend/src/vendor/foliate-js/VENDOR.md`。
- [x] `useFoliateEngine.ts`：**实例只放闭包普通变量**，对外只暴露方法；
      DOM 用 `markRaw(document.createElement('foliate-view'))`；
      `openSeq` + `WeakSet` 处理"打开途中换书"的竞态。
- [x] `coords.ts`：A(iframe 视口) → B(主文档视口) → C(主文档页面) 坐标换算集中一处。
- [x] `bridge.ts`：iframe 内 wheel / keydown / selectionchange 桥接（`AbortController` 统一清理）。
- [x] `ReaderView.vue`：工具栏、目录抽屉、主题**双写**（主文档 CSS 变量 + `renderer.setStyles`）、
      进度上报、划词提示条。
- [x] 内置示例书 `frontend/public/sample/sample.epub`（自带最小 ZIP writer 生成，
      含外部样式表用来验证 blob 内联路径）。

### 1.4 平台抽象

- [x] `src/platform/types.ts`（能力位 + 接口）、`desktop.ts`、`mobile.ts`、`server.ts`、
      `test.ts`、`index.ts`（宿主探测 + `usePlatform()`）。
- [x] **只有 `platform/desktop.ts` 与 `platform/mobile.ts` 可以 import bindings /
      `@wailsio/runtime`**，由 `tests/architecture.spec.ts` 自动卡住（4 个用例）。

### 1.5 契约与构建

- [x] `src/api/schema.d.ts` 由 `scripts/gen-api-types.mjs` 从 **`api/openapi.yaml`（只读）** 生成
      （1049 行），`corepack pnpm run api:types` 可复现。
- [x] `scripts/make-sample-epub.mjs`：零依赖生成示例 EPUB（`corepack pnpm run make:sample`）。

### 1.6 验证结果（实测）

> 下表是 **task-9 / task-12 首次交付当时**的快照，用于记录当时的实测事实，故数值保持原样。
> **当前最新基线**（每次全栈构建后由 `scripts/build-all.ps1` 重测）见文首摘要与文末「最新一轮验收」。

| 验证项 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | `corepack pnpm install` | ✅ 214 包 |
| 类型检查 + 构建 | `corepack pnpm run build` | ✅ `vue-tsc` 0 error，`vite build` 174 模块 / 883ms |
| 单元测试 | `corepack pnpm run test` | ✅ **27 passed**（23 sanitize + 4 架构），0 failed |
| E2E（真实 Chrome） | `corepack pnpm run test:e2e` | ✅ **2 passed** |
| Wails 生成绑定 | `wails3 generate bindings -ts -i -clean=true` | ✅ 11 methods |
| Go 编译 | `go build -o bin/hpfreader.exe .` | ✅ 18.5 MB |
| 完整 Wails 打包 | `wails3 build PACKAGE_MANAGER=pnpm` | ✅ `bin/hpfreader.exe` 11.5 MB（生产构建） |

E2E 在真实 Chromium 里断言的是**引擎的稳定输出**（不是截图比对）：

1. `foliate-view` 被创建，且 `lastLocation.cfi` 有值 → 分页真的完成了；
2. 章节文档里的 meta CSP **逐字符等于**要求的字符串；
3. 章节文档内 `<script>` = 0，远程 http(s)/协议相对引用 = 0；
4. 原来的 `<link rel=stylesheet>` 数量 = 0，样式文本出现在 `<style>` 里（内联生效）；
5. 点"下一页"后 `lastLocation.cfi` **发生变化**；
6. 无任何 JS 异常（唯一允许的网络 404 是 `POST /v1/sync/push`，因为 E2E 不启后端）。

---

## 2. 未完成 / 明确留给后续里程碑

| 项 | 原因 |
|---|---|
| 划词浮层的完整 UI（高亮/笔记/翻译） | M2；**坐标换算与事件桥已就绪**，M1 只保留"选中→复制"最小动作 |
| 原生移动端文件选择（SAF / UIDocumentPicker） | M2；`mobile.ts` 里已用 TODO 标出，能力位已声明 |
| 同步引擎的真实推拉 | Go 侧拥有真相（ADR-002 §4）；前端只做 `src/sync/engine.ts` 的 outbox 计数与 UI 适配 |
| PDF 支持 | M1 只验 EPUB。接入 PDF 要先处理 VENDOR.md 里记的 `import.meta.glob` 兼容问题 |
| `apps/server`（Web 目标）联调 | 超出 task-9 写范围；前端 `server.ts` 已按 `api/openapi.yaml` 写好，等后端就绪即可联调 |
| 打包成安装程序（MSIX/NSIS） | 需要额外工具链；本任务只要求"能编译" |
| `bin/`、`frontend/dist/`、`test-results/` | 构建产物，不应入库（`.gitignore` 已覆盖 `bin/` 与 `dist/`） |

---

## 3. 开发、测试与编译调试管线（Windows / PowerShell）

> 本节是**唯一权威的本地开发管线说明**。§11–§13 的优化与修复都依赖这里的命令；
> 换机器或换工具链后，先回来对齐这节再动手。

### 3.0 环境前提

| 项 | 要求 | 说明 |
|---|---|---|
| Go | 1.26（`apps/client/go.mod` 声明 `go 1.26.0`） | 便携工具链在 `C:\Users\HOTPOTFISH\go-portable\go\bin`；`GOTOOLCHAIN=auto` 会自动拉取匹配版本 |
| Node | 20+ | 仓库一律用 `corepack pnpm`，**不要直接用 `npm`**（会破坏 pnpm 的 `node_modules` 布局） |
| Wails v3 CLI | 可选 | 只在改了 Go 侧、需要重新生成绑定或完整打包时用；纯前端改动可跳过 |
| Chrome | 本机已装 | Playwright E2E 用 `channel:'chrome'`，不下载自带浏览器 |

每个新终端先设好 Go 环境（前端开发不需要，但编译 exe / 跑 Go 测试需要）：

```powershell
$env:PATH = 'C:\Users\HOTPOTFISH\go-portable\go\bin;' + $env:PATH
$env:GOTOOLCHAIN = 'auto'
$env:GOPROXY = 'https://goproxy.cn,direct'
```

### 3.1 前端开发（热重载，最快）

```powershell
cd apps\client\frontend
corepack pnpm install
corepack pnpm run dev          # → http://127.0.0.1:9245/#/reader/sample
```

- `/#/reader/sample`：内置示例书；`/#/`：书库；`/#/settings`：设置。
- 这条路径**不需要 Go 侧**，走前端的 `server` 平台实现（本地文件直开）。

### 3.2 测试管线

三层，从快到慢，提交前都应过：

```powershell
cd apps\client\frontend

# ① 类型检查（vue-tsc）
corepack pnpm exec vue-tsc --noEmit

# ② 单元测试（vitest，325 用例 / 27 文件）
corepack pnpm run test

# ③ E2E（Playwright + 真实 Chrome，自动起 vite preview :4173）
corepack pnpm run test:e2e
```

**性能门控**：E2E 里有一组 `tests/e2e/perf-*.spec.ts` 测量台，**默认跳过**，只在
`HPF_PERF=1` 时跑（避免常规 E2E 被性能测量拖慢）。常用环境变量：

| 变量 | 作用 |
|---|---|
| `HPF_PERF=1` | 开启性能测量台（`perf-open` / `perf-flow` / `perf-breakdown` / `perf-profile` / `perf-reflow`） |
| `HPF_PERF_TAG=<tag>` | 证据文件名后缀，方便区分多次测量 |
| `HPF_BOOK=<相对路径>` | 覆盖 `perf-open.spec.ts` 打开的书（默认 `tests/fixtures/books/frankenstein.epub`） |

```powershell
$env:HPF_PERF='1'; $env:HPF_PERF_TAG='my-run'
# 可选：$env:HPF_BOOK='tests/fixtures/books/single-chapter-large.epub'
corepack pnpm exec playwright test perf-open.spec.ts
```

（`testDir` 已由 `playwright.config.ts` 指到仓库根 `tests/e2e/`，所以这里写**文件名过滤**即可，
不要写成 `tests/e2e/perf-open.spec.ts`。）

证据 JSON 落在 `tests/evidence/client/`。自造测试书用（在仓库根执行）
`tests/tools/make-large-epub.mjs` / `tests/tools/make-single-chapter-epub.mjs` 生成
（产出 `tests/fixtures/books/large-book.epub`、`single-chapter-large.epub`）。

### 3.3 构建管线（交付前强制）

**任何前端 / 客户端 Go / 服务端 Go 的改动，交付前都必须重建全部产物，不能只改源码不打包。**

**① 一键全栈构建（推荐，唯一权威入口）：**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-all.ps1
```

脚本按「前端 dist → 服务端 exe → 客户端 exe」顺序重建，每步都校验原生命令退出码与产物，
任一步失败立即抛错终止（杜绝「假成功」）。产物：

| 层 | 产物 | 说明 |
|---|---|---|
| 前端 | `apps/client/frontend/dist/` | Vite 生产构建，被 `//go:embed` 打进客户端 |
| 服务端 | `apps/server/bin/api.exe`、`migrate.exe` | Go 服务端与迁移工具 |
| 客户端 | `apps/client/bin/hpfreader.exe`、`client.exe` | 桌面 exe，二者 SHA-256 必须一致 |

**② 只改前端/客户端时，可只跑客户端构建：**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-client.ps1
```

该脚本先清空并重建 `frontend/dist`，再重编 exe，并**从 exe 二进制里验证最新前端产物确实被嵌入**。

**③ 分步构建（顺序不能错）：**

```powershell
# 前端产物（frontend/dist/）
cd apps\client\frontend
corepack pnpm run build        # vue-tsc 类型检查 + vite 生产构建

# 服务端 exe
cd apps\server
go build -trimpath -o bin/api.exe ./cmd/api
go build -trimpath -o bin/migrate.exe ./cmd/migrate

# 桌面 exe（apps/client/bin/hpfreader.exe）
cd apps\client
go build -trimpath -tags production -ldflags="-w -s -H windowsgui" -o bin/hpfreader.exe .
Copy-Item bin\hpfreader.exe client.exe -Force
```

> ★ **关键事实**：`apps/client/main.go:19` 用 `//go:embed all:frontend/dist` 把前端
> **在编译期嵌入二进制**（`main.go:39` 用 `application.AssetFileServerFS(assets)` 从嵌入的
> FS 提供资源）。所以：
> - **只重建 `dist/` 不重编 exe，对桌面应用零影响**——exe 里嵌的还是旧前端。
> - **重编 exe 前必须先 `corepack pnpm run build`**，否则嵌进去的是旧 `dist`。
> - 验证嵌入内容：在 exe 二进制里搜前端标记字符串（如 `reader-resumed`、`data-bar`、
>   `statusBarPinned`），命中即说明嵌的是最新产物；`build-client.ps1` 会用
>   `dist/index.html` 里主入口 JS 的产物路径做更严格的嵌入校验。

**关于 `wails3`**：只有改了 Go 侧（新增/修改方法）才需要
`wails3 generate bindings -ts -i -clean=true` 重新生成 TypeScript 绑定。
**纯前端改动直接 `go build` 即可**，不需要 `wails3`。若确实要用完整打包：
`wails3 build PACKAGE_MANAGER=pnpm`——`PACKAGE_MANAGER=pnpm` 不能省（Taskfile 默认
`npm`，`npm install` 会破坏 pnpm 的 `node_modules` 布局，见 `build/Taskfile.yml:46`）；
完整打包还需要 Git 的 `usr\bin` 提供 `uname`/`tail`，且需要一个 pnpm shim。

启动：`.\bin\hpfreader.exe`。

### 3.4 联调后端（可选）

```powershell
# 终端 1：后端
cd apps\server; go run .            # 见 apps/server/STATUS.md
# 终端 2：前端，指向后端
cd apps\client\frontend
$env:VITE_HPF_API_BASE = 'http://127.0.0.1:8080'
corepack pnpm run dev
```

### 3.5 常见排障

| 现象 | 原因 / 处理 |
|---|---|
| 桌面应用改了前端不生效 | exe 嵌的是编译时的 `dist`，见 §3.3——先 `pnpm run build` 再 `go build` |
| `go: module requires go 1.26` | `GOTOOLCHAIN=auto` 会自动拉取；确认 `go` 在 PATH 上 |
| E2E 报找不到 Chrome | Playwright 用 `channel:'chrome'`，需本机装 Chrome；不下载自带浏览器 |
| 性能台没跑 | 需要 `HPF_PERF=1`，否则 `tests/e2e/perf-*.spec.ts` 被跳过 |
| `npm install` 后构建异常 | 用 `corepack pnpm`，不要用 npm |

---

## 4. 关键决策与注意事项（接手必读）

1. **foliate-js 的 commit 固定为 `78914aef4466eb960965702401634c2cb348e9b1`**
   （"Use original hrefs for external links and add isExternal in fb2.js (#129)"，
   2026-05-01）。**升级前必须重读 VENDOR.md 里"我们依赖的上游事实"那张表。**
2. **引擎实例绝不进 `ref`/`reactive`**。`foliate-view` 是 closed shadow root 的 custom element，
   Vue 的 Proxy 会让内部 `this` / `currentTarget` / `renderer` 身份不一致。架构测试会卡这条。
3. **主题必须双写**：只改主文档 CSS 变量会出现"界面变了、正文没变"。
4. **跨边界只传值**：`Range` / `Element` / 库实例都是活对象或 Proxy 敏感对象，
   传进 Vue 就会踩坑；阅读器里 Range 一律留在闭包变量。
5. **阅读容器必须有确定尺寸**（`absolute inset-0`）。高度为 0 时 paginator 会算出 0 页 → 白屏。
6. 目录结构相对研究文档做了**有意简化**：`docs/research/50-vue3-reader-stack.md` 里写的
   `packages/*` monorepo 被压平为 `apps/client/frontend/src/**`，以对齐 task-9 明确要求的
   路径（`src/platform/`、`src/reader/`、`src/api/schema.d.ts`、`src/vendor/foliate-js`）。
7. **前端脚本一律从 `apps/client/frontend` 目录执行**（`package.json` 在那里）。

---

## 5. 已知问题

| # | 问题 | 影响 | 处理 |
|---|---|---|---|
| 1 | 构建时打印 `[plugin builtin:vite-import-glob] Invalid glob pattern: 'vendor/pdfjs/*' in src/vendor/foliate-js/pdf.js` | **仅 PDF** 的 cmaps 预加载；EPUB 完全不受影响 | 未改上游源码；接入 PDF 时按 VENDOR.md 打补丁 |
| 2 | `wails3 build` 的 Taskfile 默认用 npm，且依赖 `uname`/`tail` | 不设参数会拉 npm 并覆盖 node_modules | 见 §3.3 方式 B（`PACKAGE_MANAGER=pnpm` + Git usr\bin） |
| 3 | `task`（go-task）未安装 | 不影响，用方式 A 显式两步 | — |
| 4 | E2E 里 `POST /v1/sync/push` 返回 404 | 预期：E2E 不启后端，进度上报失败被降级成 console.warn | E2E 断言里已显式白名单这一条 |
| 5 | vendor 目录含 pdfjs 的 `.map`（约 7.6 MB） | 仅仓库体积 | 未删；确认不需要 PDF 调试后可直接删 `*.map` |
| 6 | happy-dom 解析带外链样式表的文档会打印 DOMException | 测试噪音，非被测代码问题 | 已在 `vitest.config.ts` 里 `handleDisabledFileLoadingAsSuccess` + 过滤该条日志 |
| 7 | `frontend/dist/` 需先构建，否则 `go build` 报 `pattern all:frontend/dist: no matching files` | 编译顺序问题 | 先 `pnpm run build` 再 `go build` |
| 8 | CSS 嵌套 `&`（paginator 的 `&.vertical`，需 Chrome 120+）在老 WebView 上不生效 | **仅**垂直排版/滚动模式的细节间距；正文可读性不受影响 | 不处理，作为已知限制（§10.5） |
| 9 | `@layer` 扁平化后产物 CSS 从 26 KB 增至 44 KB | 体积 +68%（每条工具类多 8 个 `:not(#\#)`） | 接受：本地资源服务器无传输成本，换老设备可用（§10.2） |
| 10 | WebView < 91 时启动探测会提示更新 WebView | 用户需手动更新系统组件 | 兜底提示（`src/compat/capabilities.ts`），不白屏 |

---

## 6. 踩坑记录（避免重复踩）

- `wails3 init -d apps/client -n HPFReader` 会生成 `apps/client/HPFReader/`，
  需要把内容（含隐藏文件）上提到 `apps/client/` 再删掉那层。
- `TS 6` 里 `baseUrl` 已弃用（`TS5101`）：`paths` 直接相对 tsconfig 解析，不要写 `baseUrl`。
- **不要**给 `foliate-js` 配 tsconfig `paths` 映射：会覆盖 `src/reader/foliate.d.ts` 的
  ambient 声明，导致 `vue-tsc` 去解析没有类型的上游 JS。运行时别名只在 `vite.config.ts` 里配。
- `vitest.config.ts` **故意不复用** `vite.config.ts`：后者的 Wails 插件在测试环境会捣乱。
- **CSS 兼容性只能靠"扫构建产物"**：我们自己的 `.css`/`.vue` 里一个现代语法都没有，
  但 Tailwind v4 的**输出**里全是 `@layer`。只扫源码的审计永远发现不了这类问题 ——
  这也是 `audit:compat:dist` 与 `audit:compat`（src）必须**两个都跑**的原因。
- **CSS 失效是静默的**：不支持的 `@layer`/`@container` **不抛异常、不报错、console 干净**，
  只是规则不生效。所以"没有报错"绝不等于"样式正常"，必须靠**断言 computed style** 或
  **断言产物无该语法**来验证（§10.3）。
- `pnpm` 需要 `pnpm-workspace.yaml` 里加 `onlyBuiltDependencies: [vue-demi]`，
  否则 install 以 `ERR_PNPM_IGNORED_BUILDS` 退出 1。
- 写 vitest 用例时不要在模板字符串里用 `\'` 转义给 HTML 属性，会把自己写崩；用反引号包 HTML。

---

## 7. 目录速览

```
apps/client/
├── main.go                     # 应用装配：嵌入 dist、注册 service、开窗
├── appservice.go               # 版本 / 平台 / 数据目录
├── libraryservice.go           # 书库索引、进度、原生文件对话框、library:changed 事件
├── Taskfile.yml / build/       # Wails 任务与平台资源
├── STATUS.md                   # ← 本文件
└── frontend/
    ├── src/
    │   ├── api/                # schema.d.ts（生成）+ client.ts
    │   ├── app/                # router + layouts
    │   ├── features/           # library / settings / sync
    │   ├── i18n/               # zh-CN + en
    │   ├── platform/           # ★ 唯一允许碰 bindings 的地方
    │   ├── reader/             # ★ sanitize / engine / coords / bridge / views
    │   ├── stores/             # Pinia（仅本地 UI 偏好）
    │   ├── sync/               # 同步引擎骨架
    │   └── vendor/foliate-js/  # ★ 固定 commit，见 VENDOR.md
    ├── tests/                  # 架构门禁（architecture.spec.ts）
    ├── scripts/                # 构建/代码生成/构建门禁：gen-api-types / audit-builtins / make-sample-epub
    ├── playwright.config.ts    # E2E 配置（必须留在本包内，见下）
    └── vitest.config.ts        # 单测配置（同上）

<仓库根>/tests/                 # ★ 所有测试与测试资产（不放在 apps/ 内）
├── e2e/                        #   Playwright 用例（testDir 由 playwright.config.ts 指过来）
├── integration/                #   跨端全链路集成测试
├── smoke/                      #   Docker 冒烟 + 黑盒验证脚本
├── fixtures/books/             #   测试用真实公版书 + 自造压力书
├── evidence/{client,server}/   #   测试产出的截图 / JSON / 原始输出
└── tools/                      #   造夹具与抓证据的脚本
```

> 目录归属判定以仓库根 [AGENTS.md](../../AGENTS.md) 的「目录地图」为唯一权威，
> 测试目录细节见 [tests/README.md](../../tests/README.md)。

---

## 8. task-12：本地优先阅读闭环 + 横竖屏自适应

### 8.1 完成项

- [x] **本地优先闭环**：本地选书 → 导入书库 → 阅读 → 分页/翻页/目录 → **进度落盘** → 重开续读。
      全链路不依赖后端。桌面端走 Wails 原生文件对话框（`files.dialog` 能力）。
- [x] **书库空态可用**：后端不可达时显示 `library-local-mode` 提示条（琥珀色、非阻断）+
      `library-empty` 空态 + "打开本地文件"按钮，**不白屏、不报错**。
      `import-book` 仅在 `files.dialog` 与 `library.local` 两个能力同时具备时才出现。
- [x] **拖放导入**：书库区支持 `dragover/dragleave/drop`，拖入 EPUB 直接进阅读器。
- [x] **真实公版书验证**：用 `tests/fixtures/books/frankenstein.epub`（294 175 B，
      sha256 `bf04d57cf243314ab770df6fcea6a9cfb1e5a281426453e23c128c5a9c3eb662`）
      实测：目录 32 项、正文 7 375 字符/章、多页分页、翻页 CFI 变化。测量值落盘在
      `tests/evidence/client/real-book-open.json`。
- [x] **横竖屏自适应**：
      | 视口 | 方向 | 栏数 | 目录 | 工具栏 |
      |---|---|---|---|---|
      | ≥1024px 宽 | 横屏 | **2 栏** | 侧栏（≥1080px 才侧栏，否则覆盖层） | 完整（带文字标签） |
      | <1024px 或竖屏 | 竖屏/窄 | **1 栏** | 覆盖层 | 紧凑（仅图标） |
      旋转后**自动重排且不丢位置**：同一 CFI 在 1280×800 → 480×900 → 1440×900 三次测量中，
      章节不变（`textStart` 一致）、页数 11 → 18 → 11。数据见
      `tests/evidence/client/reader-layout-measurements.json`。
- [x] **无硬编码像素**：断点集中在 `src/app/useViewport.ts`（`COMPACT_MAX_WIDTH = 760`）与
      `src/reader/useReaderLayout.ts`（`TWO_COLUMN_MIN_WIDTH = 1024`、
      `SIDEBAR_MIN_WIDTH = 1080`、`MAX_INLINE_SIZE = 720`）两个文件；
      几何值通过 paginator 的**属性**（`max-inline-size` / `max-column-count` / `gap` / `margin`）
      下发，不用 CSS hack。

### 8.2 阅读进度存储：选型与理由

**结论：文件型 JSON（Go 侧）+ 渲染进程 `localStorage` 同步镜像。**

| 方案 | 结论 | 理由 |
|---|---|---|
| **SQLite** | ❌ 本里程碑不采用 | 需要 CGO 或纯 Go 驱动（`modernc.org/sqlite` 约 +10 MB 二进制）；当前数据量是"每本书一条记录"，JSON 完全够用；进度写入是低频小对象，没有并发/索引压力。已在 `libraryservice.go` 留 TODO 注释，后续引入标签/全文检索时再迁移。 |
| **文件型 JSON** | ✅ 采用（权威源） | `<dataDir>/progress.json`（`os.UserConfigDir()/HPFReader`）。零依赖、可读可修、原子写；与书库索引 `library.json` 同一套存储策略，认知成本低。 |
| **localStorage** | ✅ 采用（同步镜像） | 阅读器每翻一页都要写进度。走 Go 有 IPC 往返 + 潜在失败；`localStorage` 是同步 API，**翻页当下就落盘**，即使应用被强杀也不丢位置。 |

两者关系：
1. 翻页 → **同步**写 `localStorage`（`rememberProgress`）→ 再 fire-and-forget 上报 Go（失败只 warn）。
2. 打开书 → **先读 `localStorage`**，命中就用；未命中再问 Go，并回填 `localStorage`。
3. 纯前端书（`sample`、`isLocalOnlyBook`）**完全不发网络请求**，`progressBackend` 为 `undefined`。

`localStorage` 键名：`hpf.reader.progress.v1`（与 E2E 里硬编码的值是同一契约）。

### 8.3 ★ 真实 exe 截图（已拿到，附方法）

**结论：真实 `hpfreader.exe` 的窗口内容已经截到了，4 张，全部落盘。**

一开始用 `Graphics.CopyFromScreen` 只能抓到桌面合成层（窗口区域是黑的），
误以为"窗口不可捕获"。真正可行的通道是 **`PrintWindow` + `PW_RENDERFULLCONTENT`(flag=2)** ——
后者专门用于 DWM/WebView2 这类 GPU 合成的窗口，能直接拿到窗口位图，**不依赖窗口是否在最前**。

| 截图 | 内容 | 大小 |
|---|---|---|
| `tests/evidence/client/exe-01-library-empty.png` | 书库空态（无后端也不白屏） | 26 663 B |
| `tests/evidence/client/exe-02-reader-opened.png` | 打开示例书后的正文（第一章，36%） | 68 007 B |
| `tests/evidence/client/exe-03-after-page-turn.png` | 翻页后（第三章，100%，"已从上次位置继续"） | 53 705 B |
| `tests/evidence/client/exe-04-night-mode.png` | 夜间模式（正文深色，主题按钮显示"夜间"） | 54 180 B |

复现方法（`frontend/scripts/_capture-exe.ps1`）：

1. `Start-Process ..\bin\hpfreader.exe`，等 9 秒让 WebView 完成首帧；
2. `GetWindowRect` 取窗口矩形，`PrintWindow(hwnd, hdc, 2)` 抓位图并存 PNG；
3. 交互用 **`SetCursorPos` + `mouse_event`** 点按钮（不用 `SendKeys`，它对 WebView 不可靠），
   翻页用 **`SendKeys {RIGHT}`** —— 因为 `ReaderView.vue` 把 `ArrowRight/PageDown/空格`
   绑在 `window` 的 `keydown` 上，键盘比点像素稳。

**踩坑**：`exe` 必须是**重新构建过的**。一开始用的是 11 502 080 B 的旧 exe（2026/11/3 0:01），
它内嵌的是旧 `dist/`，界面上还没有"打开本地文件"按钮，导致按旧坐标点击全部落空。
重建后（11 591 680 B，1:14:36）坐标才对上。

> 备注：原生文件对话框（"导入书籍"）仍然无法自动化驱动（`SendKeys` 进不去系统对话框），
> 所以真实书是用 Playwright 走同一份 `dist/` 验证的（见 §9.7 的 `e2e-legacy-deflate-raw.png`）。

- 另有 Playwright 证据（同样证明真实渲染，且可复现、可复核）：
  - `tests/evidence/client/task-17-layer-raw-output.txt`（**@layer 修复前后原始输出**：5 → 0、审计门禁、反向验证）
- `tests/evidence/client/e2e-legacy-css-layer.png`（**模拟 WebView 91 不支持 @layer** 下的真实 EPUB：双栏、31 章目录、Letter 2 正文）
- `tests/evidence/client/e2e-landscape-wide.png`（1280×800，横屏双栏 + 侧栏目录）
  - `tests/evidence/client/e2e-portrait-narrow.png`（480×900，竖屏单栏 + 紧凑工具栏）
  - `tests/evidence/client/e2e-night-mode.png`（夜间模式，正文深色 `rgb(20, 22, 26)`）
  - `tests/evidence/client/e2e-sample-reader.png`（示例书正文）
  - `tests/evidence/client/e2e-legacy-webview-sim.png`（删掉 ES2022+ 内置对象后仍能阅读）
  - `tests/evidence/client/real-book-open.json`（真实公版书打开/跳章/翻页的引擎测量值）
  - 这些截图由 **真实 Chrome**（`channel: 'chrome'`，非无头模拟）渲染
    `vite preview` 的**生产构建产物**，与 exe 内嵌的是同一份 `dist/`。
- 需要真机截图时，请在有人值守的桌面会话里执行 `apps/client/bin/hpfreader.exe` 后手动截屏。

### 8.4 本轮修掉的真实崩溃 / 白屏

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | **夜间模式点了没反应**（正文还是白底黑字） | CSS 变量**不跨文档继承**：把 `var(--reader-paper)` 直接写进 iframe 的样式表，变量在章节文档 `\:root` 上不存在 → 声明失效 → 背景透明 | `readerStyles.ts` 新增 `resolveReaderTokens()`，用 `getComputedStyle` 把变量**解析成具体颜色**再注入；主题变化时 `applyStyles()`（`flush: 'post'`） |
| 2 | 夜间模式**双重取反**变回浅色（截图证据） | `foliate-view::part(filter) { filter: invert(1) }` 与深色配色叠加 | 反转滤镜恒为 `none`，只保留变量注入这一条路径（也避免把插图反成负片） |
| 3 | 真实公版书测试**误判失败** | frankenstein 第 1 个 section 是标题页（27 字符），拿"首屏字数 >200"当"这是真书"的证据必然假阴性 | 改为断言目录 ≥20 项 + 跳到第 5 章后正文 >2 000 字符且多页 |
| 4 | 旋转后"页数没变"假阴性 | `renderer.pages` 是**每 section** 的页数，短章节两方向都是 1 页 | 先导航到长章节，再断言页数随方向单调变化 |
| 5 | 目录条目数测到 0 | 宽屏下目录是侧栏且**默认展开**，测试又点了一次 toggle 把它关了 | 先判断是否已展开，只在未展开时点击 |
| 6 | 证据落错目录 | `process.cwd()` 是 `apps/client/frontend`，`../../evidence` 指向 `apps/evidence` | 改为 `../evidence` |

---

## 9. 老旧 WebView 兼容性（task-14）

### 9.1 问题本质

> **打包器只降语法，不 polyfill 运行时内置对象。**

`vite.config.ts` 原来的 `build.target` 是 Vite 默认的 `'modules'`（≈ chrome87），
**语法**层面本来就没问题；真正炸掉的是**运行时缺 API**：

```
[engine] open failed TypeError: Object.groupBy is not a function (ReaderView-Bb7x_oFD.js:2)
```

出现在 Android 模拟器（Pixel_6 / API 31，WebView UA `Chrome/91.0.4472.114`）上。
`Object.groupBy` 是 ES2024 / **Chrome 117+**，在 91 上根本不存在 →
**任何 EPUB 都打不开**。这也解释了为什么"改 build.target"不可能修好这个 bug。

**兼容基线定为 Chromium 91**，依据：
1. API 29~31 模拟器**实测**就是 91（`apps/client/spikes/android/RESULTS.md`）；
2. e-ink 阅读器（文石/Kindle 类）大量是 Android 8~11 + WebView 80~100；
3. 91 是能覆盖上述全部设备的最低公约数。

### 9.2 审计方法与命中清单（可复现）

```bash
node scripts/audit-builtins.mjs src  --chrome 91   # 源码 + vendored 上游
node scripts/audit-builtins.mjs dist --chrome 91   # ★ 权威：含 node_modules 打包后代码
```

脚本对 `.ts/.js/.mjs/.cjs/.vue/.mts` 全量扫描 31 组 ES2022~ES2025 API，
对照每个 API 进入 Chrome 稳定的版本；**有"低于基线且无 polyfill"就 exit 1**，可直接进 CI。
（已接入 `pnpm run audit:compat` / `audit:compat:dist`。）

**为什么 dist 那一遍才是权威**：`Object.hasOwn` 在 `src` 里命中 0 次，
但在产物里出现 3 次 —— 来自 **vue-router / pinia / pinia-plugin-persistedstate / @vueuse/core**
的源码。只扫 src 会漏掉整个依赖树。

| API | 最低 Chrome | src | dist | 处理 | 真实调用点 |
|---|---|---|---|---|---|
| `Object.groupBy` | 117 | 5 | 4 | polyfill | foliate-js/epub.js（**EPUB 必挂**） |
| `Map.groupBy` | 117 | 1 | 4 | polyfill | foliate-js/epub.js（**EPUB 必挂**） |
| `Array.prototype.findLastIndex` | 97 | 1 | 1 | polyfill | **paginator.js:1089（分页必挂）** |
| `Array.prototype.findLast` | 97 | 1 | 1 | polyfill | pdf.js |
| `Promise.withResolvers` | 119 | 40 | 30 | polyfill | pdf.js |
| `Promise.try` | 128 | 8 | 5 | polyfill | pdf.js（epub.js:782 只是注释，见下方行级豁免） |
| `Array.prototype.at` | 92 | 58 | 20 | polyfill | foliate-js/epub.js、epubcfi.js |
| `String.prototype.at` | 92 | — | 1 | polyfill | 成对补齐 |
| `structuredClone` | 98 | 6 | 9 | polyfill | zip.js 能力探测 |
| `crypto.randomUUID` | 92 | 5 | 5 | polyfill | `platform/server.ts` |
| `AbortSignal.timeout` | 103 | 1 | 5 | polyfill | `api/client.ts` |
| `Object.hasOwn` | 93 | 0 | **3** | polyfill | ★ vue-router / pinia / @vueuse |
| `Array.prototype.to{ sorted, Reversed, Spliced }` / `with` | 110 | 0 | 3 | polyfill | ★ Vue 响应式数组插桩 |
| `Uint8Array.prototype.toBase64` / `fromBase64` | 133 | 4 | 8 | polyfill | pdf.js 内联图片/签名 |
| `String.prototype.replaceAll` | 85 | 50 | 15 | **不补** | 91 已支持 |
| `Object.fromEntries` / `matchAll` / `flatMap` / `allSettled` / `WeakRef` / `FinalizationRegistry` / `CompressionStream` / `Intl.Segmenter` / RegExp `d` | ≤90 | — | — | **不补** | 91 已支持，补了纯属噪音 |
| `URL.canParse` / `RegExp.escape` / `Set.prototype.union` / `Array.fromAsync` | 120+ | 0 | 0 | **不补** | 全量扫描命中数为 0 |

**行级豁免**（`scripts/audit-builtins.mjs` 的 `ALLOWLIST`，必须写明原因 + 精确行号，
行号漂移会立刻重新报出来，避免"整文件忽略"掩盖真问题）：
`vendor/foliate-js/epub.js:782` —— `Promise.try` 只出现在注释里，没有真实调用。

已知误报：`.at(` 的 58 处命中里含非数组用法（字符串、CSS 类名），需人工确认；
脚本会打印这条提示。

### 9.3 Polyfill 实现（`src/compat/polyfills.ts`）

- **导入位置**：`src/main.ts` **第一行**。ES 模块按 import 声明顺序深度优先求值，
  所以这里先于 router / i18n / platform / App 的顶层代码跑完。
- **安装时机**：模块求值即安装（`export const INSTALLED_POLYFILLS = installPolyfills()`），
  不等 `bootstrap()`。
- **幂等 + 只在缺失时安装**：`typeof target[key] !== 'function'` 才补，**绝不覆盖原生实现**。
- **启动自检**：`verifyPolyfills()` 用**真实调用形态**（复现 `paginator.js:1089` 的
  `sections.findLastIndex(...)`）验证，不是只检查"函数存在"；有问题打 `console.warn`。
- **实现形态**：辅助函数接收**显式 receiver**（`arrayAt(array, index)`），
  安装时由 `installMethod` 包一层接到 `this`。好处是同一个函数在测试里能直接当纯函数调，
  不依赖 TS 对泛型 `this` 的推断（那种推断在 `.call()` 上经常失败）。
- **每个内置对象都标注了最低 Chrome 版本**（见文件头部的审计表）。
- **已知偏差**（都写在对应函数上方 + 测试里）：
  - `structuredClone`：函数/平台对象按引用透传（不抛 `DataCloneError`，不支持 transfer list）；
  - `AbortSignal.timeout`：Chromium <98 忽略 abort 的 `reason`，可能只给通用 `AbortError`；
  - `toSorted/toReversed/toSpliced/with`：固定返回普通数组，不走 `Symbol.species`；
  - 原型方法包装器用 rest 参数，`fn.length` 为 0（已确认消费方不检查 length）。
- **不修改 vendored 的 foliate-js 源码**（上游，靠这一层兜）。

### 9.4 构建目标下调（`vite.config.ts`）

```ts
const COMPAT_TARGET = 'chrome91'
// 同时作用于 build.target 与 esbuild.target
```

选 `chrome91` 而不是 `es2020`：目标必须是**具体浏览器版本**，esbuild 才能对
类字段、可选链、`??=`、async generator 等做正确的降级；`es2020` 是语言规范版本，
与 WebView 实际能力没有对应关系，而且会让 esbuild 保留一些 91 不支持的语法降级假设。

### 9.5 验证

- **单元测试** `src/compat/__tests__/polyfills.spec.ts`：**44 个用例**，覆盖
  - 安装行为：幂等、**原生实现不被覆盖**、缺失时真的补齐（临时 `delete` 全局实现 +
    `vi.resetModules()` 后重新 import，模拟 WebView 91）；
  - 边界：空数组、`NaN` 键（SameValueZero）、负索引/越界、循环引用、`null` 原型、
    Symbol 键、不可枚举属性、`RangeError`；
  - `toBase64/fromBase64` 往返（含全 256 字节、200 000 字节不爆栈）、base64url、非法长度。
- **单元测试** `src/compat/__tests__/deflateRaw.spec.ts`：**12 个用例**（§9.7 详述）。
- **E2E** `tests/e2e/reader.spec.ts` 新增两条，都用 `page.addInitScript` 在**任何应用脚本执行之前**把
  真实 WebView 91 的能力差异**复刻**出来：
  1. 把 16 个 ES2022+ 内置对象全部 `delete`，断言应用仍能打开书、完成分页、翻页，
     且 `pageerror` 为空。没有 polyfill 时这条会以
     `Object.groupBy is not a function` 失败 —— 与模拟器上的报错完全一致。
  2. 把 `DecompressionStream` 换成"gzip/deflate 可用、deflate-raw 抛错"的 Chrome 91 复刻版，
     断言 **frankenstein.epub**（36 个 deflate 条目）仍能打开、目录 ≥20 项、跳章后有正文、
     翻页可用、`pageerror` 为空。没有兜底时这条会以
     `Unsupported compression format: 'deflate-raw'` 失败。

### 9.6 原始输出

`tests/evidence/client/task-14-compat-raw-output.txt` 收录了 5 条命令的**完整原始输出与退出码**：

| 命令 | 退出码 |
|---|---|
| `pnpm run build`（含 `vue-tsc --noEmit`） | 0 |
| `node scripts/audit-builtins.mjs src --chrome 91` | 0 |
| `node scripts/audit-builtins.mjs dist --chrome 91` | 0 |
| `pnpm run test`（vitest，**83** 用例 / 4 个文件） | 0 |
| `pnpm run test:e2e`（Playwright，**8** 用例） | 0 |

### 9.7 ★ 第二个阻塞点：`DecompressionStream('deflate-raw')`（真机复现）

补齐 builtin 之后，**示例书能开、真书仍然全打不开**。Android 真机 logcat（mobile-dev 提供）：

```
这本书打不开：Failed to construct 'DecompressionStream': Unsupported compression format: 'deflate-raw'
```

**这是"示例书假阳性"的典型**：`sample.epub` 是 100% STORE（压缩方法 **0**），
根本不走解压；而真实公版书都有 deflate 条目（压缩方法 **8**）。

| 文件 | 大小 | ZIP 压缩方法分布 |
|---|---|---|
| `dist/sample/sample.epub` | 5 509 B | `{0: 8}` ← 全部 STORE，不触发解压 |
| `tests/fixtures/books/frankenstein.epub` | 294 175 B | `{0: 2, 8: 36}` |
| `tests/fixtures/books/alice-in-wonderland.epub` | 136 756 B | `{0: 2, 8: 19}` |
| `tests/fixtures/books/pride-and-prejudice.epub` | 609 138 B | `{0: 2, 8: 22}` |

ZIP 的压缩方法 8 里存的是**裸 deflate 流**（没有 zlib 头），所以 zip.js 必须用
`'deflate-raw'` 构造 `DecompressionStream`。而该格式是 **Chrome 103+** 才有：

```
WebView 91 实测：{ gzip: OK, deflate: OK, deflate-raw: THROW }
```

→ **WebView 91 上所有真实 EPUB 都打不开**。

#### 修法：零新增依赖的窄兜底

**没有引入 `fflate` npm 依赖** —— foliate-js 自带的 `src/vendor/foliate-js/vendor/fflate.js`
（MIT，上游已 vendored）就是 fflate 的裁剪版，导出了 `unzlibSync`。
它只做 zlib 容器的 inflate，所以这里给它补 2 字节 zlib 头（`0x78 0x9c`，
`0x789c % 31 === 0`）与 4 字节 adler32 占位（它不校验校验和）就能解裸 deflate。

**窄接管策略**（`src/compat/polyfills.ts` 的 `installDecompressionStreamFallback()`）：

1. **特性探测** `new DecompressionStream('deflate-raw')`：
   不抛 → 原生可用 → **完全不接管**（绝不把原生快速路径换成 JS 实现）；
2. 抛错才安装 shim，且**只**接管 `'deflate-raw'`（和 `'deflate64-raw'` → 明确抛错，
   不产出垃圾数据）；
3. `'gzip'` / `'deflate'` **原样委托**给原生实现（不退性能、不改语义）；
4. `Shim.prototype = Native.prototype`，尽量保持 `instanceof` 语义。

zip.js 在**模块初始化时**就把 `DecompressionStream` 抓进 config，
而 `main.ts` 第一行 import 保证 polyfill 先于它执行 —— 顺序天然满足，无需改 vendor。

#### 验证（三层）

| 层 | 内容 | 结果 |
|---|---|---|
| 单元 | `src/compat/__tests__/deflateRaw.spec.ts`，用 `node:zlib` 的 `deflateRawSync` **生成真实裸 deflate 数据**（不是手搓假数据）：解压往返、空输入、70 000 字节、压缩级别 0/1/9、分块喂入 `pipeThrough`、原生支持时不接管、gzip/deflate 委托 | **12/12** |
| 审计 | `scripts/audit-builtins.mjs` 新增 "Web API 能力" 段：`DecompressionStream('deflate-raw')` 最低 Chrome 103、需兜底、处理方式 | exit 0 |
| E2E | `模拟 Chromium 91 缺 deflate-raw`：用 `addInitScript` 把 `DecompressionStream` 换成"gzip/deflate 可用、deflate-raw 抛错"的 Chrome 91 复刻版，然后打开 **frankenstein.epub** —— 断言目录 ≥20 项、点击跳章后正文 >2 000 字符、翻页 CFI 变化、`pageerror` 为空 | **通过**，截图 `tests/evidence/client/e2e-legacy-deflate-raw.png` |

#### 启动能力探测（用户可读提示）

`src/compat/capabilities.ts` 的 `probeCapabilities()` 在启动时检查关键能力
（builtin 存在性 + `deflate-raw` 可用性），缺任何一条就打 `console.warn`：

> 当前系统的网页组件版本太旧，缺少必需的能力（`xxx`）。
> 请更新「Android System WebView」：在应用商店搜索它并安装更新，然后重新打开本应用。

结果同时挂到 `window.__HPF_CAPABILITIES__`，供排障与 E2E 断言。
这是**兜底**：宁可给一句话，也不要白屏或 `TypeError: xxx is not a function`。

### 9.8 对 Android 的直接影响

Android 端（task-15）此前的两个阻塞都已解除：

1. `Object.groupBy is not a function` → §9.2~9.6（14 个 builtin 补齐）；
2. `Unsupported compression format: 'deflate-raw'` → §9.7（零依赖窄兜底）。

两者都有 E2E 回归保护，且 E2E 是在**真实 Chrome** 里把 WebView 91 的行为**复刻**出来验证的
（删 builtin / 让 deflate-raw 构造抛错），不是只测桌面 Chrome 的原生能力。

**注意**：polyfill 修的是"运行时能力缺失"。Android 侧若还有别的故障
（`src/platform/mobile.ts` 的桥接、WebView 文件选择器、权限申请），不在本任务范围内。
真实书验收请用 `tests/fixtures/books/frankenstein.epub`（31 章、含 36 个 deflate 条目），
**不要**用 `sample.epub` —— 它是 STORE 压缩，测不出解压路径。

## 10. task-17：`@layer` 兼容性 —— Tailwind v4 样式表在老 WebView 上整份失效

> 这是「Android 可用」的**第三个**硬阻塞，也是**唯一一个不是 JS 运行时**的：
> 前面两个（builtin、deflate-raw）都是 JS 能力缺失，这个是 **CSS 能力缺失**。

### 10.1 问题本质

Tailwind v4 把**整份样式表**包在 `@layer` 里（固定输出 5 个块）：

```
@layer properties{...}
@layer theme{...}
@layer base{...}
@layer components;
@layer utilities{...}
```

而 **`@layer` 是 Chrome 99+** 才有的。WebView 91（Android 12）不支持，
并且它的失败方式是**最坏的一种**：**整块静默丢弃** —— 不抛异常、不报错、console 干净。

实测（Android 12 / WebView 91，Lead 与 mobile-dev 双重确认）：

```json
{"supportsLayer": false, "layerProbe": 0,
 "sheetCount": 1, "topLevelRules": 66, "layerBlockRules": 0,
 "buttonBorderRadius": "0px", "buttonBg": "rgb(239, 239, 239)",
 "bodyFont": "sans-serif", "bodyBg": "rgba(0,0,0,0)",
 "fvHeight": "1482px", "innerH": 843}
```

读法：66 条顶层规则里 **layer 块 = 0**，说明浏览器把整份 Tailwind 样式表当垃圾扔了。
于是所有工具类失效 —— `.absolute{position:absolute}` 算出来是 `static`、
`.flex` 是 `block`、`.h-full` 是 `auto`。

阅读器的根容器是 `relative flex h-full w-full overflow-hidden`，
正文宿主是 `relative min-h-0 min-w-0 flex-1`。这些类全失效后容器塌掉，
foliate-view 被撑到 **1482px**（视口只有 843px），正文被推出可视区。

### 10.2 修法：构建期扁平化（保留 Tailwind v4）

用官方 polyfill **`@csstools/postcss-cascade-layers`**（6.0.2），
接进 `vite.config.ts` 的 postcss 链：

```ts
import postcssCascadeLayers from '@csstools/postcss-cascade-layers'

const postcssPlugins = [postcssCascadeLayers()]

export default defineConfig({
  css: { postcss: { plugins: postcssPlugins } },
  plugins: [vue(), tailwindcss(), wails('./bindings')],
})
```

**没有降级到 Tailwind v3** —— 那会牵动整条构建链（配置格式、插件生态、
与 `@tailwindcss/vite` 的集成方式都变），而问题本身与 Tailwind 版本无关，
只是它的输出用了新语法。扁平化是**构建期语法降级**，和我们把 `build.target` 降到 `chrome91` 是同一思路。

扁平化为什么语义正确：`@layer` 的唯一作用是**层叠顺序**。polyfill 剥掉外壳、
按原文档顺序展开，并用 `:not(#\#)` 链把 specificity 抬到与原来层级等效，
因此层叠结果不变（这正是 `postcss-cascade-layers` 的设计目标）。
`:not(#\#)` 是 Chrome 88+ 就支持的写法，91 能正确解析。

> 代价：产物 CSS 从 26 123 B → 43 941 B（+68%），因为每条工具类选择器都多了
> 8 个 `:not(#\#)`。这是**用体积换老设备可用**，可以接受：
> 43 KB 的 CSS 在本地资源服务器上是零成本（不是网络传输），
> 而样式失效意味着整个 UI 不可用。

### 10.3 验证（三道，都有原始输出）

原始输出全文见 `tests/evidence/client/task-17-layer-raw-output.txt`。

**① 产物断言（硬门禁）**：

```
$ grep -c "@layer" dist/assets/index-*.css
  修复前：5
  修复后：0        <-- 验收要求 = 0，达成
```

**② E2E 行为断言**（`reader.spec.ts`「模拟 Chromium 91 不支持 @layer」）：

Playwright 没法真的关掉 `@layer` 解析，所以用 `addInitScript` 在**任何样式表解析之前**
把 `CSSLayerBlockRule` / `CSSLayerStatementRule` 置为 `undefined` ——
这是 Chromium 判定「不支持 @layer」的真实探测路径，浏览器随即丢弃 layer 块。
然后断言三件事：

1. `CSSLayerBlockRule` 确实是 `undefined`（证明复刻生效，否则测试是空跑）；
2. 遍历 `document.styleSheets`，layer 规则数 = **0**（证明产物真的没有 @layer）；
3. 打开 frankenstein.epub：`rootDisplay === "flex"`、`hostPosition === "relative"`、
   宿主高度 ≤ 视口高度（**丢弃 @layer 时会撑到 1482px**）、分页 > 1、目录 ≥ 20 项、
   跳章后正文 > 2000 字。截图 `e2e-legacy-css-layer.png`。

**③ 审计门禁**（`scripts/audit-builtins.mjs` 新增「CSS 能力」一节，扫的是**构建产物**）：

```
--- CSS 能力（源码扫不出，必须扫构建产物）---
@layer（层叠层）               99         ✅ 0        @csstools/postcss-cascade-layers 扁平化
@container（容器查询）          105        ✅ 0        已由 useReaderLayout 显式 max-column-count 覆盖
CSS 嵌套（&）                 120        ✅ 0        不处理（91 只丢弃嵌套选择器，不整块失效）
✅ 构建产物 CSS 无未处理的低于 Chrome 91 的特性。
```

这一节**必须扫产物**：我们自己的 `.css`/`.vue` 是干净的，
毒在 Tailwind 的**输出**里 —— 只扫源码永远发现不了。

门禁做过**反向验证**（证明它不是装饰）：向产物 CSS 注入 `@layer theme{.injected{color:red}}`，
审计立刻 `❌ 1` + `[audit exit] 1`；还原后回到 `exit 0`。

### 10.4 `@container`（次要项）：判定为**无需处理**

vendored `paginator.js:493` 有一条 `@container (orientation: portrait)`（Chrome 105+），
在竖屏把 `--_max-column-count-spread` 切成 portrait 值。

**结论：它对我们没有影响，不必处理。** 理由是可验证的代码事实，不是"应该没事"：

1. `paginator.js:473` 里 `--_max-column-count-spread` 的**默认值**就是 `var(--_max-column-count)`；
2. `attributeChangedCallback`（`paginator.js:637`）把 `max-column-count` 属性写进 `--_max-column-count`；
3. 我们的 `useReaderLayout.ts` 已经按**同一个方向逻辑**算出列数（竖屏 1 / 横屏够宽 2），
   并通过 `useFoliateEngine.setLayout()` 写进该属性。

所以「@container 生效」和「不生效」最终 spread 的值**恰好相同**。
"竖屏单栏"的真正保证来自我们的 `decide()`，不是上游那条容器查询。
E2E 里已加断言：竖屏下 `data-hpf-columns === "1"`（注意要 poll，因为 setLayout 走 150ms 防抖）。

### 10.5 CSS 嵌套 `&`：已知限制，不处理

paginator 的 shadow 样式里有 `&.vertical` 等嵌套写法（CSS 嵌套需 Chrome 120+）。
实测 WebView 91 的行为是：**只丢弃嵌套选择器本身，不整块失效** —— `&` 前面的基础声明照常生效。
影响面仅是滚动模式的细节排版（垂直排版），**不影响正文可读性**，因此不硬啃。

### 10.6 这三个阻塞点的性质对比（接手必读）

| # | 阻塞点 | 类型 | 缺失版本 | 修法 | 位置 |
|---|--------|------|----------|------|------|
| 1 | `Object.groupBy` 等 14 个 builtin | JS 运行时 | Chrome 92~127 | 手写 polyfill | `src/compat/polyfills.ts` |
| 2 | `DecompressionStream("deflate-raw")` | JS Web API 格式 | Chrome 103 | 复用 vendored fflate 窄兜底 | 同上 |
| 3 | **`@layer`** | **CSS 语法** | **Chrome 99** | **构建期扁平化** | `vite.config.ts` |

关键教训：**前两个都能靠"运行时探测 + JS 兜底"解决，第三个不能** ——
CSS 没法 polyfill，只能在**构建期**改写产物。所以兼容性审计必须**同时扫源码和产物**，
并且要覆盖 **JS 能力、CSS 语法、Web API 格式**三类（我们前两次各漏了一类）。

---

## 11. 动效 / 高刷适配 / 操作动线（本轮优化）

> 背景：基础功能已经完整，剩下的都是"显示与手感"层面的问题。本轮只做三件事：
> **高刷适配**（让动画和重排不再吃满一帧）、**动画流畅度**（把"没有动画 / 写死时间"
> 换成一套统一、可降级的动效）、**操作动线**（点一下就该有反应，别让人去点边角）。
> 全部结论都有实测数据，原始输出落在 `tests/evidence/client/`。

### 11.1 问题清单与根因

| 现象 | 根因 | 证据 |
|---|---|---|
| 拖动窗口 / 缩放时正文"一跳一跳"、明显掉帧 | 逐帧**全量重新分栏**：foliate-js 的 paginator 自带 `ResizeObserver`，宿主尺寸一变就 `render()` → `columnize()` → 强制布局（`getBoundingClientRect`） | 基线测量：120 步缩放，**每步阻塞主线程 7.5ms**（≈120Hz 的一整帧预算），`roTotalMs 902.8` |
| 页面缩放时正文变动有阻滞感（实际并没有计算负担） | 与上一条同源：视觉上的"跳"来自逐帧重排，不是计算量问题 | 同上；优化后同样操作只剩 2 次重排，阻滞感消失 |
| 动画"写死时间"、没有高刷适配 | 组件几乎没有动画；仅有的两处动画的是**非合成属性**（翻译面板 `width`、卡片 `box-shadow`），每帧触发重排/重绘 | 代码走查：`transition-[width] duration-500`、`transition-shadow` |
| 点正文边缘翻页有时没反应 | 分栏容器被加了左右 `gap/2` 的内边距（`paginator.js:322`），阅读面最左/最右约 36px 落在 iframe **之外**，点击不冒泡进章节文档 | 探针实测：点阅读面 x=12 时 `event.target` 是 `FOLIATE-VIEW`，章节文档收不到 |
| 目录开着时按 Esc 会连书一起退出 | `Escape` 没有分层，直接 `goBack()` | 代码走查 |

### 11.2 高刷适配：**冻结 + 合成层跟随**，而不是"把重排做便宜"

7.5ms/步的重排**不可能**便宜到适配 120/144Hz，所以思路是让重排**根本不发生在拖动过程中**
（见 `src/reader/useReaderReflow.ts`）：

1. 连续尺寸变化（第 2 帧起）进入**排版冻结**：把 `foliate-view` 用 `position:absolute` +
   **像素**宽高钉死。这样 paginator 内部容器的 border-box 不变 → 它自己的
   `ResizeObserver` 不触发 → **完全不重排**；
2. 冻结期间只写**合成层属性** `transform: scale(...)` 跟手（零布局、零重绘）；
3. 停止拖动 130ms 后**只重排一次**（重新分栏 + 重写样式），再解除冻结、拉回阅读位置。

离散改动（侧栏开合、页边距、主题）不受影响：走"2 帧后落定"的分支，一次改一次重排。

**实测（`tests/e2e/perf-reflow.spec.ts`，`HPF_PERF=1` 才跑；下表为最终一轮 `HPF_PERF_TAG=final`
的原始输出，原始 JSON 见 `tests/evidence/client/optimization-reflow-final.json`）**：

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 120 步拖动的 `ResizeObserver` 回调数 | 240（每步 2 次） | **122**（其中只有 **2 次是真重排**） |
| 重排总耗时 | **902.8ms** | **21.2ms** |
| 单次重排 `p50 / p95 / max` | 7.3 / 10.6 / 12.2ms | **0.1 / 0.2 / 12.6ms** |
| 帧间隔 `p50 / p95 / max` | 6.9 / 7.1 / 14ms，`over8ms` 5 次 | 6.9 / 7.1 / 13.9ms，`over8ms` 2 次，`over16ms` **0** |
| 主线程长任务（≥50ms） | — | **0 次** |
| 真实窗口缩放：进入冻结 / 落定后冻结 | — | `true` / `false`（机制断言通过） |

> 122 次回调里剩下的 ~120 次是调度器自己写 `transform` 的轻量回调（<1ms，实测
> `lightTotalMs 10.6`），**不触发布局**。把回调按 ≥1ms 拆成"真重排 / 轻量写"两类，
> 正是为了证明"重排次数"和"回调次数"是两件事。
>
> 注意：这些数字是**真机上的实测值**，同一份代码连跑两轮会有波动（例如重排总耗时
> 16~21ms、`over8ms` 0~2 次）—— 量级和机制结论稳定，逐位数字不要当常量读。

### 11.3 动画体系：统一令牌 + 只动合成属性

新增 `src/styles/motion.css`（在 `theme.css` 里 `@import`），全部基于
**transform / opacity**，没有任何动画属性会触发布局：

- **时长令牌**：`--dur-1 90ms` / `--dur-2 140ms` / `--dur-3 200ms` / `--dur-4 280ms` /
  `--dur-5 420ms`；**缓动令牌**：`--ease-out` / `--ease-in-out` / `--ease-exit` / `--ease-spring`。
  全站动画只引用令牌，改"手感"改一处。
- **过渡预设**：`.t-fade` / `.t-pop` / `.t-rise` / `.t-slide-left`，供 `<Transition>` 直接用。
- **入场动画**：`.hpf-rise-in`（带 `--stagger` 错峰），用在书库卡片、设置页、目录条目。
- **按压反馈**：`.hpf-press`（`:active { transform: scale(.96) }`）+ `.hpf-focus`（`focus-visible`
  描边），全部按钮/链接统一。
- **`prefers-reduced-motion`**：`theme.css` 里已有全局降级（时长压到 0.001ms `!important`），
  动效层自动跟随，无需额外处理。

**把非合成属性的动画换掉**（这是"写死时间 + 不流畅"的直接来源）：

| 位置 | 原来 | 现在 |
|---|---|---|
| AI 翻译面板进度条 | `transition-[width] duration-500` + `width:%` | `.hpf-meter` + `transform: scaleX()` |
| 书库卡片进度条 | `width:%` | `.hpf-meter` + `scaleX()` |
| 书库卡片悬停 | `transition-shadow hover:shadow-md` | 合成层 `hover:-translate-y-0.5` + 一层只改 `opacity` 的阴影层 |
| 阅读器顶部进度条 | 无 | 新增：`.hpf-progress-rail` + `scaleX()`（`transform-origin:left center`） |

翻页提示用 WAAPI 在 `src/app/motion.ts` 里做（`pageTurnCue`）：只动 `opacity` +
`translate3d`，200ms / `cubic-bezier(0.16,1,0.3,1)`，并在同一元素上复用（`WeakMap` 记录
正在跑的动画并取消），避免两套 transform 叠加。

> 刻意**没有**给 `AppShell` 的 `<RouterView>` 加过渡：两个静态流页面同时存在于 DOM 时
> 会叠成一行（旧页面 leave + 新页面 enter），看起来像"整页跳了一下"，比直接切换更糟。
> 页面进入的动效交给各视图自己的 `.hpf-rise-in`。

### 11.4 操作动线

- **点正文 = 先收浮层，再翻页**（`ReaderView.vue` 的 `handleTap`）：原来点正文既不能翻页
  也不能关面板，想收起 AI 面板必须精准点右上角的 ✕。现在点一下正文先收掉挡在上面的东西，
  没有东西可收时再按横向位置翻页（左 28% 上一页 / 右 72% 下一页）。
- **翻页热区按"阅读面"算，不按 iframe**（`src/reader/bridge.ts` 的 `toHostRatio`）：
  实测分栏排版下 iframe 的视口宽度是**整章展开宽**（9523px，阅读面只有 1024px），
  拿它当分母会让整个屏幕的点击都被算成"最左侧"，翻页方向整个反过来。
  正确换算是 `(iframe.left + clientX - 阅读面.left) / 阅读面.width`，冻结缩放期间还要
  用 rect 宽与布局宽的比反推缩放系数。
- **边缘点击兜底**（`ReaderView.vue` 的 `onSurfaceClick`）：阅读面最左/最右约 36px 落在
  iframe 之外，`bridge` 收不到；在阅读面宿主上补一个 `click` 监听（点在 iframe 内时事件
  不会冒泡到宿主，所以不会重复触发）。
- **Esc 分层关闭**（`dismissTopLayer`）：气泡 → AI 面板 → 术语表 → 目录覆盖层，
  一层一层收，收无可收才 `goBack()`。改造前目录开着时按 Esc 会连书一起关掉。
- **工具栏去掉 `backdrop-blur`**：工具栏下面本来就有 `pt-12` 的留白，那层模糊是纯粹的
  GPU 开销，去掉后视觉不变。
- **wheel 冷却**：一次翻页后 220ms 内的滚动一律忽略（`bridge.ts` 的 `wheelCooldownMs`），
  避免一次甩动连翻好几页。

### 11.5 验证

- **单元测试**：`corepack pnpm run test` 全绿（325 个用例 / 27 个文件）。
- **构建**：清空 `dist` 后 `corepack pnpm run build`（`vue-tsc --noEmit` + `vite build
  --mode production`）通过。产物核验：`dist/assets/index-*.css` 里动效令牌与预设
  （`--dur-1` / `--ease-out` / `t-pop-enter` / `hpf-rise-in` / `hpf-press` / `hpf-meter` /
  `hpf-progress-rail` 等）全部在位，新模块（`hpf-reader-surface`、`allowFreeze`）已进入
  打包后的 JS。
- **E2E**：`corepack pnpm run test:e2e` 全绿（**29 通过 / 2 跳过**，跳过的是性能测量台，
  按设计由 `HPF_PERF` 门控）；跑的就是上面重建出来的 `dist`。新增
  `操作动线：正文点击热区 / Esc 分层关闭 / 点正文收浮层`（`tests/e2e/reader.spec.ts`）
  作为热区与分层的回归锁。
  > 上面这组数字是**第一轮**的。第二轮把状态栏改成默认收起、并补了显隐专项用例，
  > 现在是 **33 通过 / 2 跳过**，见 §11.6。
- **性能测量台**：`tests/e2e/perf-reflow.spec.ts`（`HPF_PERF=1` 才跑，平时自动跳过），
  两个用例分别测"拖阅读面宽度"和"真实窗口缩放"，落盘
  `tests/evidence/client/optimization-reflow-*.json` / `optimization-window-resize.json`。
- **改动文件**：`src/styles/motion.css`（新增）、`src/app/motion.ts`（新增）、
  `src/reader/useReaderReflow.ts`（重排调度）、`src/reader/useReaderLayout.ts`（排版决策，
  拆成"UI 状态"与"几何参数"）、`src/reader/ReaderView.vue`、`src/reader/bridge.ts`、
  `src/reader/components/ReaderToolbar.vue`、`src/features/library/components/BookCard.vue`、
  `src/features/library/LibraryView.vue`、`src/features/ai/components/BookTranslatePanel.vue`、
  `src/app/layouts/AppShell.vue`、`src/features/settings/SettingsView.vue`、
  `src/styles/theme.css`（引入动效层）。

> 兼容性红线不变：仍以 **Chromium 91** 为基线。动效层只用 `transform` / `opacity` /
> WAAPI 这些老能力，**没有**用 `@starting-style`、CSS 嵌套或 `transition-behavior`。
> 产物 CSS 里的现代语法**三项门槛全部为 0**：`@layer` **0**（task-17 的门槛没有回退）、
> `@starting-style` **0**、`@container` **0**。
>
> ⚠️ 踩坑提醒：产物 CSS 里字面量 `@container` 有 1 处，但它**不是 at-rule**，
> 是 Tailwind 的转义类名 `.\@container`（`container-type: inline-size` 工具类）。
> 用 `Select-String '@container'` 这类朴素正则统计会把它误当成"用了 `@container` 语法"，
> 必须**先看前一个字符是不是 `\`**（转义类名）才能区分。

> 桌面 exe：本轮改动**只在前端**。原先本会话 PATH 上没有 `go` / `wails3`（`task` 也没装），
> 按 §3.3 的方式 A 需要 `wails3 generate bindings -ts -i -clean=true` + `go build -o bin\hpfreader.exe .`。
> **已重编完成**：用 §3.0 记录的便携 Go 工具链（`C:\Users\HOTPOTFISH\go-portable\go\bin`，
> `GOTOOLCHAIN=auto` 自动拉取 go1.26.0）直接 `go build -o bin\hpfreader.exe .`，跳过
> `wails3 generate bindings`（本次没有改 Go 侧，绑定无需重生成）。`//go:embed all:frontend/dist`
> 在编译期嵌入**当时**的 `dist`，所以重编前必须先 `cd apps\client\frontend; corepack pnpm run build`
> （否则嵌进去的还是旧 `dist`）。已核对 exe 二进制内含 `reader-resumed` / `statusBarPinned` /
> `data-bar` 等新前端标记，确认嵌入的是最新产物。

## 12. 第二轮打磨：状态栏 / 目录默认收起，续读提示自动消失

用户的原始反馈（三条）：

1. 续读提示**一直显示不会自己消失**，小屏上会遮挡正文；
2. **目录和顶部状态栏应该是默认关闭的**，避免一调整窗口就又弹出来；顶部状态栏可以做成
   "光标靠近自动展开、远离自动折叠"；
3. 移动端用**双击正文**切换状态栏（同时**去掉**原来"单击正文显示顶部状态栏"），
   状态栏上再加一个 **pin 图标**切换"自动隐藏 / 常驻"。

### 12.1 根因（都不是"样式没调好"，是缺机制）

- 续读提示 `reader-resumed` 就是一个 `v-if` 的常驻 `<p>`，**没有任何计时器**；
  更糟的是它带着 `hpf-press`（手型光标 / 可点感）且 `pointer-events` 是默认值 ——
  它压在正文左下角的翻页热区上，**真的会吃掉点击**，不只是视觉遮挡。
- 状态栏一直常驻：`ReaderView` 里工具栏**无条件渲染**，阅读列**无条件** `pt-12`。
- 目录有一条"窗口变宽 → overlay 自动变 sidebar 并展开"的 watch，
  正是"一调整窗口就又弹出来"的来源。

### 12.2 状态栏：三态收敛成两态

`barVisible`（自动显隐）+ `barPinned`（常驻，持久化在 `hpf.settings.v1` 的
`statusBarPinned`），对外只用 `barShown = pinned || visible`。

- **靠近判定**：`pageY - viewTop <= NEAR_TOP_PX(64)`。
- ★ **iframe 是 DOM 里的洞**：指针落在正文上时，宿主的 `pointermove` 一律收不到
  （事件不冒泡出 iframe）。所以"光标靠近顶部"这个信号必须由 bridge 从**章节文档里**
  报回来（`bridge.ts` 的 `onHover` + `pointerPageY`），宿主区域（工具栏条 / 侧栏 /
  内边距）才由根盒自己的 `pointermove` 兜。
- ★ `viewTop` 用 `ResizeObserver` **缓存**，不在每次 `pointermove` 里
  `getBoundingClientRect()` —— 那等于每帧一次强制布局。
- 折叠延迟 `HIDE_DELAY_MS = 420`（短了会闪）；`chromeLocked`（浮层目录 / AI 面板 /
  术语表打开）时**不许**自动收，否则面板会丢掉控制它的入口。
- 收起不是"变透明了"：外层 `pt-12` / `pt-0` 随 `barShown` 切换，那 48px **真的还给正文**；
  高度变化统一走 `useReaderReflow`，合并成**一次离散重排**（不逐帧重排）。
  pin 住时几何与改造前**逐像素一致**，所以第一轮的性能基线仍然可比。

### 12.3 目录：删掉自动展开

`ReaderView.vue` 里 TOC 的 watcher 改成**单向**：只在 `overlay → sidebar`（窗口变窄）
时强制收起，**不再**在 `sidebar → overlay`（窗口变宽）时自动打开。`tocOpen` 默认 `false`。

### 12.4 移动端双击：延后的是**整个单击动作**，不只是翻页

`bridge` 认 `onDoubleTap(pointerType)`，只对 touch / pen 生效（桌面端双击没有语义）。
为了给第二次点击留机会，触屏单击整体延后 `DOUBLE_TAP_MS = 220`。

> ★ 这里的坑：一开始只延后了"翻页"，没收"收浮层"。于是
> **状态栏开着 → 双击想收起** 时，第一次点击先把状态栏收了，第二次（`detail > 1`）
> 又把它切回来 —— 看起来像完全没反应。所以"收浮层"必须和"翻页"一起延后：
> `handleTap` 里把两件事合成一个 `act()`，触屏时整体 `setTimeout`，
> 双击时 `toggleBar()` 会 `clearPendingTap()` 把它取消掉。
> 鼠标不延后（桌面端没有这条路），单击保持即时响应 —— 已有桌面用例全不受影响。

### 12.5 续读提示：4 秒自动消失，且不再吃点击

`RESUME_HINT_MS = 4000`；改成 `pointer-events-none`（顺手去掉 `hpf-press`）。
★ 计时**从 loading 结束才开始**：`watch([resumedFrom, loading])`，加载没结束不启动。
否则冷启动慢一点，提示还没被人看见就到期了 —— E2E 里"重开必须看到续读提示"那句
断言会因此变成假阴性（这个坑在改动前就先绕开了）。

### 12.6 E2E 适配（本轮最大的工作量）

状态栏默认**不在 DOM 里**，所有 `page.getByTestId('next-page').click()` 这类断言都会
直接失败（Playwright 的 actionability 检查：`opacity:0` 算可见，但 `pointer-events:none`
和"被 transform 挪出视口"都会被判为不可点；而 `v-if` 干脆是 0 个元素）。

- 新增 **`tests/e2e/reader-chrome.ts`**：
  - `pinReaderBar(page)`：`addInitScript` **合并**写入 `statusBarPinned: true`
    （合并而不是整体覆盖 —— 覆盖会把主题 / 字号一起抹掉，主题类用例跨 reload 就会
    莫名回到默认值）；初始化脚本在**每次导航前**都会跑，所以 `reload()` 之后仍生效。
  - `revealReaderBar(page)` / `clickReaderChrome(page, testId)`：真的把光标挪到顶部
    （用 `mouse.move` 而不是 `hover()` —— `hover()` 会先做 actionability 检查，
    而此刻元素还不在 DOM 里）。
- 功能型 spec（`reader` / `ai` / `glossary` / `glossary-evidence` / `portrait-evidence` /
  `perf-reflow`）统一在文件级 `beforeEach` 里 `pinReaderBar`：它们验的不是显隐，
  用 pin 把变量按住，版面几何与原基线一致。
- 新增 **`tests/e2e/reader-chrome.spec.ts`**（**故意不 pin**，4 个用例）：
  1. 默认收起（`data-bar="hidden"` + 工具栏 0 个元素）且阅读面顶边**等于**根盒顶边
     → 靠近顶部展开（让出 ≥40px）→ 光标移到正文下方后自己折叠回原样；
  2. pin 后光标离开也**不收**，且 `reload()` 之后仍是常驻（验持久化）；
  3. 续读提示可见 → `pointer-events: none` → 到点自动消失；
  4. 移动端（`test.use({ hasTouch: true, viewport: 480x900 })`）双击展开 / 再双击收起 /
     单击右边缘仍然翻页且**不再**弹出状态栏。
- `reader.spec.ts` 里原来那句"横屏目录自动展开"的断言，按新行为改成
  "默认收起（`toHaveCount(0)`）→ 显式点 ☰ 才出现"。

### 12.7 验证（本轮实测）

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型 | `corepack pnpm exec vue-tsc --noEmit` | 无输出（exit 0） |
| 构建 | `corepack pnpm run build` | `✓ built`，exit 0 |
| 单元 | `corepack pnpm run test` | **325 / 325**（27 文件） |
| E2E | `corepack pnpm exec playwright test` | **33 通过 / 2 跳过**（跳过的是 `HPF_PERF` 门控的性能台） |
| 性能 | `HPF_PERF=1` + `tests/e2e/perf-reflow.spec.ts` | 全绿：`roCallsPerStep 1.017`、`heavyCalls 2`、`over16ms 0`、longtasks 0 —— 与第一轮持平 |

改动文件：`src/reader/ReaderView.vue`、`src/reader/bridge.ts`、
`src/reader/components/ReaderToolbar.vue`、`src/stores/settings.ts`、
`src/i18n/locales/zh-CN.ts`、`src/i18n/locales/en.ts`、`src/styles/motion.css`、
`tests/e2e/reader-chrome.ts`（新增）、`tests/e2e/reader-chrome.spec.ts`（新增），
以及 6 个既有 spec 的 `beforeEach`。

> 桌面 exe 已重编（见 §11 末尾说明），嵌入的即最新前端产物。
> 在有 Go 工具链的机器上按 §3.3 方式 A 跑一遍即可。

## 13. 第三轮：排版（初排）耗时排查与修复

用户反馈：**排版会花很长时间，十几甚至数十秒**，附 1919×1199 大窗截图（双栏 + 侧栏）。

### 13.1 排查路径（逐层排除，全部用测量，不猜）

**先证明"初排本身不慢"**：写了 `tests/e2e/perf-open.spec.ts`（初排测量台），在 1919×1199 下
打开 frankenstein.epub，量"打开书到拿到第一个 CFI"的墙钟与重排次数。

| 书 | 章节/段落/图 | openMs | RO 次数 | 重排(heavy) | 长任务 |
|---|---|---|---|---|---|
| frankenstein | 小 | **251ms** | 4 | 0 | 0 |
| large-book（自造） | 20 章/2400 段/120 图 | **288ms** | 4 | 1 | 1（53ms） |
| single-chapter-large（自造） | **1 章/4000 段/400 图** | **1583ms** | 4 | 1 | **5（最大 529ms）** |

→ **初排耗时与"单章元素数"强相关，与章节数无关**（foliate-js 是惰性加载，每次只加载
当前章节）。小书 251ms，单章大书 1583ms，且出现 529ms 长任务。用户书若单章元素数更大，
按线性放大到十几秒完全合理。

**再写完整动线测量台** `tests/e2e/perf-flow.spec.ts`（开书→光标靠近→离开→再靠近→缩放），
证明状态栏切换（`pt-12`↔`pt-0`）和窗口缩放都只产生 1–2 次重排、1.7ms，**不是瓶颈**。

**细粒度分解** `tests/e2e/perf-breakdown.spec.ts` + **CPU profile** `tests/e2e/perf-profile.spec.ts`
（CDP `Profiler`，按函数名聚合 self time）定位热点：

| 热点 | 优化前 | 说明 |
|---|---|---|
| `(program)` 浏览器内部 | 893ms | iframe 文档的解析 + 布局 |
| **`expand` + `getBoundingClientRect`** | **400ms** | foliate-js 布局循环，expand 被调 210 次 |
| `visitNode` / `loadReplaced` / `acceptNode` | 155ms | epub.js DOM 遍历 + URL 重写 |
| `setImageSize` | 28ms | 逐图 `getComputedStyle` |
| `Wn`(ReaderView) | 55ms | 应用层 |
| `(garbage collector)` | 30ms | |

**sanitize 只有 17ms——净化器不是瓶颈。**

### 13.2 根因

foliate-js 的 **Paginator 用 `ResizeObserver` 观察 iframe 内的 `doc.body`**（paginator.js:273），
回调直接调 `expand()`。`expand()` 调 `getBoundingClientRect()` **强制同步布局**。

单章大文档里图片多，**图片加载过程中 `doc.body` 内容高度不断变化** → 每次变化触发
Paginator 的 RO → `expand()` → 强制布局 → 改 iframe 尺寸 → 又可能触发下一轮 RO →
**布局反馈循环**。400 张图产生 210 次 expand、207 次 `getBoundingClientRect`，累计 400ms+。
（主窗口的 RO instrument 只覆盖宿主侧，**不覆盖 iframe 内的 RO**，所以 `ro.calls` 只有 4
但 expand 有 210 次——这个矛盾本身就是线索。）

### 13.3 修复：图片占位（`ReaderView.vue` 的 `stabilizeImages`）

在 `onLoad`（每次章节文档加载后）里给章节文档的图片：

1. **设 `aspect-ratio` 宽高比占位**——已加载的图直接读 `naturalWidth/naturalHeight`；
   未加载的用 `img.decode()` 异步补设。这样图片在加载前后占据一致的空间，
   加载完成不再引起 `doc.body` 高度跳动，**直接减少 RO→expand 的触发次数**。
2. **设 `decoding="async"`**——图片解码不阻塞主线程，减少长任务。

不改图片最终显示尺寸（仍由 foliate-js `setImageSize` 的 `max-height/max-width` 约束），
只减少加载过程中的布局抖动。

### 13.4 验证（优化前后对比）

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| `openMs`（单章大书初排） | 1627ms | **991–1046ms** | **↓ 36–39%** |
| `longtasks` 总时长 | 1154ms | **595–664ms** | **↓ 42–48%** |
| `longtasks` 最大 | 541ms | **321–333ms** | **↓ 38%** |
| `expand` + `getBoundingClientRect` | 400ms | **246ms** | **↓ 39%** |
| `(program)` 浏览器内部 | 893ms | **520ms** | **↓ 42%** |
| `loadReplaced` | 60ms | **33ms** | **↓ 46%** |
| GC | 30ms | **13ms** | **↓ 57%** |

所有主要热点下降 34–60%，初排耗时下降约 39%。对用户的真实大书（单章元素数更大），
因布局变化次数随图片数线性增长，收益会更显著。

### 13.5 验证（回归）

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型 | `corepack pnpm exec vue-tsc --noEmit` | 无输出（exit 0） |
| 构建 | `corepack pnpm run build` | `✓ built`，exit 0 |
| 单元 | `corepack pnpm run test` | **325 / 325**（27 文件） |
| E2E | `corepack pnpm exec playwright test` | **33 通过 / 6 跳过**（跳过的是 `HPF_PERF` 门控的性能台） |

改动文件：`src/reader/ReaderView.vue`（新增 `stabilizeImages` + `onLoad` 调用）。

新增测量台（`HPF_PERF=1` 门控，不进常规 E2E）：`tests/e2e/perf-open.spec.ts`、
`tests/e2e/perf-flow.spec.ts`、`tests/e2e/perf-breakdown.spec.ts`、`tests/e2e/perf-profile.spec.ts`。
自造测试书：`tests/tools/make-large-epub.mjs`、`tests/tools/make-single-chapter-epub.mjs`
（产出 `tests/fixtures/books/large-book.epub`、`single-chapter-large.epub`）。

> 桌面 exe 已重编（见 §11 末尾说明），嵌入的即最新前端产物。
> 注：`perf-open.spec.ts` 支持 `HPF_BOOK` 环境变量覆盖书路径，方便测不同规模的书。
