# apps/client 交付状态（task-9：客户端骨架 Wails v3 + Vue 3 + foliate-js）

**状态：已完成（可构建 / 可测试 / 可在真实浏览器里打开一本 EPUB）。**
最后核对时间：2026-11-02。所有命令均在 Windows + PowerShell 下实测通过。

---

## 1. 已完成

### 1.1 外壳与工程结构

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

---

## 6. 踩坑记录（避免重复踩）

- `wails3 init -d apps/client -n HPFReader` 会生成 `apps/client/HPFReader/`，
  需要把内容（含隐藏文件）上提到 `apps/client/` 再删掉那层。
- `TS 6` 里 `baseUrl` 已弃用（`TS5101`）：`paths` 直接相对 tsconfig 解析，不要写 `baseUrl`。
- **不要**给 `foliate-js` 配 tsconfig `paths` 映射：会覆盖 `src/reader/foliate.d.ts` 的
  ambient 声明，导致 `vue-tsc` 去解析没有类型的上游 JS。运行时别名只在 `vite.config.ts` 里配。
- `vitest.config.ts` **故意不复用** `vite.config.ts`：后者的 Wails 插件在测试环境会捣乱。
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
