# HPF-Reader 调研报告 50:Vue 3 阅读器前端技术栈(含 foliate-js 集成与 Wails v3 协作)

- 调研员:`vue-research`(任务板 id:**task-5**)
- 调研日期:**2026-11-02**(下文所有"访问日期"均为实际抓取日期)
- 交付范围:仅 `docs/research/50-vue3-reader-stack.md`。未写业务代码、未初始化工程、未改动 `docs/research` 之外的文件
- 前置决策(不在本文重新论证):**客户端外壳 = Wails v3(Go)**,**前端框架 = Vue 3**
- 证据获取方式:npm registry(`registry.npmjs.org` 单版本元数据与 `dist-tags`)、GitHub raw 原文文件、jsDelivr `data.jsdelivr.com` 仓库文件清单、官方文档原文、SearXNG MCP 检索
- **未取到一手证据的内容一律标注「未验证」,不编造版本号 / 库名 / 项目名**
- 环境限制说明:内置 `web_search` 端点本次不可用,全部检索通过 SearXNG MCP 完成;`api.github.com` 在本次调研中返回 **403 rate limit**(未认证配额耗尽),因此**所有仓库级事实均改用 raw 原文文件与 jsDelivr 清单佐证,不引用 GitHub API 的 star / 时间字段**;凡是未能用 raw 原文证实的字段,一律写「未验证」

---

## 0. 结论速览(TL;DR)

| 议题 | 结论 | 置信度 |
|---|---|---|
| 版本基线 | Vue **3.5.44**(stable);Vue 3.6 **仍是 rc**(3.6.0-rc.14, 2026-10-30),**Vapor 不可用于生产** | 高(npm dist-tags + 官方 CHANGELOG 原文) |
| 构建 | Vite **8.3.5**(Rolldown 单一打包器)+ `@vitejs/plugin-vue` 6.0.10;Node **22.12+ / 24 / 26**(由 Vitest 5、VueUse 15 的 engines 反推) | 高(npm peer / engines 元数据) |
| 类型 | TypeScript **7.0.2** 已成为 `latest`;保守做法是先锁 **6.x**,等 `vue-tsc` + 团队工具链在 TS7 上跑通再升 | 中高(需实测,见 1.4) |
| 状态 | Pinia **4.1.0** setup stores + `pinia-plugin-persistedstate` **4.7.1**(peer `pinia >= 3.0.0`,兼容 4.x) | 高(npm peerDeps 原文) |
| 服务端状态 | `@tanstack/vue-query` **5.105.2** 只放**服务端权威数据**(书库列表、元数据、LLM 任务);**绝不**放同步引擎状态 | 高 |
| UI 组件 | **首选 Reka UI 2.11.0(无样式原语)+ Tailwind 4.3.3**;需要成套中后台组件时备选 **Naive UI 2.45.3**;否决 Element Plus 作为阅读器主组件库 | 中高(主观判断已标注) |
| 渲染引擎 | 继续用 **foliate-js(MIT)**,但**必须 fork / vendor 自持**,并针对 Vite 打补丁(上游无 release、无构建步骤、`pdf.js` 用 `fetch(new URL(...))` 取 CSS) | 高(上游 README + 真实 fork 补丁脚本) |
| **foliate-js × Vue 最大陷阱** | 「把实例放进 `ref`」= 灾难。**实例一律放在组件闭包普通变量或 `shallowRef` + `markRaw`**;`foliate-view` 是 **custom element**,不能当普通 Vue 组件写 | 高(Vue 官方文档 + 社区实现佐证) |
| **iframe 坐标系** | overlayer 的 SVG **不在 iframe 里**,它在 `foliate-paginator` 的 **shadow root** 里、尺寸与 iframe 对齐;而 `Range.getClientRects()` 返回 **iframe 视口坐标** → 主文档浮层必须做 `iframe.getBoundingClientRect()` 换算 | 高(上游 `paginator.js` / `overlayer.js` 源码) |
| PDF | pdf.js(`pdfjs-dist` 6.5.438, Apache-2.0);**canvas + textLayer 双渲染**,按「可视 ±N 页」窗口化挂载,离开窗口销毁 canvas 释放位图 | 中高(实践共识,见第 6 节) |
| 长列表 | 首选 `@tanstack/vue-virtual` 3.13.51(headless,同一 API 覆盖书库网格 / 目录树 / 搜索结果);`vue-virtual-scroller` 3.0.5 作备选 | 中高 |
| 响应式 / 横竖屏 | VueUse 15:`useMediaQuery` / `useScreenOrientation`(**不是 `useOrientation`**)/ `useResizeObserver` / `useStorage`;阅读区自适应用 **CSS 容器查询** | 高(已在 VueUse 15 IIFE bundle 中逐一验证函数名存在) |
| PWA 兜底 | `vite-plugin-pwa` 2.0.0(peer 支持 `vite ^8`);本地 DB **优先 `opfs-sahpool`(不需要 COOP/COEP)**,代价是单连接 + 必须做外部持久化护栏 | 高(SQLite 官方 wasm 文档原文) |
| 测试 | Vitest 5.0.5 + `@vue/test-utils` 2.5.1 测组件;`foliate-js` **只能 E2E 测**(Playwright 1.64.1),不建议单测 mock | 中高(策略性建议) |
| 可直接参考的真实项目 | `jinhuan138/vue-book-reader`(Vue3 × foliate-js 封装,Apache-2.0)、`yzfly/LightRead`(Tauri2 + Vue3 全功能阅读器,AGPL-3.0)、`laowus/Less-Reader`(Electron + Vue3 + foliate-js) | 高(README / package.json 原文) |

---

## 1. 版本基线

### 1.1 实测版本表(npm registry,`/latest` 与 `dist-tags`,访问日期 2026-11-02)

| 包 | `latest` | 证据 |
|---|---|---|
| `vue` | **3.5.44** | `https://registry.npmjs.org/-/package/vue/dist-tags` → `{"alpha":"3.6.0-alpha.7","beta":"3.6.0-beta.17","latest":"3.5.44","rc":"3.6.0-rc.14"}` |
| `vite` | **8.3.5** | `.../vite/dist-tags` → `{"alpha":"6.0.0-alpha.24","beta":"8.3.0-beta.1","latest":"8.3.5","previous":"6.4.5"}` |
| `typescript` | **7.0.2** | `.../typescript/dist-tags` → `{"latest":"7.0.2","beta":"7.1.0-beta","next":"7.1.0-dev.20261102.1"}` |
| `pinia` | **4.1.0** | `.../pinia/dist-tags` |
| `vue-router` | **5.4.0** | `registry.npmjs.org/vue-router/latest`(MIT;仓库 `vuejs/router` 的 `packages/router/package.json` 原文) |
| `@vueuse/core` | **15.0.0** | peers `vue ^3.5.0`,engines `node >=22` |
| `reka-ui` | **2.11.0**(MIT) | peers `vue >= 3.4.0`;旧包 `radix-vue` 停在 1.9.17 |
| `tailwindcss` | **4.3.3**(MIT) | — |
| `naive-ui` | **2.45.3**(MIT) | peers `vue ^3.0.0`,engines `node >=20` |
| `element-plus` | **2.14.7**(MIT) | peers `vue ^3.3.7` |
| `@tanstack/vue-query` | **5.105.2**(MIT) | peers `vue ^2.6.0` 或 `^3.3.0` |
| `@tanstack/vue-virtual` | **3.13.51**(MIT) | peers `vue ^2.7.0` 或 `^3.0.0` |
| `vue-virtual-scroller` | **3.0.5**(MIT) | peers `vue ^3.3.0` |
| `vue-i18n` | **11.4.17**(MIT) | peers `vue ^3.0.0`,engines `node >= 22` |
| `@intlify/unplugin-vue-i18n` | **11.2.8** | — |
| `pdfjs-dist` | **6.5.438**(Apache-2.0) | engines `>=22.13.0` 或 `>=24` |
| `vite-plugin-pwa` | **2.0.0**(MIT) | peers 含 `vite ^8.0.0`、`workbox-build ^7.4.1`、`workbox-window ^7.4.1`;engines `node >=20.19.0` |
| `vitest` | **5.0.5**(MIT) | peers `vite ^6.4` 至 `^8`;engines `node ^22.12.0` 或 `^24.0.0` 或 `>=26.0.0` |
| `@vue/test-utils` | **2.5.1**(MIT) | — |
| `@playwright/test` | **1.64.1**(Apache-2.0) | — |
| `@wailsio/runtime` | **3.1.0**(MIT) | Wails v3 前端运行时 |
| `@vitejs/plugin-vue` | **6.0.10** | — |
| `vue-tsc` | **3.3.14**(MIT) | peer `typescript >=5.0.0`;依赖 `@vue/language-core 3.3.14`、`@volar/typescript 2.4.30` |

> ⚠️ **npm 上的 `foliate-js` 不是官方发布**:`registry.npmjs.org/foliate-js` 只有 **1.0.0 / 1.0.1** 两个版本,发布时间 **2025-04-21**,维护者 **`shmandadi`**(上游作者是 John Factotum;`johnfactotum/foliate-js` 的 `package.json` 里 version 是 `0.0.0`,且上游 README 明确写 "there's no release yet ... include the library as a git submodule")
> **结论:不要通过 npm 安装 `foliate-js`,用 git submodule 或 pnpm `link:` 指向自持 fork。**
> 反例警示:`yzfly/LightRead` 的 `package.json` 声明 `"foliate-js": "^1.0.1"`(访问日期 2026-11-02),即它确实用了这个第三方发布包 —— 我们**不跟随**这个做法。

### 1.2 Node 版本要求(依赖交叉反推)

我们没有找到"Vue 3 官方要求 Node X"的一手声明,因此采用**依赖 engines 反推**(全部为一手 npm 元数据,访问日期 2026-11-02):

| 依赖 | 声明 | 含义 |
|---|---|---|
| `vitest@5.0.5` engines | `^22.12.0` 或 `^24.0.0` 或 `>=26.0.0` | 这是**最紧**的一条 |
| `@vueuse/core@15.0.0` engines | `node >=22` | — |
| `vue-i18n@11.4.17` engines | `node >= 22` | — |
| `pdfjs-dist@6.5.438` engines | `>=22.13.0` 或 `>=24` | — |
| `vite-plugin-pwa@2.0.0` engines | `node >=20.19.0` | 最松 |

**推荐:`.nvmrc` / `devEngines` 锁 Node 22 LTS 线的最新补丁版,CI 与本地一致。** Node 发布索引(`https://nodejs.org/dist/index.json`,访问日期 2026-11-02)显示最新为 `v27.0.0-alpha.0.0.0`(2026-10-29)与 `v26.13.0`(2026-10-28);**但"哪个版本是当前 Active LTS"这一结论未在本次调研中取得一手页面标注,标为「未验证」**,不要据此直接上 Node 26。

### 1.3 Vapor mode 与 Vue 3.6:现在能不能用?

**官方证据(一手,全部访问日期 2026-11-02)**:

- `vuejs/core` **`minor` 分支 CHANGELOG** 顶部是 `# [3.6.0-rc.14](...) (2026-10-30)`,修复项集中在 `compiler-vapor` / `runtime-vapor` / `vapor`(例如 "avoid fragment flags for v-once dynamic components"、"hydrate a v-if chain by the branch the server rendered")。
  来源:`https://raw.githubusercontent.com/vuejs/core/minor/CHANGELOG.md`
- `vuejs/core` **`main` 分支 CHANGELOG** 顶部是 `## [3.5.44] (2026-10-13)` → **`main` = 3.5 stable 线**。
  来源:`https://raw.githubusercontent.com/vuejs/core/main/CHANGELOG.md`
- `main` 的 `packages/vue/package.json`:`"version": "3.5.44"`。
  来源:`https://raw.githubusercontent.com/vuejs/core/main/packages/vue/package.json`
- npm dist-tags 里 **没有任何 `vapor` tag**;Vapor 只存在于 `rc`(3.6.0-rc.14)与 `beta`(3.6.0-beta.17)。

**判定**:

| 特性 | 状态 | 本项目的处置 |
|---|---|---|
| Vue 3.5.x(`<script setup>`、`defineModel`、`useTemplateRef`、响应式 props 解构) | **stable** | **立刻用**,基线锁 `vue@~3.5.44` |
| Vue 3.6(响应式重写、更小基线) | **rc** | **不用**。GA 后做一次"零代码改动"升级评估 |
| Vapor mode(编译期跳过虚拟 DOM) | **rc / 仍在演进**(连 slot 语义、hydration 恢复都在改) | **明确否决在生产使用**,与任务书"别把实验特性当稳定特性"一致 |

> "Vapor 在 3.6 RC 中 feature-complete"这类措辞我们**只在第三方二手页面见到**,未在 `vuejs/core` 一手文件里取到等价表述 → **「未验证」**,不据此决策。

**Vapor 对本项目的额外否决理由(阅读器特有)**:foliate-js 是 **custom element + 命令式 DOM**;Vue 在这里的价值是生命周期与状态桥接,**几乎不产生虚拟 DOM 收益**。真正吃 CPU 的是分页、重排、渲染,它们在 foliate-js 内部。**上 Vapor 收益趋近于零,风险却是"每一版 rc 都可能改 slot / hydration 语义"。**

### 1.4 TypeScript:7.0.2 已是 latest,但我们建议先锁 6.x

事实(一手,访问日期 2026-11-02):

- `typescript` dist-tags:`latest = 7.0.2`,`next = 7.1.0-dev.20261102.1`。
- `vue-tsc@3.3.14` 的 `peerDependencies` 只写 `typescript >=5.0.0`(未对 TS 6/7 做区分),其 `devDependencies` 用 `"typescript": "latest"`。
- 生态实测参考:`yzfly/LightRead` 用 `typescript ~6.0.2` + `vue-tsc ^3.3.5`。

**建议**:基线 `typescript@~6.0.2` + `vue-tsc@^3.3.14`;CI 里加一条**不阻塞合并**的"TS 7 预演"类型检查。理由:TS 7 是编译器代际切换,影响的不只是 `tsc`,还有 ESLint 类型规则、`vue-tsc`、编辑器语言服务;我们**没有**取得"TS7 + Volar/vue-tsc 组合已被官方验证"的一手声明 → **「未验证」**。

### 1.5 `tsconfig` 建议(基于 `@vue/tsconfig@0.9.1`,MIT)

~~~jsonc
// tsconfig.json(应用根)
{
  "extends": "@vue/tsconfig/tsconfig.dom.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,      // 长列表/数组下标最容易出 bug,阅读器必开
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "types": ["vite/client", "vite-plugin-pwa/client"],
    "paths": { "@/*": ["./src/*"], "@hpf/ui/*": ["./packages/ui/src/*"] }
  },
  "include": ["src/**/*", "src/**/*.vue", "env.d.ts"]
}
~~~

要点:
1. `verbatimModuleSyntax`:Wails 生成的 bindings 是 ESM 常量导出,该选项能避免 `import` 被错误消除。
2. `types` 必须显式加 `vite-plugin-pwa/client`,否则 `virtual:pwa-register` 报类型错。
3. **不要幻想给 `foliate-js` 开严格类型校验**——它是纯 JS 且无 `.d.ts`,走手写 `declare module`(见 5.2)。

---

## 2. 工程结构(pnpm workspace,feature 切片)

### 2.1 顶层布局

~~~
HPF-Reader/
├─ pnpm-workspace.yaml
├─ package.json                     # 根:只放脚本与 devDeps(不装业务依赖)
├─ apps/
│  ├─ desktop/                      # Wails v3 外壳工程(Go)
│  │  ├─ go.mod
│  │  ├─ main.go                    # application.New(...) + services 注册
│  │  ├─ services/                  # ★ 导出给前端的 Go 服务(只暴露稳定接口)
│  │  ├─ core/                      # 纯 Go 领域逻辑:定位(CFI/进度)、合并、DB 访问
│  │  └─ frontend/                  # ★ Vite 工程根,产出 dist 交给 Wails embed
│  │     ├─ index.html
│  │     ├─ vite.config.ts
│  │     ├─ bindings/               # ★ wails3 generate bindings 产物(生成物,勿手改)
│  │     └─ src/
│  └─ web/                          # (可选)纯 Web 目标:复用 packages/*,只换 platform 实现
├─ packages/
│  ├─ ui/                           # 设计系统:无业务语义的组件 + 主题变量
│  ├─ platform/                     # ★ 平台抽象层(见 2.3)
│  ├─ reader-engine/                # ★ foliate-js 自持 fork + 封装(见第 5 节)
│  ├─ sync-core/                    # ★ 同步引擎(纯 TS,零框架依赖)
│  ├─ shared/                       # 协议类型、zod schema、常量
│  └─ i18n/                         # 语言包 + 术语表
└─ docs/
~~~

**为什么 `reader-engine` 必须独立成包**(一手理由):上游 README 明说库**不稳定**——"Expect it to break and the API to change at any time. Use it at your own risk."、"it is recommended that you include the library as a git submodule"。把它隔在独立包里,未来换引擎(如 Readium ts-toolkit)时引爆半径最小。

### 2.2 应用内 feature 切片(vue 应用 `src/`)

~~~
src/
├─ main.ts                    # createApp + pinia + router + i18n + pwa register
├─ app/
│  ├─ App.vue
│  ├─ layouts/                # AppShell / ReaderLayout / MobileLayout
│  └─ router/
├─ features/                  # ★ 按业务能力切片,不是按技术分层
│  ├─ library/                # 书库:网格、筛选、导入、扫描
│  │  ├─ components/          #   LibraryGrid.vue / BookCard.vue / ImportDropZone.vue
│  │  ├─ composables/         #   useLibraryQuery.ts / useLibraryFilter.ts
│  │  ├─ stores/              #   libraryStore.ts(仅本地 UI 状态)
│  │  └─ index.ts             #   只导出对外 API;禁止外部深引内部文件
│  ├─ reader/                 # ★ 阅读器
│  │  ├─ components/          #   ReaderHost.vue / ReaderToolbar.vue / SelectionPopover.vue
│  │  ├─ composables/         #   useFoliateView.ts / useSelectionAnchor.ts / useReaderLayout.ts
│  │  ├─ overlays/            #   高亮 / 批注浮层(主文档侧)
│  │  └─ index.ts
│  ├─ toc/                    # 目录树(虚拟化)
│  ├─ annotations/            # 高亮 / 笔记 / 书签
│  ├─ sync/                   # 同步面板(只读展示 SyncEngine 快照)
│  ├─ ai/                     # 翻译 / 人名归一化 / 问答
│  ├─ settings/               # 主题、字体、排版、快捷键
│  └─ auth/
├─ platform/                  # ★ 见 2.3(实现在 packages/platform,这里只做注入)
├─ composables/               # 跨 feature 复用的通用 composable
├─ assets/  styles/  locales/
└─ env.d.ts
~~~

**composables 的组织规则**(建议纳入 code review 清单):

| 位置 | 放什么 | 例子 | 禁止 |
|---|---|---|---|
| `features/<f>/composables/` | 只有该 feature 用得到 | `useLibraryFilter` | 被别的 feature 直接 import |
| `src/composables/` | 至少 2 个 feature 复用的通用逻辑,**不含业务实体** | `useDebouncedCallback`、`useIframeBridge` | 出现 `Book` / `Annotation` 类型 |
| `packages/reader-engine/` | 与框架无关的引擎封装(**纯类 / 函数 + 极薄响应式外壳**) | `createFoliateEngine()` | 出现 Vue 组件 |
| `packages/platform/` | 平台能力 | `files.openBook()` | 出现 UI |

**命名约定**:composable 一律 `use*`,且**只从切片 `index.ts` 导出**,避免 `../../reader/composables/useX` 这类跨切片深引。

### 2.3 平台抽象层:业务代码**不允许**直接 import bindings(核心建议)

Wails v3 的官方工作流是:`wails3 generate bindings` 生成 TS/JS 绑定,**构建前端之前必须先重新生成**(官方「前端运行时」文档原文:"请在构建前端之前生成绑定";`-ts` / `-i` / `-names` 等旗标见官方「进阶绑定」页,访问日期 2026-11-02)。

生成物的两个现实问题:
1. **它是生成物**,路径与文件名由 Go 包结构决定,重构 Go 侧会打散前端 import;
2. **Web 构建下它不存在**(Web 目标没有 Wails 运行时),`@wailsio/runtime` 在浏览器里 import 会直接炸。

因此设计三层(业务只依赖第 1 层):

~~~ts
// packages/platform/src/types.ts —— 唯一契约层(零 Wails 依赖)
export interface Platform {
  readonly kind: 'wails' | 'web' | 'test'
  files: {
    openBook(): Promise<{ path: string; name: string; bytes: Uint8Array }>
    saveCover(bookId: string, png: Uint8Array): Promise<string>
  }
  library: {
    list(query: LibraryQuery): Promise<BookRecord[]>
    upsert(rec: BookRecord): Promise<void>
  }
  sync: {
    // ★ 同步引擎由 Go 侧拥有;前端只订阅事件与推送本地意图
    enqueue(op: SyncOp): Promise<void>
    status(): Promise<SyncStatus>
    onStatus(cb: (s: SyncStatus) => void): () => void
  }
  llm: { translate(req: TranslateReq): Promise<AsyncIterable<string>> }
  system: { platform(): 'windows' | 'darwin' | 'linux' | 'android' | 'ios'; appVersion(): string }
}
~~~

~~~ts
// packages/platform/src/wails.ts —— 唯一允许 import bindings 的文件
import * as App from '../../bindings/hpfreader/services/appservice' // 生成物路径
import { Events } from '@wailsio/runtime'

export const wailsPlatform: Platform = {
  kind: 'wails',
  files: {
    openBook: () => App.OpenBook(),
    saveCover: (id, png) => App.SaveCover(id, png),
  },
  library: { list: (q) => App.ListBooks(q), upsert: (r) => App.UpsertBook(r) },
  sync: {
    enqueue: (op) => App.EnqueueSync(op),
    status: () => App.SyncStatus(),
    // 事件名来自 bindings/events 导出的字符串常量(Wails 官方「前端运行时」页示例)
    onStatus: (cb) => {
      const off = Events.On('sync:status', (e) => cb(e.data as SyncStatus))
      return () => off()
    },
  },
  // ...
}
~~~

~~~ts
// packages/platform/src/web.ts —— Web 目标:同一接口,换成 HTTP / SSE 实现
export const webPlatform: Platform = { kind: 'web' /* fetch + EventSource */ }
~~~

~~~ts
// packages/platform/src/index.ts
import { wailsPlatform } from './wails'
import { webPlatform } from './web'
export const platform: Platform = detectWails() ? wailsPlatform : webPlatform
~~~

**验收规则(建议写进 CI)**:ESLint 禁止 `apps/desktop/frontend/src/**` 与 `packages/*/src/**` import `bindings/**`;**唯一豁免 `packages/platform/src/wails.ts`**。
收益:①Web / PWA 目标零改业务代码即可跑;②Wails 升级爆破面收敛到 1 个文件;③把 `@wailsio/runtime` 这种"只在桌面存在"的运行时依赖挡在门外。

**注入方式**:用 `app.provide(PlatformKey, platform)` + `usePlatform()`,不要直接 import 单例。这样 E2E 可以注入 `testPlatform`(记录调用 + 返回 fixture),无需启动 Go 侧。


## 3. 状态与服务端状态

### 3.1 四类状态的归属(硬性建议)

| 状态类别 | 例子 | 归属 | 理由 |
|---|---|---|---|
| **服务端权威数据** | 书库列表、书籍元数据、云端批注、LLM 任务、账号 | **TanStack Query**(`@tanstack/vue-query` 5.105.2) | 缓存 / 失效 / 重试 / 离线态是它的本职;**不要**手工塞进 Pinia |
| **本地 UI 状态** | 侧栏开合、当前视图模式、选中项、主题偏好 | **Pinia 4.1.0 setup store** | 多组件共享但不需要服务器真相 |
| **同步引擎状态** | `phase`、待推送条数、`lastSyncedAt`、冲突列表、`deviceId` | **独立单例 + 薄响应式适配**(见 3.4) | **明确不建议放进 Query 缓存** |
| **阅读会话状态** | 当前 CFI、分页进度、iframe 内选区 | **`reader-engine` 内部普通变量** + 少量 `shallowRef` 暴露 | 每次翻页 / 滚动都变;进 Pinia 会产生大量无意义依赖触发 |

### 3.2 Pinia:setup stores + 持久化

~~~ts
// features/settings/stores/settings.ts
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useSettingsStore = defineStore('settings', () => {
  const theme = ref<'light' | 'sepia' | 'dark' | 'ink'>('light')
  const fontSize = ref(18)        // px
  const lineHeight = ref(1.6)
  const marginInline = ref(48)    // px
  const fontFamily = ref('serif')
  const columns = ref<1 | 2>(1)
  function setTheme(t: typeof theme.value) { theme.value = t }
  return { theme, fontSize, lineHeight, marginInline, fontFamily, columns, setTheme }
}, {
  persist: {
    key: 'hpf.settings.v1',
    pick: ['theme', 'fontSize', 'lineHeight', 'marginInline', 'fontFamily', 'columns'],
  },
})
~~~

**持久化插件选型**:

| 候选 | 版本(2026-11-02) | 结论 |
|---|---|---|
| `pinia-plugin-persistedstate` | **4.7.1**,peer `pinia >= 3.0.0` | **首选**。对 Pinia 4 兼容;支持 `pick` / `omit` / 自定义 `storage` / `serializer` |
| 手写 `watch(store.$state, ...)` + 自选存储 | — | 备选。仅当要写入 OPFS / IndexedDB 或需要加密时 |
| `@vueuse/core` 的 `useStorage` | 15.0.0 | **不是 store 方案**;适合单个设置项,或作为 persistedstate 的自定义 `storage` 适配器 |

**关键约束**:阅读器里**「阅读进度」绝不能靠 persistedstate 落 localStorage**。
理由:①进度是**同步实体**,真相在本地 DB / 服务端,localStorage 会造成第三份真相;②移动端 WebView 的 localStorage 有配额与回收风险;③多设备冲突时无法合并。
正确做法:进度写入 `platform.sync.enqueue(...)`(由 Go 侧落库 + 同步),Pinia 只缓存"当前会话的阅读位置"这一 UI 镜像。

### 3.3 TanStack Query(Vue 适配)用法要点

- 版本 **5.105.2**,peer `vue ^3.3.0` → 与 Vue 3.5.44 兼容(npm peerDeps 原文,访问日期 2026-11-02)。
- 阅读器场景的 key 设计:

~~~ts
const keys = {
  library: (q: LibraryQuery) => ['library', q] as const,
  book: (id: string) => ['book', id] as const,
  annotations: (bookId: string) => ['annotations', bookId] as const,
  translationJob: (jobId: string) => ['translation', jobId] as const,
}
~~~

- **必须调对的三个开关**:
  - `staleTime`:书库列表 30–60s(本地库不常变);`book` 元数据 `Infinity` + 手动 `invalidateQueries`。
  - `gcTime`(v5 由 `cacheTime` 改名):整本批注这类大对象设短(如 5min),避免内存堆积。
  - `refetchOnWindowFocus`:桌面端建议 **false**(Wails 窗口焦点变化频繁,会产生无谓请求);改为订阅 `platform.sync.onStatus` 后主动 `invalidate`。
- **用 Query 缓存承载同步是明确的反模式**:Query 的策略是"过期后重新拉取",同步队列需要的是"离线可写 + 幂等重放",语义不同。

### 3.4 同步引擎状态放哪(明确建议)

~~~ts
// packages/sync-core/src/engine.ts —— 零框架依赖
export type SyncPhase = 'idle' | 'pulling' | 'pushing' | 'conflict' | 'offline'
export interface SyncState {
  phase: SyncPhase
  pendingCount: number
  lastSyncedAt: number | null
  lastError: { code: string; message: string } | null
  conflicts: ConflictRecord[]        // 待人工裁决
}

export class SyncEngine {
  private state: SyncState = { phase: 'idle', pendingCount: 0, lastSyncedAt: null, lastError: null, conflicts: [] }
  private listeners = new Set<(s: SyncState) => void>()
  getState(): SyncState { return this.state }
  subscribe(fn: (s: SyncState) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  private commit(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch }
    for (const f of this.listeners) f(this.state)
  }
  // enqueue / flush / resolveConflict ...(设计性骨架,非实现)
}
~~~

UI 侧只做**一层薄适配**:

~~~ts
// features/sync/composables/useSyncStatus.ts
import { markRaw, shallowRef, onScopeDispose } from 'vue'

const engine = markRaw(new SyncEngine())          // ★ 绝不让它被 Proxy 包裹

export function useSyncStatus() {
  const state = shallowRef(engine.getState())      // ★ shallowRef:整体替换才触发
  const off = engine.subscribe((next) => { state.value = next })
  onScopeDispose(off)
  return { state, enqueue: engine.enqueue.bind(engine) }
}
~~~

**为什么不用 Pinia 存 SyncEngine 实例**:
1. Pinia 会把 store state 深度 `reactive` → **实例被 Proxy 包裹**,引擎内部的 `Set` / `Map` / `WeakRef` / 定时器句柄会因身份不一致或非法调用出错(与 foliate-js 同类问题,见第 5 节);
2. 同步状态**高频变更**,进响应式 store 会放大重渲染;
3. 引擎真相区应能在**无 Vue 环境下单测**(Vitest node 环境)。

**唯一例外**:需要持久化的 `conflicts` 清单可以**镜像**进一个 Pinia store(纯数据快照,不是实例)。

---

## 4. UI 组件体系与主题

### 4.1 四方案对比(针对"深度换肤 + 浮层"场景)

评分列是**研究员判断**(依据各库官方定位与 API 形态,非实测跑分),已显式标注。

| 维度 | **Reka UI 2.11.0** | shadcn-vue | Naive UI 2.45.3 | Element Plus 2.14.7 |
|---|---|---|---|---|
| 形态 | 无样式原语(headless),WAI-ARIA 优先 | **源码分发**(组件复制进仓库),底层是 Reka UI | 成套组件库,自带设计体系 | 成套组件库(中后台风格) |
| 许可 | MIT | MIT | MIT | MIT |
| Vue 版本要求 | `vue >= 3.4` | 跟随 Reka UI | `vue ^3.0.0` | `vue ^3.3.7` |
| 深度换肤难度(研究员判断) | **易**:样式完全由你写,零覆盖 | **易**:源码在你手里,直接改 | 中:`themeOverrides` + CSS 变量,遇未开放变量要打 `:deep` | **偏难**:BEM 结构 + `--el-*` 变量,深层覆盖易碎 |
| 浮层原语(Popover / Tooltip / Dropdown / ContextMenu / HoverCard) | **完整**,可受控 + 可 teleport + 可自定义锚点 | 同 Reka UI | 有,组件式 API,定制锚点弱 | 有(popper),定制锚点弱 |
| 阅读器"划词气泡"适配 | **最合适**:`Popover.Root / Trigger / Portal / Content` + 虚拟锚点 | 同上(需先拆掉预置样式) | 需自己接定位 | 需自己接定位 |
| 包体(研究员判断) | 小(按需 import 原语) | 小(只复制用到的) | 中 | 大 |
| 中后台组件(表格 / 日期 / 树) | **无**(需自配 TanStack Table 等) | 无 | **齐全** | **齐全** |
| 与 Tailwind 4 协作 | 天然(无样式) | **设计如此** | 需额外桥接 | 需额外桥接 |
| 主要风险 | 纯原语 = 交互细节与测试要自己写 | 组件源码会**分叉**,升级靠重新 `add` + diff | 主题系统与阅读器 CSS 变量并存 = 两套真相 | 同上,且体积 / 风格不符 |

**推荐结论**:

- **首选:Reka UI(无样式原语)+ Tailwind 4 + 自建 `packages/ui`**。
  理由:阅读器的核心诉求是**"把正文排版控制权拿回来"**——主题不是换色,而是改变字距 / 行高 / 分栏 / 边距 / 背景纹理 / 墨水屏模式;有样式的组件库在这条路上每一步都在对抗它的默认设计。浮层(划词气泡、批注卡片、下拉、抽屉)只有无样式原语 + 自定义锚点才能精确对齐 iframe 内选区坐标(见 5.7)。
  **旁证**:`shadcn-vue` 的公开定位即 "for Vue/Nuxt with **Reka UI** components and Tailwind"(检索到的一手项目描述,访问日期 2026-11-02),说明"Reka UI + Tailwind"是社区已验证的组合路径。
- **备选:Naive UI**——当需要在短时间内交付设置面板里的**数据表格 / 日期选择 / 树形控件**等中后台件时,把这部分**局部**用 Naive UI(它有独立 provider 主题注入,可只包住设置区),阅读器主界面仍用 Reka UI + 自研。
- **备选(次):shadcn-vue**——如果团队更看重"开箱即用样式 + 源码可控",可用它生成初始组件再改造;代价是长期维护**分叉**。
- **否决:Element Plus 作为阅读器主组件库**。
  三条理由:①它是中后台设计语言,与沉浸式排版目标不同;②换肤依赖 `--el-*` 变量 + `themeOverrides`,而阅读器需要的"字体 / 分栏 / 纹理 / 墨水屏"属于**结构性主题**,不在它的变量模型里;③包体与样式优先级冲突(容易演变成 `!important` 战)。**这不等于禁止在项目里用 Element Plus**,只是不用它承载阅读器 UI。

### 4.2 Tailwind 4 与阅读器主题变量

Tailwind 4.3.3 采用 **CSS-first 配置**(`@import "tailwindcss"` + `@theme`),不再以 `tailwind.config.js` 为主入口。

~~~css
/* styles/theme.css */
@import "tailwindcss";

/* 1) 语义化 token:UI 层用 Tailwind 工具类消费 */
@theme {
  --color-surface: oklch(98% 0.005 90);
  --color-surface-raised: oklch(100% 0 0);
  --color-text-primary: oklch(24% 0.01 260);
  --color-accent: oklch(62% 0.14 250);
  --radius-card: 0.75rem;
  --font-reading: "Noto Serif CJK SC", "Source Han Serif SC", serif;
  --font-ui: "Inter", system-ui, sans-serif;
}

/* 2) 阅读器专属变量:★ 走普通 CSS 变量,不要塞进 @theme */
/*    因为 @theme 的变量会被 Tailwind 编译期处理,而我们要的是运行时可切换 */
:root {
  --reader-font-family: var(--font-reading);
  --reader-font-size: 18px;
  --reader-line-height: 1.65;
  --reader-letter-spacing: 0.01em;
  --reader-margin-inline: 48px;
  --reader-margin-block: 32px;
  --reader-column-gap: 7%;
  --reader-max-inline-size: 720px;
  --reader-max-column-count: 1;
  --reader-paper: #fbf8f2;
  --reader-ink: #23201c;
  --overlayer-highlight-opacity: 0.3;
  --overlayer-highlight-blend-mode: multiply;
}

/* 3) 主题 = 一组变量覆盖,用 data 属性切换(便于 E2E 断言) */
:root[data-reader-theme="sepia"] { --reader-paper: #f6ecd9; --reader-ink: #4a3b26; }
:root[data-reader-theme="dark"]  { --reader-paper: #14161a; --reader-ink: #d8dce3;
                                   --overlayer-highlight-blend-mode: screen; }
/* 墨水屏:e-ink 要高对比、去动画、去混合模式 */
:root[data-reader-theme="ink"]   { --reader-paper: #ffffff; --reader-ink: #000000;
                                   --overlayer-highlight-opacity: 0.18;
                                   --overlayer-highlight-blend-mode: normal; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
~~~

**四个关键设计点(直接决定成败)**:

1. **正文的真实样式不在你的 CSS 里,而在 iframe 内**。foliate-js 的 paginator 会在每个 section 文档的 `<head>` **首尾各注入一个 `<style>`**(`paginator.js` 源码:`doc.head.prepend($styleBefore)` / `doc.head.append($style)`,并存入 `#styleMap`)。所以主题切换要**同时**做两件事:①改主文档的 CSS 变量;②通过 renderer 的 `setStyles(...)` 把 iframe 内样式重设一遍。**只改主文档 = 正文不跟随主题**,这是最常见的"主题只换了一半"bug。
2. **`--overlayer-highlight-*` 是上游约定的变量名**(源码 `overlayer.js`:`g.style.opacity = 'var(--overlayer-highlight-opacity, .3)'`、`g.style.mixBlendMode = 'var(--overlayer-highlight-blend-mode, normal)'`)。定义它们即可控制全部高亮外观,**不需要改上游代码**。
3. **夜间反转用 `foliate-view::part(filter)`**(上游 README 明确提供 `part="filter"`)。**它只作用于书籍内容,不影响高亮浮层**——正是我们要的语义。
4. **不要把 `--reader-*` 放进 Tailwind 的 `@theme`**,否则运行时 `style.setProperty` 改不动。**UI token 用 `@theme`,阅读器 token 用 `:root` 普通变量,两套,边界清晰。**

### 4.3 组件与浮层落地清单(建议)

| 需求 | 实现 |
|---|---|
| 划词气泡(高亮 / 复制 / 翻译 / 笔记) | `Popover.Root` + 自定义虚拟锚点(见 5.7)+ `Portal` |
| 批注卡片(点击已有高亮弹出) | `HoverCard`(桌面)或 `Popover`(触屏改 click) |
| 顶栏 / 底栏自动隐藏 | `useElementHover` + `useIdle`(VueUse)+ CSS 过渡 |
| 左侧目录抽屉 / 右侧批注抽屉 | 移动端 `Dialog.Root`;桌面端固定侧栏。**同一份内容组件** |
| 设置面板 | `Tabs` + `Slider` + `Select` + `Switch`(Reka UI 原语);复杂表格局部引 Naive UI |
| 键盘导航 / 焦点陷阱 | Reka UI 内置(基于 WAI-ARIA APG);抽屉与弹层**必须**加 `FocusScope` |
| 图标 | `lucide-vue-next` 或 `@iconify/vue`(两包在 npm 上存在,但本报告未逐版核验 → **具体版本未验证**,以安装时 `latest` 为准) |


<!-- ---

## 5. foliate-js 在 Vue 3 里怎么接(本文重点)

> 本节关于 foliate-js 的行为描述均来自上游源码原文(`view.js` / `paginator.js` / `overlayer.js` / `README.md`,访问日期 2026-11-02)。引用为代码片段原文,不是推测。

### 5.0 先记住 foliate-js 的"事实模型"(不记住这些,后面必踩坑)

| 事实 | 源码证据 | 对 Vue 的直接影响 |
|---|---|---|
| 入口是 **custom element `foliate-view`**:必须 createElement + append 后 `await view.open(...)` | README「Basic Usage」 | **不能**在模板里写 `<foliate-view :book="book" />` 并指望 props 驱动;它是命令式 API |
| 内部 `attachShadow({ mode: 'closed' })` | `View` 类字段:`#root = this.attachShadow({ mode: 'closed' })` | Vue 的 scoped style 与 `:deep` **穿不进 closed shadow root**;样式只能靠 `::part()` 或引擎属性 |
| 渲染器是又一个 custom element(`foliate-paginator` / `foliate-fxl`),由 `open()` 动态创建并 append 进自己的 shadow root | `view.js`:`this.renderer = document.createElement('foliate-paginator')`,`this.#root.append(this.renderer)` | 生命周期由引擎管,**Vue 不要接管** |
| **两个 `<style>` 被注入 iframe 内 section 文档的 head 首尾** | `paginator.js`:`doc.head.prepend($styleBefore)` / `doc.head.append($style)` | 主题 / 字体 / 边距必须**双写**(主文档 + 引擎 `setStyles`) |
| iframe sandbox 固定为 **`allow-same-origin allow-scripts`** | `paginator.js`:`this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')`,注释指明是为绕 WebKit bug 218086 | ⚠️ **安全上等同"沙箱没生效"**(见第 14 节 R3);**不能**靠改 sandbox 加固,只能靠 CSP |
| `relocate` 的 `event.detail` 含 `range`(DOM Range)、`index`、`fraction`、`cfi`、`tocItem` | `view.js` `#onRelocate`:`this.lastLocation = { ...progress, tocItem, pageItem, cfi, range }` | **Range 是活对象**,不能进响应式系统,只能存 CFI 字符串 |
| overlayer 的 SVG 由渲染器插入到 **top document 的 shadow root**,并"自动定位 / 缩放" | `paginator.js`:`set overlayer(o) { this.#overlayer = o; this.#element.append(o.element) }`;overlayer.element 默认 `position:absolute; width:100%; height:100%` | overlayer 内坐标 = **iframe 视口坐标**(`Range.getClientRects()` 返回 iframe 视口坐标,而 SVG 与 iframe 尺寸对齐) |
| 高亮用 `Overlayer.add(key, range, draw, options)`,由 `range.getClientRects()` 驱动 | `overlayer.js` | 我们只需提供 `draw`(可用内置 `highlight / underline / squiggly / outline`) |

### 5.1 陷阱一:Vue 的响应式 Proxy 会**真的**弄坏第三方实例

**官方语义(一手)**:

- `ref()`:"If an object is assigned as a ref's value, the object is made **deeply reactive**"(Vue 官方 API 文档 `reactivity-core`)。
- `markRaw()`:"Marks an object so that it will **never be converted to a proxy**. Returns the object itself.";"Some values simply should not be made reactive, for example a **complex 3rd party class instance**"(Vue 官方 API 文档 `reactivity-advanced`)。
- `shallowRef()`:"the inner value of a shallow ref is stored and exposed **as-is**, and will not be made deeply reactive. Only the `.value` access is reactive.";"typically used for ... integration with external state management systems"。
- ⚠️ 官方同时警告 **identity hazard**:`markRaw` 只在**根层**生效——"if you set a nested, non-marked raw object into a reactive object and then access it again, you get the proxied version back ... This can lead to **identity hazards**"。
  来源:`https://raw.githubusercontent.com/vuejs/docs/main/src/api/reactivity-advanced.md`,访问日期 2026-11-02

**具体会怎么炸**(因果链,非猜测):

| 触发方式 | 现象 | 机理 |
|---|---|---|
| `const view = ref(null); view.value = document.createElement('foliate-view')` | 翻页 / 回调随机失效、`next is not a function`、事件 `currentTarget` 不等于 `view.value` | `view.value` 是 **Proxy**,而引擎内部 `this`、`addEventListener` 记录的 `currentTarget`、`view.renderer` 都是原始对象;两边身份不一致 |
| 把 `CustomEvent.detail.range`(DOM Range)放进 `reactive` | `Illegal invocation`、`range.getClientRects is not a function` | DOM API 是**原生方法**,要求 `this` 是真正的平台对象(内部槽),Proxy 不满足 |
| 把 `Overlayer` 实例或 `renderer` 放进 Pinia store | 高亮消失、`redraw()` 无效、内存泄漏 | store 深度 `reactive`;上两条全部命中,且实例被永久驻留无法回收 |
| `shallowRef(view).value.book.toc` 后直接改 `toc[0].label` | UI 不更新 | `shallowRef` 只跟踪 `.value` 替换;深层改动不触发,需 `triggerRef` 或改成不可变替换 |

**反向也要注意**:不是"越少响应式越好"。`relocate` 出来的**进度百分比 / 章节标题**要驱动 UI 重绘,它们应是**原始类型**(number / string),放进 `ref` 完全安全。

### 5.2 三条硬规则与类型声明

~~~ts
// 规则 1:引擎实例(带方法、带内部状态)→ markRaw 后再 shallowRef,或直接放闭包变量
// 规则 2:DOM 节点 → 模板 ref(ref="el")或 shallowRef,永远不要 ref()
// 规则 3:跨边界只传"值"(string / number / plain object),不传 Range / Element / 库实例
~~~

~~~ts
// packages/reader-engine/src/types/foliate.d.ts —— 手写类型(上游无类型)
declare module 'foliate-js/view.js' {
  export interface BookLike {
    sections: Array<{ id: unknown; cfi?: string; linear?: string }>
    toc?: Array<{ label: string; href: string; subitems?: unknown[] }>
    metadata?: Record<string, unknown>
    destroy?(): void
  }
  export interface Annotation { value: string; [k: string]: unknown }

  export class View extends HTMLElement {
    open(book: File | Blob | string | BookLike): Promise<void>
    close(): void
    init(opts?: { lastLocation?: string | number; showTextStart?: boolean }): Promise<void>
    goTo(target: string | number | { fraction: number }): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    getCFI(index: number, range?: Range): string
    addAnnotation(a: Annotation, remove?: boolean): Promise<{ index: number; label: string }>
    deleteAnnotation(a: Annotation): Promise<{ index: number; label: string }>
    resolveNavigation(target: unknown): { index: number; anchor?: unknown } | undefined
    renderer: HTMLElement & {
      setStyles?(styles: unknown): void
      getContents?(): Array<{ index: number; doc: Document }>
      destroy?(): void
    }
    book: BookLike
    lastLocation?: { cfi?: string; fraction?: number; tocItem?: { label?: string } }
    isFixedLayout: boolean
  }
}
~~~

### 5.3 生命周期骨架:composable + 组件(可直接照抄结构)

**参考真实项目 `jinhuan138/vue-book-reader` 的 `BookView.vue`**(Apache-2.0,访问日期 2026-11-02):它把 view 放在 **`let view: FoliateViewElement | null`(闭包普通变量)**,并用 **`loadRequest` 计数器 + `WeakSet`** 处理"快速切书 / 组件卸载时 `open()` 还没结束"的竞态。这是正确做法,我们沿用并补强。

~~~ts
// packages/reader-engine/src/useFoliateEngine.ts
import { onUnmounted, shallowRef, markRaw } from 'vue'
import type { View } from 'foliate-js/view.js'

export interface RelocateDetail {          // ★ 只传值,不传 Range
  index: number; fraction: number; cfi: string
  tocLabel: string; pageItemLabel: string
}
export interface EngineHooks {
  onReady?(v: View): void
  onError?(e: unknown): void
  onRelocate(loc: RelocateDetail): void
  onLoad(doc: Document, index: number): void      // doc 仅用于挂监听,用完即弃
  onExternalLink(href: string): void
  onDrawAnnotation(payload: { draw: (fn: unknown, opts: unknown) => void
                              annotation: unknown; doc: Document; range: Range }): void
}

export function useFoliateEngine(container: () => HTMLElement | null, hooks: EngineHooks) {
  // ★ 实例 markRaw + shallowRef;真正的引用放闭包变量,所有调用都走闭包变量(绕开 Proxy)
  const ready = shallowRef(false)
  let view: View | null = null
  let openSeq = 0
  let disposed = false
  const pending = new WeakSet<View>()

  const onRelocate = (e: Event) => {
    const d = (e as CustomEvent).detail
    hooks.onRelocate({                                  // ★★ 只把值交给 Vue
      index: d.index, fraction: d.fraction, cfi: d.cfi ?? '',
      tocLabel: d.tocItem?.label ?? '', pageItemLabel: d.pageItem?.label ?? '',
    })
  }
  const onLoad = (e: Event) => {
    const { doc, index } = (e as CustomEvent).detail
    hooks.onLoad(doc, index)
  }
  const onExternalLink = (e: Event) => hooks.onExternalLink((e as CustomEvent).detail.href_)
  const onDrawAnnotation = (e: Event) =>
    hooks.onDrawAnnotation((e as CustomEvent).detail)

  function detach(v: View) {
    v.removeEventListener('relocate', onRelocate)
    v.removeEventListener('load', onLoad)
    v.removeEventListener('external-link', onExternalLink)
    v.removeEventListener('draw-annotation', onDrawAnnotation)
  }
  async function destroy(v: View) {
    detach(v)
    try { v.close() } catch (e) { console.warn('[engine] close failed', e) }
    try { v.book?.destroy?.() } catch { /* 未生成首页时 destroy 可能抛错,忽略 */ }
    v.remove()
  }

  async function open(source: File | Blob | string) {
    const seq = ++openSeq
    const old = view
    view = null; ready.value = false
    if (old && !pending.has(old)) await destroy(old)

    const host = container()
    if (!host || disposed) return
    if (!customElements.get('foliate-view')) await import('foliate-js/view.js')
    if (seq !== openSeq || disposed) return

    const v = markRaw(document.createElement('foliate-view') as View)   // ★ 命令式创建
    view = v; pending.add(v); host.appendChild(v)
    v.addEventListener('relocate', onRelocate)
    v.addEventListener('load', onLoad)
    v.addEventListener('external-link', onExternalLink)
    v.addEventListener('draw-annotation', onDrawAnnotation)
    try {
      await v.open(source)
      if (seq !== openSeq || disposed) return
      ready.value = true
      hooks.onReady?.(v)                       // 此时才能安全读 v.book.toc
    } catch (e) {
      console.error('[engine] open failed', e); hooks.onError?.(e)
    } finally {
      pending.delete(v)
      if (view !== v) await destroy(v)          // 已被新的 open 取代
    }
  }

  onUnmounted(() => {
    disposed = true; openSeq++
    const v = view; view = null; ready.value = false
    if (v) void destroy(v)          // ★ detach + close + book.destroy + remove,缺一不可
  })

  // ★ 对外只暴露方法(不暴露实例本身)
  return {
    ready,
    open,
    next: () => view?.next(),
    prev: () => view?.prev(),
    goTo: (t: string | number) => view?.goTo(t),
    getToc: () => view?.book?.toc ?? [],
    setStyles: (styles: unknown) => view?.renderer?.setStyles?.(styles),
    getCFI: (index: number, range: Range) => view?.getCFI(index, range) ?? '',
  }
}
~~~

> ⚠️ 若确实需要在模板里做"等就绪"渲染,用 `ready`(shallowRef 的 boolean),**不要**把 view 本身暴露成响应式。

组件侧(容器必须是**稳定**节点,Vue 不要对它做 diff):

~~~vue
<!-- features/reader/components/ReaderHost.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { useFoliateEngine } from '@hpf/reader-engine'

const host = ref<HTMLElement | null>(null)     // ★ DOM 用模板 ref
const progress = ref(0)                        // ★ 原始值,可安全响应式
const chapter = ref('')
let detachBridge: (() => void) | null = null

const engine = useFoliateEngine(() => host.value, {
  onRelocate: (loc) => {
    progress.value = Math.round(loc.fraction * 1000) / 10
    chapter.value = loc.tocLabel
    // ★ 进度交给同步引擎(节流后);不要写 localStorage
    // sync.enqueue({ kind: 'progress', cfi: loc.cfi, at: Date.now() })
  },
  onLoad: (doc) => {
    detachBridge?.()                            // 先清上一页
    detachBridge = bridgeSectionDocument(doc, {
      onWheel: (dy) => (dy > 0 ? engine.next() : engine.prev()),
      onKey: (e) => handleShortcut(e),
      onSelection: (sel) => (sel ? selection.setFromRange(sel.range, currentIframe(), sel.text)
                                 : selection.anchorRect.value = null),
    })
  },
  onExternalLink: (href) => { /* platform.system.openExternal(href) */ },
  onDrawAnnotation: ({ draw, annotation }) => {
    // draw 是引擎给的画笔,必须在回调内同步使用
    draw((rects: DOMRect[]) => OverlayerRef.highlight(rects, { color: 'var(--hl-yellow)' }), {})
  },
})
defineExpose({ engine })
</script>

<template>
  <!-- ★ 单节点、无 v-if/v-for 干扰、尺寸稳定 -->
  <div ref="host" class="reader-host" />
</template>

<style scoped>
.reader-host { position: relative; inline-size: 100%; block-size: 100%;
               min-inline-size: 1px; min-block-size: 1px; }
</style>
~~~

**"尺寸塌陷"是第二高频坑**:paginator 内部有 `#observer = new ResizeObserver(() => this.expand())`(`paginator.js` 原文)。若容器在 `open()` 期间高度为 0(常见于 `display:none` 的标签页、或 flex 子项没给 `min-height: 0`),会算出 0 页 / 白屏。对策:①容器用 `absolute inset-0` 或明确 `block-size`;②隐藏阅读区用 **`v-show` 而不是 `v-if`**——`vue-book-reader` 的 `initReader` 里也有对应注释:"保留 v-show,等待容器恢复尺寸后再排版"。

### 5.4 事件桥接:iframe 内的用户输入怎么进 Vue

foliate-js 只在**主文档**派发 `relocate` / `load` / `link` / `external-link` / `create-overlayer` / `draw-annotation` 等自定义事件(`view.js` 的 `#emit`)。**iframe 内的 wheel / touch / key / selection 不会自动冒泡到主文档**——必须自己桥接。

**参考实现的做法与原话**(`vue-book-reader/src/packages/BookView/BookView.vue`,访问日期 2026-11-02):

~~~ts
const onLoad = (e: Event) => {
  const { doc } = (e as CustomEvent).detail
  // Fixed-layout books (including CBZ) can display two iframe documents at
  // once. Keep listeners for every connected page in the current spread.
  cleanupDocListeners(doc)
  docListenerCleanups.set(doc, [
    wheelListener(doc, flipPage),
    swipListener(doc, flipPage),
    keyListener(doc, flipPage),
  ])
}
onMounted(() => {
  // Fixed-layout pages are replaced while navigating. Listen on the stable
  // outer document as well, so keyboard navigation survives iframe removal.
  cleanupRootKeyListener = keyListener(document, flipPage)
})
~~~

**我们的封装**:

~~~ts
// packages/reader-engine/src/iframeBridge.ts
export interface BridgeHandlers {
  onWheel(deltaY: number): void
  onKey(e: KeyboardEvent): void
  onSelection(sel: { text: string; range: Range } | null): void
}

export function bridgeSectionDocument(doc: Document, h: BridgeHandlers): () => void {
  const win = doc.defaultView
  if (!win) return () => {}
  const ac = new AbortController()
  const { signal } = ac

  // 1) wheel:分页模式下 wheel 不滚动文档,而是翻页(阈值 + 去抖)
  let acc = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  doc.addEventListener('wheel', (e) => {
    acc += e.deltaY
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { if (Math.abs(acc) >= 750) h.onWheel(acc); acc = 0 }, 50)
  }, { signal, passive: true })

  // 2) key:焦点在 iframe 文档里时,主文档收不到 keydown
  doc.addEventListener('keydown', (e) => h.onKey(e), { signal })

  // 3) selection:★ 必须用 iframe 自己的 selectionchange(主文档的看不到 iframe 选区)
  doc.addEventListener('selectionchange', () => {
    const sel = win.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return h.onSelection(null)
    const text = sel.toString().trim()
    if (!text) return h.onSelection(null)
    h.onSelection({ text, range: sel.getRangeAt(0).cloneRange() })   // ★ cloneRange 跨帧持有才安全
  }, { signal })

  return () => { if (timer) clearTimeout(timer); ac.abort() }
}
~~~

**桥梁的三条纪律**:

1. **只在 `load` 事件里挂监听,并在下一次 `load` / 组件卸载时清理**。固定版式(CBZ 与 fixed-layout EPUB)会**同时存在两个** iframe,清理要按"doc 是否仍连接"判断(参考实现用 `listenerDoc.defaultView?.frameElement?.isConnected`)。
2. **主文档也要挂一份键盘监听**:iframe 被替换的瞬间焦点会丢,只挂 iframe 会导致"翻页快捷键偶尔失灵"。
3. **选区必须 `cloneRange()` 后再交给 Vue 状态**;直接用 `sel.getRangeAt(0)` 会在下次选择时被浏览器改写(活对象陷阱,同 5.1)。

### 5.5 划词浮层的坐标系换算(最易出错,逐项推演)

**三个坐标空间**:

| 空间 | 原点 | 谁返回这种坐标 |
|---|---|---|
| A. iframe **视口**坐标 | iframe 内容盒左上角 | **在 iframe 文档里**调用 `Range.getClientRects()` / `getBoundingClientRect()` |
| B. 主文档**视口**坐标 | 主窗口左上角 | 在主文档里调用 `getBoundingClientRect()`(`position: fixed` 用它) |
| C. 主文档**页面**坐标 | 主文档左上角(含滚动) | B + `window.scrollX / scrollY`(`position: absolute` 用它) |

**换算公式**:

~~~txt
B.left = iframeRect.left + rangeRect.left      // rangeRect 来自空间 A
B.top  = iframeRect.top  + rangeRect.top
// 浮层若用 position: absolute(相对主文档):
C.left = B.left + window.scrollX
C.top  = B.top  + window.scrollY
~~~

~~~ts
// packages/reader-engine/src/coords.ts
/** iframe 内容盒在"主文档视口"中的矩形(扣掉 border 与 padding) */
export function iframeContentRect(iframe: HTMLIFrameElement): DOMRect {
  const r = iframe.getBoundingClientRect()
  const cs = getComputedStyle(iframe)
  const px = (v: string) => Number.parseFloat(v) || 0
  const l = px(cs.borderLeftWidth) + px(cs.paddingLeft)
  const t = px(cs.borderTopWidth) + px(cs.paddingTop)
  return new DOMRect(
    r.left + l, r.top + t,
    r.width - l - px(cs.borderRightWidth) - px(cs.paddingRight),
    r.height - t - px(cs.borderBottomWidth) - px(cs.paddingBottom),
  )
}

/** A → B:iframe 视口坐标 → 主文档视口坐标(position: fixed 浮层用) */
export function toViewportRect(rangeRect: DOMRect, iframe: HTMLIFrameElement): DOMRect {
  const base = iframeContentRect(iframe)
  return new DOMRect(base.left + rangeRect.left, base.top + rangeRect.top,
                     rangeRect.width, rangeRect.height)
}

/** 该 rect 是否真的落在 iframe 可见区域内 */
export function isVisibleInIframe(r: DOMRect, iframe: HTMLIFrameElement): boolean {
  return r.bottom > 0 && r.top < iframe.clientHeight
      && r.right > 0 && r.left < iframe.clientWidth
}
~~~

**⚠️ 分页模式(多列)下的一个大坑**:paginator 用 **CSS 多列**(上游 README:"it uses CSS multi-column ... it shares much of the same limitations (it's slow, some CSS styles do not work as expected, and other bugs)")。多列布局下,一个 `Range` 的 `getClientRects()` 会返回**跨列的多段矩形**,其中可能包含**当前不可见列**的矩形(坐标会是很大的负数或超出视口):
- **计算气泡锚点前必须过滤**(用 `isVisibleInIframe`),否则气泡会飘到屏幕外;
- 高亮绘制不受影响(overlayer 会画全部列),**只有"瞄准点"要选可见 rect**。

~~~ts
// features/reader/composables/useSelectionAnchor.ts
import { shallowRef } from 'vue'
import { toViewportRect, isVisibleInIframe } from '@hpf/reader-engine/coords'

export function useSelectionAnchor() {
  const anchorRect = shallowRef<DOMRect | null>(null)   // ★ DOMRect 是原生对象,不能用 reactive
  const selectedText = shallowRef('')

  function setFromRange(range: Range, iframe: HTMLIFrameElement, text: string) {
    const rects = Array.from(range.getClientRects()).filter((r) => isVisibleInIframe(r, iframe))
    if (!rects.length) { anchorRect.value = null; return }
    // 取"最后一行"作为锚点(气泡贴近选区末尾更符合直觉)
    const last = rects.reduce((a, b) =>
      b.bottom > a.bottom || (b.bottom === a.bottom && b.right > a.right) ? b : a)
    anchorRect.value = toViewportRect(last, iframe)
    selectedText.value = text
  }
  return { anchorRect, selectedText, setFromRange }
}
~~~

**浮层实现:首选 vs 保底**

~~~vue
<!-- 保底方案(推荐先落地):@floating-ui/vue 的虚拟元素 -->
<script setup lang="ts">
import { computed } from 'vue'
import { useFloating, offset, flip, shift } from '@floating-ui/vue'

const props = defineProps<{ rect: DOMRect | null; text: string }>()

// 虚拟元素:只要有 getBoundingClientRect 就能当锚点 —— 这是 Floating UI 的公开能力
const virtualReference = computed(() => props.rect && ({
  getBoundingClientRect: () => props.rect as DOMRect,
}))
const { floatingStyles } = useFloating(virtualReference, /* floating el ref */ null, {
  placement: 'top', middleware: [offset(8), flip(), shift({ padding: 8 })],
})
</script>
~~~

- **首选**:Reka UI 的 `Popover` 组合原语 + 虚拟锚点(样式与焦点管理与项目一致)。
- **保底 / 立即可用**:直接用 `@floating-ui/vue@2.0.1` 的 `useFloating` + 虚拟 reference 自己写 30 行浮层。
- ⚠️ **诚实标注**:我**没有**对 Reka UI"虚拟锚点"的确切属性名做一手核验(其文档页本次未逐字抓取)→ **「Reka UI 虚拟锚点 API 名」标为「未验证」**。**因此建议先按 Floating UI 保底方案实现,再评估是否替换为 Reka UI 封装。**

### 5.6 高亮链路:用上游 API,不要自己造

~~~ts
// 上游 provide 的绘制原语(overlayer.js 静态方法):
//   Overlayer.highlight(rects, { color })                     —— 最常用
//   Overlayer.underline(rects, { color, width, writingMode })
//   Overlayer.strikethrough(rects, { color, width, writingMode })
//   Overlayer.squiggly(rects, { color, width, writingMode })
//   Overlayer.outline(rects, { color, width, radius })
//   underline / strikethrough / squiggly 会读 options.writingMode 正确处理竖排(vrl / vlr)

// ✅ 推荐:让引擎自己管 overlay 生命周期
await view.addAnnotation({ value: cfi, color: 'var(--hl-yellow)' })
//   addAnnotation 内部:resolveNavigation(cfi) → #getOverlayer(index) → emit('draw-annotation')
//   我们在 draw-annotation 回调里同步调用 draw(...)
await view.deleteAnnotation({ value: cfi })

// ❌ 不要:自己往 iframe 里插 <span> 做高亮
//   原因 ①CFI 树遍历会被你的节点污染(上游 README 专门提到 CFI 支持 "ignore nodes" 过滤器,
//        说明这是已知问题);②换页 / 重排会丢;③overlayer 已有 --overlayer-highlight-* 变量可主题化
~~~

### 5.7 本节"照做清单"(按顺序执行即可落地)

1. 用 **git submodule** 引入 `foliate-js` 到自己 fork;pnpm 用 `link:` 引用;**不装 npm 上的 `foliate-js`**。
2. 给 fork 打 **Vite 兼容补丁**:核心是 `pdf.js` 里 `fetchText(pdfjsPath('text_layer_builder.css'))` 改为 `?inline` 导入,以及 `paginator.js` 里 `.then(data => data.replace(...))` 前加 `typeof data === 'string'` 守卫。**这两个补丁在 `jinhuan138/vue-book-reader` 的 `scripts/fix-foliate.mjs` 里有完整实现可直接参考**(Apache-2.0,访问日期 2026-11-02)。
3. 写 `foliate.d.ts`(5.2);**不要**开 `allowJs` 去类型检查上游源码。
4. 实现 `useFoliateEngine`(5.3):**实例一律不进 `ref`**。
5. 实现 `bridgeSectionDocument`(5.4):在 `load` 里挂,换页 / 卸载时清。
6. 实现坐标工具(5.5):**过滤不可见 rect**。
7. 浮层先用 `@floating-ui/vue` 虚拟元素打通,再评估 Reka UI 封装。
8. 高亮走 `view.addAnnotation` + `Overlayer.*`;主题用 `--overlayer-highlight-*` 变量。
9. 主题切换**双写**:主文档 CSS 变量 + `renderer.setStyles(...)`(见 4.2)。
10. 加 Playwright 冒烟:打开测试 EPUB → 断言进度变化 → 划词 → 断言气泡出现且坐标在视口内。

---

## 6. PDF:pdf.js 在 Vue 里的封装要点

**选型**:上游 foliate-js 自带一个 PDF 适配器,但上游 README 明确说它只是 **"proof-of-concept, highly experimental adapter for PDF.js"**;`view.js` 里走 `const { makePDF } = await import('./pdf.js')`。因此建议:**EPUB/MOBI/AZW3/FB2/CBZ 走 foliate-js;PDF 走自研的 pdf.js 封装**(两条渲染通路,但共用同一套"位置/进度/批注"数据模型)。

| 议题 | 结论 | 依据 / 注意 |
|---|---|---|
| 库 | `pdfjs-dist` **6.5.438**(Apache-2.0),engines `>=22.13.0` | npm 元数据,访问日期 2026-11-02 |
| worker | 必须显式配 worker(`GlobalWorkerOptions.workerSrc`),否则主线程渲染卡死 | pdf.js 标准用法 |
| canvas | 每页一个 `<canvas>`;**devicePixelRatio 感知**:`canvas.width = viewport.width * dpr`、CSS 尺寸用 viewport,`ctx.scale(dpr, dpr)` | 否则高分屏发虚 |
| 文本层 | `page.getTextContent()` + 文本层容器绝对定位在 canvas 之上,**用于选择 / 复制 / 划词** | 若不渲染文本层,则"划词翻译 / 高亮"在 PDF 上完全不可用 |
| 文本层样式 | 必须引入官方 `pdf_viewer.css`(或等价样式),否则选区的 `transform` 定位与 `::selection` 会错乱 | 这是接文本层最常见的坑 |
| 折叠 / 分页卸载 | 只挂载「当前可视页 ±2 页」;离开窗口后 **销毁 canvas 与文本层 DOM**,并 `page.cleanup()` | 大文件(数百页)全量挂载必然 OOM |
| 内存 | 卸载文档时 `pdfDoc.destroy()` 并清引用;`PDFDocumentProxy` 与 `PDFPageProxy` **不要放假进响应式对象** | 同类 Proxy 陷阱(第 5.1 节) |
| 渲染取消 | 用户快速滚动/翻页时,用 `renderTask.cancel()` 取消上一帧,避免"越滚越慢" | 必须处理 `RenderingCancelledException` |
| 缩放 | 用 `page.getViewport({ scale })`;**缩放 = 重新渲染全部可见页**,不要把 canvas 用 CSS 拉伸 | CSS 拉伸会让文本层与画布失配 |
| 大文件首屏 | 先只 `getPage(1)` 拿 viewport 估算总高度,再做虚拟滚动;不要一开始 `getPage` 全部页 | 总页数用 `pdfDoc.numPages` |
| 扫描件 OCR | 不在前端做;走服务端(见 30 号文档结论) | 跨文档一致性 |

~~~ts
// packages/reader-engine/src/pdf/usePdfPage.ts(设计性骨架)
import { shallowRef, onUnmounted } from 'vue'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'

export function usePdfPage(doc: PDFDocumentProxy, canvasHost: () => HTMLCanvasElement | null) {
  const current = shallowRef<RenderTask | null>(null)
  const dpr = window.devicePixelRatio || 1

  async function render(pageNo: number, scale: number) {
    current.value?.cancel()                       // ★ 取消上一帧
    const page = await doc.getPage(pageNo)
    const viewport = page.getViewport({ scale })
    const canvas = canvasHost()
    if (!canvas) return
    canvas.width = Math.floor(viewport.width * dpr)      // ★ 物理像素
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = viewport.width + 'px'            // ★ CSS 像素
    canvas.style.height = viewport.height + 'px'
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)                // 等价于 ctx.scale(dpr, dpr)
    const task = page.render({ canvasContext: ctx, viewport })
    current.value = task
    try { await task.promise } catch (e) { /* 取消异常忽略 */ }
  }

  async function unload(pageNo: number) {
    const page = await doc.getPage(pageNo)
    page.cleanup()                                        // ★ 释放该页位图缓存
  }

  onUnmounted(() => { current.value?.cancel(); void doc.destroy() })
  return { render, unload }
}
~~~

**PDF 与 foliate-js 的统一抽象**:两者都产出「位置」。EPUB 用 **CFI**,PDF 用 `{ page, xPercent, yPercent }`。建议在 `shared` 里定义 `Locator` 联合类型(对齐 Readium Locator 的思路),同步引擎只认 `Locator`,不认具体格式 —— 这样"换格式不改同步层"。

---

## 7. 长列表与虚拟滚动

| 候选 | 版本(2026-11-02) | 适用 | 结论 |
|---|---|---|---|
| `@tanstack/vue-virtual` | **3.13.51**(MIT) | 书库网格、目录树、批注列表、搜索结果 —— **一套 hook 覆盖全部** | **首选**。headless、可控性最强、与 Vue 3 兼容;需要自己写 markup |
| `vue-virtual-scroller` | **3.0.5**(MIT) | 简单线性列表/树,开箱即用 | **备选**。组件化、上手快;定制网格/动态高度不如前者 |
| 自研 | — | 只有在"虚拟化 + 固定列宽网格 + 封面懒加载"三者耦合到 TanStack 难以表达时 | **暂不推荐**:现在自研的维护成本高于收益 |

**书库网格(数千本)的关键参数与坑**:

- **必须给滚动容器一个确定高度**(或 `flex-1 min-h-0`)。没有可计算的可滚动区域,虚拟化会直接"看起来没生效"。
- 用 `estimateSize` 给**行高**,用 `measureElement` + 动态测量处理"标题换行导致行高不一"的书卡片;**只给 estimateSize 不测量会导致滚动条长度正确但内容错位**。
- 网格用"行虚拟化 + 行内多列"(`columns` 由容器宽度算出),不要做二维虚拟化。
- `overscan` 取 5–10;移动端可降到 3–5 省内存。
- **封面懒加载**:优先用 `useIntersectionObserver`(VueUse)触发加载,并用**固定宽高比的占位块**(如 `aspect-ratio: 2 / 3`)避免滚动跳动;封面走 platform 提供的缩略图路径(或 Web 端 `?w=200` 缩略接口),**不要**在列表里直接解码原图。
- 封面解码建议加 `img.decoding = 'async'` + `loading = 'lazy'`;虚拟化已经控制了节点数,这两个是额外保险。
- **目录树**:EPUB 的 `toc` 是**嵌套结构**(`subitems`)。虚拟化前必须**扁平化成带 `depth` 的行数组**,否则虚拟化无从下手。折叠/展开只改扁平数组,不重建引擎。

---

## 8. 响应式与横竖屏

### 8.1 VueUse 15 的组合用法(函数名已核验存在于 `@vueuse/core@15.0.0`)

| 需求 | 用哪个 | 说明 |
|---|---|---|
| 断点(宽/窄、横/竖) | `useMediaQuery` / `useBreakpoints` | `useMediaQuery('(orientation: landscape)')` 是最稳的横竖屏判断 |
| 设备方向 API | `useScreenOrientation` | ⚠️ **VueUse 里叫 `useScreenOrientation`,不是 `useOrientation`**(后者在同版本 bundle 中不存在)。它基于 `ScreenOrientation` API,**移动端可能返回 `undefined`**,不要作为唯一判据 |
| 容器尺寸 | `useElementSize` / `useResizeObserver` | 阅读区自适应**必须用容器尺寸**,不能只看视口 |
| 持久化设置 | `useStorage` | 用于非同步实体(如"上次打开的书");**不要**用于阅读进度 |
| 滚动位置 | `useScroll` | 滚动模式下的进度显示 |
| 图片懒加载 | `useIntersectionObserver` | 封面 |
| 用户闲置(自动隐藏工具栏) | `useIdle` | 桌面端 |
| 主色调 / 深色 | `usePreferredDark` / `useColorMode` | 与 `:root[data-reader-theme]` 配合 |

**核验方法说明**:以上函数名是通过下载 `@vueuse/core@15.0.0` 的 IIFE bundle(308,796 字节)并逐一 `String.contains` 验证的(访问日期 2026-11-02);未出现的名字(如 `useOrientation`)已确认**在当前版本中不存在**。

### 8.2 "可用宽度 + 触控 + 宽高比"三要素布局策略

| 判据 | 变量 | 用途 |
|---|---|---|
| 可用宽度 | `useElementSize(readerHost).width` | 决定**分栏数**与**最大行宽** |
| 触控能力 | `useMediaQuery('(pointer: coarse)')` | 决定**点击区域大小**、手势翻页是否开启、是否显示浮动工具栏 |
| 宽高比 / 方向 | `useMediaQuery('(orientation: landscape)')` 或容器 `aspect-ratio` | 决定**双栏 vs 单栏**、工具栏放侧边还是底部 |

映射建议(研究员判断):

| 条件 | 列数 | 边距 | 交互 |
|---|---|---|---|
| 宽 ≥ 1100px 且横屏 | 2 | 大 | 键盘 + 鼠标;工具栏常驻可自动隐藏 |
| 600–1100px | 1(限最大行宽 ~720px) | 中 | 键盘 + 触控 |
| 宽 < 600px 或 `pointer: coarse` | 1 | 小 | 手势翻页;工具栏底部 |

**CSS 容器查询是关键**:阅读区宽度由**布局(有无侧栏)**决定,不由视口决定。所以:
- 给阅读容器 `container-type: inline-size`(上游 paginator 自己也用 `container-type: size`,`paginator.js` 的 `:host { display:block; container-type: size; }`);
- 在内部用 `@container (min-width: 700px) { ... }` 切换双栏/边距;
- **JS 侧只用 `useElementSize` 读一个数字**给 foliate 的 `max-column-count` 属性,`gap` / `margin` / `max-inline-size` 也走**属性驱动**(上游明确:"there's no JS property API. You must use `.setAttribute()`")。

~~~ts
// 上游 paginator 支持的布局属性(README 原文):
//   flow = paginated | scrolled
//   margin / gap / max-inline-size / max-block-size / max-column-count
//   animated(布尔属性)
// ★ 必须用 setAttribute,没有 JS 属性 API
function applyLayout(renderer: HTMLElement, l: Layout) {
  renderer.setAttribute('flow', l.flow)                       // 'paginated' | 'scrolled'
  renderer.setAttribute('max-column-count', String(l.columns))
  renderer.setAttribute('max-inline-size', l.maxInlineSize + 'px')  // 单位必须是 px
  renderer.setAttribute('gap', l.gapPercent + '%')                  // 单位必须是 %
  renderer.setAttribute('margin', l.marginPx + 'px')                // 单位必须是 px
}
~~~


---

## 9. PWA 兜底(移动端改走 PWA 的可行性)

### 9.1 配置要点(`vite-plugin-pwa@2.0.0`,peer 已支持 `vite ^8.0.0`)

~~~ts
// apps/desktop/frontend/vite.config.ts(Web/PWA 构建时启用)
import { VitePWA } from 'vite-plugin-pwa'

VitePWA({
  registerType: 'prompt',            // 阅读器建议 prompt:升级时不能打断正在读的页
  injectRegister: 'auto',
  workbox: {
    globPatterns: ['**/*.{js,css,html,woff2,wasm}'],
    // ★ 单文件上限:pdf.js 的 worker 与 sqlite wasm 都偏大
    maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/api\//, /^\/wails\//],   // ★ 别让 SW 劫持接口与 Wails 运行时
    runtimeCaching: [
      { // 书籍文件:大、不常变 → CacheFirst + 长 TTL(或干脆交给本地 DB / OPFS)
        urlPattern: ({ url }) => url.pathname.startsWith('/books/'),
        handler: 'CacheFirst',
        options: { cacheName: 'hpf-books', expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 180 } },
      },
      { // API:必须走网络,失败要能感知 → NetworkOnly 或 NetworkFirst(短超时)
        urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
        handler: 'NetworkOnly',
      },
    ],
  },
  manifest: {
    name: 'HPF Reader', short_name: 'HPF',
    display: 'standalone', orientation: 'any',
    theme_color: '#fbf8f2', background_color: '#fbf8f2',
    icons: [/* 192 / 512 / maskable 512 —— 缺 maskable 安卓会显示白边 */],
  },
})
~~~

**要点**:
1. `registerType` 用 `prompt` 而不是 `autoUpdate`:阅读器**不能在用户读到一半时热替换**。用 `virtual:pwa-register` 的 `onNeedRefresh` 弹"有新版本,读完这章再更新"。
2. `navigateFallbackDenylist` 必须排除 `/api/`(避免 SW 把接口请求回落到 HTML)以及 Wails 相关路径。
3. `maximumFileSizeToCacheInBytes` 默认 2MB,**pdf.js worker 与 sqlite wasm 都会被漏掉** —— 必须显式放大,否则"离线可用"只是幻觉。
4. 书籍文件**不建议全量进 Cache Storage**(配额与淘汰不可控):正文与元数据进本地 DB,原文件按需缓存或用户主动"离线下载"。

### 9.2 与本地 SQLite(WASM)共存:必须做一次架构选择

SQLite 官方 wasm 文档(`https://sqlite.org/wasm/doc/trunk/persistence.md`,访问日期 2026-11-02)给出的一手事实:

| 事实(原文要点) | 含义 |
|---|---|
| "OPFS is only available in **Worker-thread contexts**, not the main UI thread." | DB 必须跑在 Worker 里 |
| "JavaScript's `SharedArrayBuffer` type is required for the OPFS VFS, and that class is only available if the web server includes the so-called COOP and COEP response headers":`Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin`;COEP 也可用 `credentialless` | 用 `opfs` VFS ⇒ 站点必须**跨源隔离** |
| `opfs-sahpool`(SyncAccessHandle Pool)的优点:"Does **not require COOP/COEP** HTTP headers (and associated restrictions)";"Easily the highest OPFS performance";"Should work on all major browsers released since March 2023" | 用 `opfs-sahpool` **可绕开 COOP/COEP** |
| `opfs-sahpool` 的缺点:"Does **not support multiple simultaneous connections** to the same database"(初始化两次会失败,第二次起的 tab 打不开);"No filesystem transparency";需 `await sqlite3.installOpfsSAHPoolVfs()` 显式启用 | **多标签页会互相锁死**,必须做单实例/主从选举或降级 |
| "the `opfs-sahpool` **wipes the storage automatically if initialization of the storage fails**"(3.54 起可选但仍默认开启) | ⚠️ **有静默清库风险,必须做持久化护栏** |
| "Mysterious Disappearance of Databases":病毒扫描器 / 清理软件 / 浏览器存储权限 / 浏览器自行清理 | 浏览器端存储**不可当作唯一真相** |
| `opfs` / `opfs-wl` 才支持多标签并发,但要 COOP/COEP 且要处理 `SQLITE_BUSY` | 复杂度换能力 |

**推荐(明确结论)**:

1. **默认用 `opfs-sahpool`**(不需要 COOP/COEP)。理由:①避免 COOP/COEP 带来的连锁副作用(所有跨源资源都要带 CORP 头 / 或 `credentialless`);②性能最好;③浏览器覆盖已足够(2023-03 之后的主流版本)。
2. 用 **Web Locks**(或 `BroadcastChannel`)做主实例选举:只有 leader tab 打开 DB,其余 tab 通过 `MessageChannel` 走 RPC。这样规避"第二个 tab 初始化失败"。
3. **必须加持久化护栏**(因为 SAHPool 可能清库 + 浏览器可能清存储):
   - 每 N 分钟 / 每次关页 把变更**导出**到 IndexedDB(或直接推服务端);
   - 记录 `schemaVersion` 与 `lastExportedAt`,启动时校验;
   - UI 上明确"本地数据已上云/未上云"状态,不让用户误以为一定安全。
4. **若走桌面端(Wails)**:本地 DB 由 **Go 侧**持有(见 40/60 号文档),前端根本不碰 WASM SQLite。**只有 Web/PWA 目标才需要上面这套**。

### 9.3 Service Worker 与 SQLite WASM 共存的注意点

| 风险 | 说明 | 对策 |
|---|---|---|
| WASM 被 SW 缓存成旧版本 | `sqlite3.wasm` 文件名若不含 hash,SW 会一直返回旧二进制,与 JS 胶水不匹配 | `globPatterns` 覆盖 `.wasm` 并用 `precacheAndRoute`;或用 `revision` 显式指定;**构建产物必须带 hash 文件名** |
| `navigateFallback` 劫持 PDF/WASM 请求 | Workbox 默认会把未命中路由回落到 `index.html`,导致 `WebAssembly.instantiate` 拿到 HTML 而报 "magic word" 错误 | `navigateFallbackDenylist` 加 `/\.wasm$/`、`/\.pdf$/` |
| 跨源隔离与 SW 的交互 | 若选用 `opfs` VFS,COOP/COEP 必须由**服务器**下发;SW 自己合成响应头容易漏 | 用 SAHPool 绕开;或用服务端(Go 侧)统一下发头 |
| 更新时机 | 新 SW 激活会清旧缓存,若同时正在写 DB 容易中断 | `registerType: 'prompt'` + `skipWaiting: false`,由用户确认后再 `updateSW()` |

---

## 10. i18n / 无障碍 / 手势 / 快捷键

### 10.1 vue-i18n 11.4.17 最佳实践

| 实践 | 说明 |
|---|---|
| **按 feature 拆语言包** | `locales/zh-CN/reader.json`、`library.json`… 由 `packages/i18n` 汇总;避免单文件上千行 |
| **构建期编译** | 用 `@intlify/unplugin-vue-i18n@11.2.8` 做预编译,运行时只带 `vue-i18n.runtime`,显著减小包体 |
| **禁用 fallback 地狱** | `fallbackWarn: false` + CI 脚本比对 key 集合(缺 key 直接失败) |
| **<script setup> 用法** | `const { t, d, n } = useI18n()`;不要在 composable 里全局 import `i18n.global`(会丢响应式 locale) |
| 日期 / 数字 / 相对时间 | 用 `d()` / `n()`,不要手写格式化 |
| **书籍内容本身不翻译** | 书籍语言与 UI 语言是两件事;EPUB 的 `doc.documentElement.lang` 由 foliate 的 `#onLoad` 自动设置(`view.js`:`doc.documentElement.lang ||= this.language.canonical ?? ''`) |
| 简体/繁体 | 阅读器常见需求;**同一个 locale 的不同脚本**建议用构建期转换(参考 `readest` 用 WASM 简繁转换包),不要维护两份完整译文 → 具体库本次未核验 |
| LLM 术语表 | 用户级"术语/人名对照表"放进 i18n 之外的独立存储(它是数据,不是 UI 文案) |

### 10.2 无障碍与键盘

| 项 | 做法 |
|---|---|
| 语义结构 | 主区域 `<main>`、工具栏 `role="toolbar"`、侧栏 `<aside aria-label>`;抽屉用 Reka UI `Dialog`(自带 `aria-modal` / focus trap) |
| 焦点管理 | 打开抽屉/弹层用 `FocusScope`;`Esc` 关闭;**关闭后焦点必须回到触发元素** |
| 键盘可达 | 所有功能都要有键盘路径;"翻页"必须同时支持 `←/→`、`PageUp/PageDown`、`Space`(并且**在 input 聚焦时不拦截**) |
| 屏幕阅读器 | 进度变化通过 `aria-live="polite"` 播报(节流,别每帧播);**注意 iframe 内的正文对 AT 是可读的**,但主文档与 iframe 是两个可访问树 —— 需要在切换页时把焦点显式移到 iframe 文档(或提供"跳到正文"链接) |
| 对比度 | 所有主题(含 sepia / ink)都要过 WCAG **AA**;**墨水屏模式的目标是 AAA 级别的正文对比** |
| 动效 | `prefers-reduced-motion` 必须生效(见 4.2 的 CSS) |
| 字号 | 支持"跟随系统字号"(`rem` 基准)与"独立放大正文"(只放大阅读区)两种语义 |
| (WCAG 版本) | 本报告**未**核验 WCAG 当前最新推荐版本号(2.2 之后的状态)→ **「未验证」**,验收时以官方当前版本为准 |

### 10.3 触摸手势与快捷键

| 需求 | 首选 | 说明 |
|---|---|---|
| 左右滑动翻页 | **自研 `touchstart/touchend` 阈值判断** | 逻辑极简(位移 + 时间 + 垂直容差);`vue-book-reader` 的 `swip.ts` 就是 50px / 500ms / 200px 三参数(参考实现,Apache-2.0)。**引库反而增加体积与事件冲突面** |
| 捏合缩放(PDF) | 自研(CSS transform + 双指距离)或浏览器原生缩放 | 缩放语义复杂,不建议交给通用手势库 |
| `@vueuse/gesture` | **备选,不首选** | 该包在 npm 上存在(最新 **2.0.0**),但它默认依赖 `@use-gesture/vanilla` 生态与自己的坐标状态模型,与"阅读器要精确控制翻页节流"的目标不完全契合;**并且它需要维护者在 Vue3 上的持续适配**(本次未核验其维护活跃度 → **「未验证」**) |
| 长按选词 | 用浏览器原生选择(不要自己实现) | 自己实现的选择模型会破坏 CFI 与无障碍 |
| 双击缩放 | 自研(双击 = 在"当前列宽"与"整页宽"之间切换) | — |
| 桌面快捷键 | **自研一个 `useShortcuts` 表格** + 用户可自定义 | 键位表建议:翻页 `←/→/Space/PageUp/PageDown`;章节 `[ ]`;目录 `t`;搜索 `Ctrl/Cmd+F`;高亮 `h`;翻译 `Ctrl/Cmd+T`;主题 `Ctrl/Cmd+Shift+L`;全屏 `F11` |
| 快捷键的坑 | ①在 `input/textarea/contenteditable` 聚焦时**必须放行**;②**必须同时处理主文档与 iframe 文档**;③macOS 用 `Cmd`、Win/Linux 用 `Ctrl`;④快捷键要能"启用/禁用"(部分用户用屏幕阅读器时会被劫持) | 参考实现里 `keyListener(document, ...)` 同时挂主文档与 section 文档,正是这个原因 |

---

## 11. 测试策略

| 层 | 工具 | 测什么 | 不测什么 |
|---|---|---|---|
| 纯逻辑 | **Vitest 5.0.5**(node 环境) | `sync-core`(合并/幂等/冲突)、CFI ↔ Locator 转换、进度计算、快捷键解析、i18n key 完整性 | — |
| 组件 | **Vitest + `@vue/test-utils` 2.5.1** + `happy-dom` / `jsdom` | 设置面板、书库过滤、TOC 扁平化、Popover 交互、store 行为 | **不要**测 foliate-js |
| 集成(E2E) | **Playwright 1.64.1** | 打开真实 EPUB/PDF、翻页、划词 → 气泡、高亮持久化、主题切换后**正文样式真的变了**、PWA 离线启动、多标签 DB 选举 | — |
| 视觉 | Playwright `toHaveScreenshot` | 主题 × 排版矩阵(小样本),防"改 CSS 把墨水屏弄坏" | 大面积像素比对(脆弱) |
| 性能 | Playwright trace + `performance.mark` | 首屏可交互、翻页耗时、滚动 FPS、内存(大 PDF) | — |

**如何测 foliate-js 这种命令式渲染(核心建议)**:

1. **不要 mock 引擎**。mock 只会测出"你的 mock 行为",毫无价值。
2. **不要用 jsdom / happy-dom 跑引擎**:它依赖 `ResizeObserver`、`CSS multi-column` 布局、`getClientRects()` 的真实几何 —— jsdom 没有布局引擎(`getBoundingClientRect` 恒为 0),必然全错。
3. **用 Playwright 在真实 Chromium/WebKit 里测**,断言点选在**引擎的稳定输出**上:
   - `foliate-view` 的 `lastLocation.cfi` 在翻页后发生变化;
   - `relocate` 的 `fraction` 单调变化;
   - 高亮 `addAnnotation` 后,overlayer 的 SVG 里出现 `<rect>` 元素数量 > 0(**可数、稳定**);
   - 气泡的 `getBoundingClientRect()` 落在视口内且与选区重叠(几何断言,而非像素)。
4. 准备**固定测试书**:用上游推荐的 `https://github.com/johnfactotum/epub-test`(README 中给出),再加一本自造的固定版式 CBZ 与一本大 PDF。**不要用真实用户书**。
5. 把 `testPlatform` 注入:桌面端 E2E 里如果不想起 Go,注入一个返回 fixture 的 platform 实现(见 2.3)。
6. **CI 分两档**:PR 跑"组件 + 1 本小 EPUB 冒烟"(快);nightly 跑"全格式 × 全主题 × 移动视口"矩阵(慢)。


---

## 12. 可参考的 Vue 开源阅读器 / 同类项目(已核验存在)

> 核验方式:GitHub raw 原文文件(README / package.json)与 jsDelivr 仓库文件清单。**`api.github.com` 本次 403,故不提供 star 数**(未验证字段一律不写)。

| 项目 | 技术栈(原文) | 许可 | 对我们最有价值的部分 | 证据(访问日期 2026-11-02) |
|---|---|---|---|---|
| [jinhuan138/vue-book-reader](https://github.com/jinhuan138/vue-book-reader) | **Vue 3 + foliate-js**;npm 包 `vue-book-reader@1.3.5` | **Apache-2.0** | ⭐**最直接的参考**:foliate-view 的命令式生命周期、竞态处理、iframe 事件桥接(wheel / swipe / key)、Vite 下的 foliate 补丁脚本 `scripts/fix-foliate.mjs`、以及 `getRendition` 风格的实例回调设计 | README(master)、`src/packages/BookView/BookView.vue`、`src/packages/utils/listener/*.ts`、`scripts/fix-foliate.mjs`、`registry.npmjs.org/vue-book-reader/latest` |
| [yzfly/LightRead](https://github.com/yzfly/LightRead) | **Tauri 2 + Vue 3**(package.json:`vue ^3.5.39`、`pinia ^3.0.4`、`vue-router ^5.1.0`、`vite ^8.1.1`、`typescript ~6.0.2`、`vite-plugin-pwa ^1.3.0`、`foliate-js ^1.0.1`;PDF 路线用 `mupdf` / `@embedpdf/pdfium`);发布 Windows / macOS / Linux / Android + 网页 PWA | **AGPL-3.0-or-later** | ⭐**工程组织的现成范本**:`src/services/*`(按能力分文件)、`src/storage/{dexie,tauri,types}.ts`(存储抽象层)、`src/stores/{library,settings}.ts`、`src/i18n/{index,zh,en}.ts`、`scripts/e2e-*.mjs`(用 Playwright 脚本而非测试框架做 E2E)。**注意:AGPL 有传染性,只能参考结构不能抄代码** | `package.json`、`README.md`、jsDelivr `gh/yzfly/LightRead@main` 文件清单 |
| [laowus/Less-Reader](https://github.com/laowus/Less-Reader) | **Electron + Vue 3**;格式 EPUB / MOBI / AZW3 / FB2 / PDF / TXT;README 自述"解析文件的来自开源软件: foliate-js" | **Apache-2.0** | 中小规模 Vue + foliate-js 的目录与构建组织;可作为"最小可读实现"对照 | 仓库 README 原文(经 SearXNG 检索命中,页面含 README 片段) |
| [JustinJia19/EpubReader](https://github.com/JustinJia19/EpubReader) | **Vue 3 + Element Plus + epub.js**;后端 Spring Boot | 未核验 | **反面参照**:它用 **epub.js** 而非 foliate-js,其 README 的 TODO 明确写"解决 epub.js 定位问题,添加记录表,记录用户的阅读进度"——**定位 / 进度是 epub.js 路线的经典痛点**,侧面印证选 foliate-js(CFI 完整实现)是对的 | 仓库 README 原文(经 SearXNG 检索命中) |
| [KornaVue/vue-pdf](https://github.com/KornaVue/vue-pdf) | **Vue 3 + pdf.js** 的 PDF 查看器组件库(monorepo:`packages/`、`samples/`、`tests/`) | 未核验 | PDF 侧的 Vue 封装参考(文本层、链接服务、测试组织) | 仓库 README 与文件清单(经 SearXNG 检索命中) |

**未找到的项目(明确说明,不编造)**:

- 没有找到"**Wails v3 + Vue 3 + foliate-js**"的公开阅读器项目 → **未找到**。
- 没有找到 Vue 3 版 Readium 官方 toolkit 的前端集成示例 → **未找到**(Readium 的 JS 能力主要在 `ts-toolkit`;是否提供 Vue 示例本次未核验)。

---

## 13. 依赖清单建议(版本以 2026-11-02 npm 实测为准)

### 13.1 运行时依赖

| 包 | 建议版本 | 用途 | 备注 |
|---|---|---|---|
| `vue` | `~3.5.44` | 框架 | **不锁 3.6 rc / Vapor** |
| `vue-router` | `^5.4.0` | 路由 | MIT |
| `pinia` | `^4.1.0` | 本地 UI 状态 | setup stores |
| `pinia-plugin-persistedstate` | `^4.7.1` | 设置持久化 | peer `pinia >=3` |
| `@tanstack/vue-query` | `^5.105.2` | 服务端状态 | 只放权威数据 |
| `@vueuse/core` | `^15.0.0` | 组合式工具 | engines `node >=22` |
| `reka-ui` | `^2.11.0` | 无样式 UI 原语 | 浮层 / 对话框 / 焦点管理 |
| `tailwindcss` + `@tailwindcss/vite` | `^4.3.3` | 样式 | CSS-first 配置 |
| `@floating-ui/vue` | `^2.0.1` | 浮层定位(虚拟锚点保底方案) | 见 5.5 |
| `@tanstack/vue-virtual` | `^3.13.51` | 虚拟滚动 | 书库 / 目录 / 搜索 |
| `vue-i18n` | `^11.4.17` | i18n | engines `node >=22` |
| `pdfjs-dist` | `^6.5.438` | PDF 渲染 | Apache-2.0;**worker 需自行配置** |
| `@wailsio/runtime` | `^3.1.0` | Wails 前端运行时 | **只在 `packages/platform/src/wails.ts` import** |
| `foliate-js` | **git submodule / `link:`(自持 fork)** | 渲染引擎 | **不要用 npm 上的同名包**(见 1.1) |

### 13.2 开发依赖

| 包 | 建议版本 | 用途 |
|---|---|---|
| `vite` | `^8.3.5` | 构建(Rolldown) |
| `@vitejs/plugin-vue` | `^6.0.10` | SFC 编译 |
| `typescript` | `~6.0.2`(**建议值,非 latest**) | 类型;TS 7 预演另开流水线 |
| `vue-tsc` | `^3.3.14` | 类型检查 |
| `@vue/tsconfig` | `^0.9.1` | tsconfig 基线 |
| `@intlify/unplugin-vue-i18n` | `^11.2.8` | i18n 预编译 |
| `vitest` | `^5.0.5` | 单测 |
| `@vue/test-utils` | `^2.5.1` | 组件测试 |
| `@playwright/test` | `^1.64.1` | E2E / 视觉 |
| `happy-dom` 或 `jsdom` | 安装时 `latest`(**版本未验证**) | 组件测试环境 |
| `vite-plugin-pwa` | `^2.0.0` | PWA(Web 目标) |
| `workbox-window` | `^7.4.1` | SW 客户端更新提示 |

> **版本策略建议**:表中 `^` 允许 minor 升级;`vue` / `typescript` 用 `~` 或精确锁。pnpm 的供应链延迟策略(trustPolicy / minimumReleaseAge)建议开启——本次只在上游 `vuejs/core` 的提交信息里见到"启用 pnpm trustPolicy"的说法,**该选项的确切语义未逐字核验 → 「未验证」**。

---

## 14. 风险清单

| # | 风险 | 影响 | 概率 | 对策(可验收) |
|---|---|---|---|---|
| **R1** | **foliate-js 上游不稳定**(README 原话:"not stable. Expect it to break and the API to change at any time") | 升级即破坏;无版本号可锁 | 高 | fork + submodule 钉死 commit;`reader-engine` 独立包隔离;契约测试覆盖 `relocate` / `addAnnotation` / `toc` 三个接口 |
| **R2** | **Vite 打包与上游"无构建步骤"假设冲突**(`pdf.js` 用 `fetchText(pdfjsPath(...))` 取 CSS;zip.js / fflate 走 `./vendor/*`) | PDF 打开报错、样式错乱 | 高(真实项目已证明必须打补丁) | 维护 `scripts/patch-foliate.mjs`(参考 `fix-foliate.mjs`);CI 里"打补丁失败即失败" |
| **R3** | **iframe 实际是 `allow-same-origin allow-scripts`**,等同沙箱未生效(为绕 WebKit bug 218086) | 恶意 EPUB 内脚本与主文档**同源**,可触达 Wails 绑定 | 高(上游源码明确) | **必须由 CSP 阻断所有脚本**(上游 README 的 `[!CAUTION]` 也如此要求);WebView 侧再加 origin 隔离;详见 60 号文档的隔离方案与 PoC 清单 |
| **R4** | 主题切换"只换一半"(主文档变了,iframe 内正文没变) | 观感 bug,高频 | 高 | 主题服务**同时**写 CSS 变量 + 调 `renderer.setStyles`;E2E 断言"切换后 iframe 内正文背景色变了" |
| **R5** | 把实例 / DOM 放进响应式状态 | 随机的诡异 bug,极难定位 | 中高 | ESLint 自定义规则 + §5.1 表格作为评审模板 |
| **R6** | 尺寸塌陷导致分页为 0 | 白屏 | 中高 | 容器显式尺寸 + `v-show`;`useResizeObserver` 在 0 尺寸时开发环境告警 |
| **R7** | 大 PDF 内存爆炸 | 崩溃 / 卡顿 | 中高 | 窗口化挂载(±2 页)+ `page.cleanup()` + `renderTask.cancel()`;性能指标入 CI |
| **R8** | PWA + SQLite WASM 的存储不确定性(SAHPool 初始化失败会清库;浏览器可能清存储) | **用户数据丢失** | 中 | 外部持久化护栏(§9.2);UI 明示同步状态;关键数据双写服务端 |
| **R9** | TypeScript 7 + vue-tsc 组合未验证 | 升级卡住 | 中 | 先锁 TS 6;TS 7 走预演流水线,**不阻塞发布** |
| **R10** | Vue 3.6 / Vapor 的诱惑 | 半成品特性进入生产 | 中 | §1.3 作为书面结论;lockfile 校验禁止解析到 `3.6.0-rc*` |
| **R11** | 虚拟化"没生效"(容器无高度) | 数千本书直接卡死 | 中 | 组件库层强制 `min-h-0`;0 高度时开发环境抛错 |
| **R12** | 快捷键在 iframe 内失效 / 与输入框冲突 | 桌面上手感差 | 中 | 主文档 + iframe 双挂;输入元素放行矩阵单测 |
| **R13** | `@wailsio/runtime` 被误引入 Web 构建 | Web 版白屏 | 中 | ESLint `no-restricted-imports` 白名单(§2.3);Web 构建专项 CI |
| **R14** | Reka UI 虚拟锚点 API 未验证 | 划词气泡方案落地受阻 | 中低 | 先用 Floating UI 保底方案;Reka 封装作为优化项 |
| **R15** | 参考项目许可传染(`LightRead` 是 AGPL-3.0) | 法务风险 | 中低 | **只参考结构不抄代码**;`vue-book-reader` 为 Apache-2.0,引用其补丁脚本需保留声明 |

---

## 15. 来源与访问日期

所有链接访问日期均为 **2026-11-02**。

**npm registry(版本 / peer / engines 一手数据)**

- `https://registry.npmjs.org/-/package/vue/dist-tags`;同上 `vite` / `pinia` / `typescript`
- `https://registry.npmjs.org/<pkg>/latest`(`vue`、`vite`、`pinia`、`typescript`、`vue-router`、`@vueuse/core`、`reka-ui`、`radix-vue`、`tailwindcss`、`naive-ui`、`element-plus`、`@tanstack/vue-query`、`@tanstack/vue-virtual`、`vue-virtual-scroller`、`vue-i18n`、`@intlify/unplugin-vue-i18n`、`pdfjs-dist`、`vite-plugin-pwa`、`workbox-window`、`vitest`、`@vue/test-utils`、`@playwright/test`、`@wailsio/runtime`、`@vitejs/plugin-vue`、`vue-tsc`、`@vue/tsconfig`、`pinia-plugin-persistedstate`、`@floating-ui/vue`、`floating-vue`、`foliate-js`、`vue-book-reader`)
- `https://registry.npmjs.org/foliate-js`(provenance:维护者 `shmandadi`、版本 `1.0.0 / 1.0.1`、时间 `2025-04-21`)

**Vue 官方**

- `https://raw.githubusercontent.com/vuejs/core/main/CHANGELOG.md`(3.5.44, 2026-10-13)
- `https://raw.githubusercontent.com/vuejs/core/minor/CHANGELOG.md`(3.6.0-rc.14, 2026-10-30)
- `https://raw.githubusercontent.com/vuejs/core/main/packages/vue/package.json`
- `https://raw.githubusercontent.com/vuejs/docs/main/src/api/reactivity-advanced.md`(`shallowRef` / `triggerRef` / `markRaw` / identity hazard 原文)
- `https://vuejs.org/api/reactivity-core.html`(`ref` 深响应式说明)

**foliate-js 上游源码**

- `https://raw.githubusercontent.com/johnfactotum/foliate-js/master/README.md`
- `https://raw.githubusercontent.com/johnfactotum/foliate-js/master/package.json`(原文摘录如下,注意 version 为 0.0.0 且无 release 历史)

~~~json
{
  "name": "foliate-js",
  "version": "0.0.0",
  "license": "MIT",
  "type": "module",
  "exports": { "./*.js": "./*.js" }
}
~~~
- `https://raw.githubusercontent.com/johnfactotum/foliate-js/master/view.js`(`attachShadow({mode:'closed'})`、`makeBook`、`#onRelocate`、`#createOverlayer`、`getCFI`、`addAnnotation`)
- `https://raw.githubusercontent.com/johnfactotum/foliate-js/master/paginator.js`(`sandbox = 'allow-same-origin allow-scripts'`、ResizeObserver、CSS 多列、`set overlayer`、head 首尾注入 `<style>`、`container-type: size`)
- `https://raw.githubusercontent.com/johnfactotum/foliate-js/master/overlayer.js`(`Overlayer.highlight / underline / strikethrough / squiggly / outline`、`--overlayer-highlight-*`)

**参考项目**

- `https://raw.githubusercontent.com/jinhuan138/vue-book-reader/master/README.md`
- `https://raw.githubusercontent.com/jinhuan138/vue-book-reader/master/src/packages/BookView/BookView.vue`
- `https://raw.githubusercontent.com/jinhuan138/vue-book-reader/master/src/packages/utils/listener/select.ts` / `swip.ts` / `wheel.ts`
- `https://raw.githubusercontent.com/jinhuan138/vue-book-reader/master/scripts/fix-foliate.mjs`
- `https://raw.githubusercontent.com/jinhuan138/vue-book-reader/master/.gitmodules`(`url = https://github.com/johnfactotum/foliate-js.git`)
- `https://data.jsdelivr.com/v1/packages/gh/jinhuan138/vue-book-reader@master?structure=flat`
- `https://raw.githubusercontent.com/yzfly/LightRead/main/package.json` / `README.md`
- `https://data.jsdelivr.com/v1/packages/gh/yzfly/LightRead@main?structure=flat`

**其他**

- `https://sqlite.org/wasm/doc/trunk/persistence.md`(OPFS / COOP-COEP / SAHPool / 跨线程 / 数据库消失)
- `https://v3.wails.io/zh-cn/reference/frontend-runtime`(Wails v3 前端运行时、`wails3 generate bindings`;该页为客户端渲染,正文经站点结构与检索摘要确认)
- `https://raw.githubusercontent.com/vueuse/vueuse/main/packages/core/useMediaQuery/index.md` / `useStorage` / `useResizeObserver` / `useElementSize`
- `https://cdn.jsdelivr.net/npm/@vueuse/core@15.0.0/dist/index.iife.js`(函数名存在性核验)

**本次未取得一手证据、已标注「未验证」的条目**

1. WCAG 在 2026-11 的当前最新推荐版本号
2. Node 26 的 LTS 状态;以及"Vue 3 官方要求 Node X"的官方声明
3. TypeScript 7 与 `vue-tsc` / Volar 的组合是否被官方验证
4. Reka UI 虚拟锚点(virtual element)的确切属性名
5. `@vueuse/gesture` 2.0.0 的维护活跃度与 Vue 3 适配状态
6. Vue 3.6 "Vapor feature-complete" 的一手官方措辞(仅见于第三方页面)
7. `lucide-vue-next` / `@iconify/vue` / `happy-dom` / `jsdom` 的具体版本(仅确认包存在)
8. pnpm `trustPolicy` / `minimumReleaseAge` 选项的确切语义
9. `Less-Reader` / `vue-pdf` 的许可证字段与 star 数(`api.github.com` 本次 403)
10. Wails v3 前端运行时文档页的**逐字正文**(站点客户端渲染,仅取到结构、标题与检索摘要)

---

## 16. 一页纸行动清单

1. **锁版本**:`vue ~3.5.44`、`vite ^8.3.5`、`typescript ~6.0.2`、`pinia ^4.1.0`、Node 22.12+。**禁止 3.6 rc / Vapor 进生产。**
2. **建 monorepo**:`apps/desktop/{services,core,frontend}` + `packages/{ui,platform,reader-engine,sync-core,shared,i18n}`。
3. **平台抽象层先行**:`Platform` 接口 + `wails / web / test` 三实现;ESLint 禁止业务层 import `bindings/`。
4. **foliate-js 自持**:submodule 到自己 fork,打 Vite 补丁(`?inline` CSS + 字符串守卫),写 `foliate.d.ts`。
5. **引擎封装**:`useFoliateEngine`(实例不进 `ref`)+ `bridgeSectionDocument`(iframe 事件)+ `coords.ts`(坐标系)。
6. **UI 底座**:Reka UI + Tailwind 4;阅读器 token 走 `:root` 变量,主题**双写**(主文档 + `renderer.setStyles`)。
7. **状态分层**:Query(服务端)/ Pinia(UI)/ SyncEngine 单例(同步)/ 引擎内部(会话)。
8. **PWA 兜底**:`opfs-sahpool` + Web Locks 选主 + 外部持久化护栏;SW 排除 `/api/` 与 `.wasm`。
9. **测试**:Vitest 测纯逻辑与组件;foliate-js 只做 Playwright E2E(不 mock、不用 jsdom)。
10. **安全**(跨文档):CSP 阻断脚本 + 60 号文档的 PoC 清单;**不要以为 iframe sandbox 挡住了什么**。
