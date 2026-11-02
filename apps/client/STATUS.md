# apps/client 交付状态

> 覆盖 **task-9**（客户端骨架）、**task-12**（本地优先阅读闭环 + 横竖屏自适应）、
> **task-14**（老旧 WebView 兼容性）、**task-17**（`@layer` CSS 兼容性）。
> 最后核对时间：2026-11-03。
> 所有命令均在 Windows + PowerShell 下实测通过，原始输出见 `apps/client/evidence/`。

**状态：**
- task-9 骨架：已完成。
- task-12 阅读闭环 / 横竖屏：**已完成**（9/9 E2E 通过，含真实公版书）。
- task-14 老旧 WebView 兼容性：**已完成**（审计 + polyfill + 构建目标 + 单测 + E2E 模拟验证）。
- task-17 `@layer` 扁平化：**已完成**（§10，产物 CSS 中 `@layer` 由 5 → **0**）。
- task-12 的"真实 exe 截图"：**已完成**（4 张真实窗口截图，见 §8.3）。

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

## 3. 怎么在本地跑（Windows / PowerShell）

> 环境前提：Go 1.22+（会自动切到 go1.26 工具链）、Node 20+、`corepack` 可用、Wails v3 CLI。
> **本项目一律用 `corepack pnpm`，不要用 npm**（会与 pnpm 的 node_modules 布局冲突）。

```powershell
# 0. 每个新终端都先设好环境（Go 工具链 / 代理）
$env:PATH = 'C:\Users\HOTPOTFISH\go-portable\go\bin;' + $env:PATH
$env:GOTOOLCHAIN = 'auto'
$env:GOPROXY = 'https://goproxy.cn,direct'
```

### 3.1 只跑前端（最快，浏览器里直接看效果）

```powershell
cd apps\client\frontend
corepack pnpm install
corepack pnpm run dev          # → http://127.0.0.1:9245/#/reader/sample
```

打开`http://127.0.0.1:9245/#/reader/sample` 即可看到内置示例书；
`/#/` 是书库、`/#/settings` 是设置。这条路径**不需要** Go 侧，走 `server` 平台实现。

### 3.2 测试与构建

```powershell
cd apps\client\frontend
corepack pnpm run test         # vitest：27 个用例
corepack pnpm run build        # vue-tsc 类型检查 + vite 生产构建

# E2E：需要一个真实 Chrome（Playwright 用 channel:'chrome'，不下载自带浏览器）
corepack pnpm run test:e2e     # 会自动起 vite preview（127.0.0.1:4173）
```

### 3.3 桌面应用（Wails / Go 外壳）

```powershell
cd apps\client\frontend; corepack pnpm run build; cd ..\..
cd apps\client

# 方式 A（推荐，实测通过）：显式两步，不依赖 go-task
wails3 generate bindings -ts -i -clean=true
go build -o bin\hpfreader.exe .

# 方式 B：完整打包（需要 Git 的 usr\bin 提供 uname/tail，且需要一个 pnpm shim）
$shim = Join-Path $env:TEMP 'hpf-pnpm-shim'
New-Item -ItemType Directory -Force -Path $shim | Out-Null
Set-Content -Path (Join-Path $shim 'pnpm.cmd') -Value '@corepack pnpm %*' -Encoding ascii
$env:PATH = "$shim;C:\Program Files\Git\usr\bin;" + $env:PATH
wails3 build PACKAGE_MANAGER=pnpm

.\bin\hpfreader.exe          # 启动桌面应用
```

> `PACKAGE_MANAGER=pnpm` 不能省：Taskfile 默认 `npm`，而 `npm install` 会破坏 pnpm 的
> `node_modules` 布局（模板里 `pnpm` 是官方支持的取值，见 `build/Taskfile.yml:46`）。

### 3.4 联调后端（可选）

```powershell
# 终端 1：后端
cd apps\server; go run .            # 见 apps/server 自己的说明
# 终端 2：前端，指向后端
cd apps\client\frontend
$env:VITE_HPF_API_BASE = 'http://127.0.0.1:8080'
corepack pnpm run dev
```

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
    ├── e2e/                    # Playwright（真实 Chrome）
    ├── tests/                  # 架构门禁
    └── scripts/                # gen-api-types / make-sample-epub
```

---

## 8. task-12：本地优先阅读闭环 + 横竖屏自适应

### 8.1 完成项

- [x] **本地优先闭环**：本地选书 → 导入书库 → 阅读 → 分页/翻页/目录 → **进度落盘** → 重开续读。
      全链路不依赖后端。桌面端走 Wails 原生文件对话框（`files.dialog` 能力）。
- [x] **书库空态可用**：后端不可达时显示 `library-local-mode` 提示条（琥珀色、非阻断）+
      `library-empty` 空态 + "打开本地文件"按钮，**不白屏、不报错**。
      `import-book` 仅在 `files.dialog` 与 `library.local` 两个能力同时具备时才出现。
- [x] **拖放导入**：书库区支持 `dragover/dragleave/drop`，拖入 EPUB 直接进阅读器。
- [x] **真实公版书验证**：用 `testdata/books/frankenstein.epub`（294 175 B，
      sha256 `bf04d57cf243314ab770df6fcea6a9cfb1e5a281426453e23c128c5a9c3eb662`）
      实测：目录 32 项、正文 7 375 字符/章、多页分页、翻页 CFI 变化。测量值落盘在
      `evidence/real-book-open.json`。
- [x] **横竖屏自适应**：
      | 视口 | 方向 | 栏数 | 目录 | 工具栏 |
      |---|---|---|---|---|
      | ≥1024px 宽 | 横屏 | **2 栏** | 侧栏（≥1080px 才侧栏，否则覆盖层） | 完整（带文字标签） |
      | <1024px 或竖屏 | 竖屏/窄 | **1 栏** | 覆盖层 | 紧凑（仅图标） |
      旋转后**自动重排且不丢位置**：同一 CFI 在 1280×800 → 480×900 → 1440×900 三次测量中，
      章节不变（`textStart` 一致）、页数 11 → 18 → 11。数据见
      `evidence/reader-layout-measurements.json`。
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
| `evidence/exe-01-library-empty.png` | 书库空态（无后端也不白屏） | 26 663 B |
| `evidence/exe-02-reader-opened.png` | 打开示例书后的正文（第一章，36%） | 68 007 B |
| `evidence/exe-03-after-page-turn.png` | 翻页后（第三章，100%，"已从上次位置继续"） | 53 705 B |
| `evidence/exe-04-night-mode.png` | 夜间模式（正文深色，主题按钮显示"夜间"） | 54 180 B |

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
  - `evidence/task-17-layer-raw-output.txt`（**@layer 修复前后原始输出**：5 → 0、审计门禁、反向验证）
- `evidence/e2e-legacy-css-layer.png`（**模拟 WebView 91 不支持 @layer** 下的真实 EPUB：双栏、31 章目录、Letter 2 正文）
- `evidence/e2e-landscape-wide.png`（1280×800，横屏双栏 + 侧栏目录）
  - `evidence/e2e-portrait-narrow.png`（480×900，竖屏单栏 + 紧凑工具栏）
  - `evidence/e2e-night-mode.png`（夜间模式，正文深色 `rgb(20, 22, 26)`）
  - `evidence/e2e-sample-reader.png`（示例书正文）
  - `evidence/e2e-legacy-webview-sim.png`（删掉 ES2022+ 内置对象后仍能阅读）
  - `evidence/real-book-open.json`（真实公版书打开/跳章/翻页的引擎测量值）
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
- **E2E** `e2e/reader.spec.ts` 新增两条，都用 `page.addInitScript` 在**任何应用脚本执行之前**把
  真实 WebView 91 的能力差异**复刻**出来：
  1. 把 16 个 ES2022+ 内置对象全部 `delete`，断言应用仍能打开书、完成分页、翻页，
     且 `pageerror` 为空。没有 polyfill 时这条会以
     `Object.groupBy is not a function` 失败 —— 与模拟器上的报错完全一致。
  2. 把 `DecompressionStream` 换成"gzip/deflate 可用、deflate-raw 抛错"的 Chrome 91 复刻版，
     断言 **frankenstein.epub**（36 个 deflate 条目）仍能打开、目录 ≥20 项、跳章后有正文、
     翻页可用、`pageerror` 为空。没有兜底时这条会以
     `Unsupported compression format: 'deflate-raw'` 失败。

### 9.6 原始输出

`evidence/task-14-compat-raw-output.txt` 收录了 5 条命令的**完整原始输出与退出码**：

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
| `testdata/books/frankenstein.epub` | 294 175 B | `{0: 2, 8: 36}` |
| `testdata/books/alice-in-wonderland.epub` | 136 756 B | `{0: 2, 8: 19}` |
| `testdata/books/pride-and-prejudice.epub` | 609 138 B | `{0: 2, 8: 22}` |

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
| E2E | `模拟 Chromium 91 缺 deflate-raw`：用 `addInitScript` 把 `DecompressionStream` 换成"gzip/deflate 可用、deflate-raw 抛错"的 Chrome 91 复刻版，然后打开 **frankenstein.epub** —— 断言目录 ≥20 项、点击跳章后正文 >2 000 字符、翻页 CFI 变化、`pageerror` 为空 | **通过**，截图 `evidence/e2e-legacy-deflate-raw.png` |

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
真实书验收请用 `testdata/books/frankenstein.epub`（31 章、含 36 个 deflate 条目），
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

原始输出全文见 `apps/client/evidence/task-17-layer-raw-output.txt`。

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