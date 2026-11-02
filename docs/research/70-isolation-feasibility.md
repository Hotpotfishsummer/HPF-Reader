# 70 · 隔离可行性核实：foliate-js 的 iframe 契约 与 Wails v3 可用的隔离手段

> **任务**：task-7 ｜ **交付**：docs/research/70-isolation-feasibility.md
> **调研员**：client-research ｜ **日期**：2026-11-02 ｜ **证据采集**：2026-11-02
> **前置**：task-6（docs/research/60-webview-security-backend-lang.md）已用源码证明——Wails v3 桌面/移动端对 `/wails/runtime` 零校验（`transport_http_notserver.go` 的 `checkRuntimeRequest` 直接 `return true`），IPC 身份是 window 级头、不记录帧来源。本文不重复该结论，只做**它没做的两件事**：把 foliate-js 的 iframe 契约钉死，把 Wails 侧可用手段逐条取证。
> **本文只做调研与设计，不含业务代码。**

### 证据方法与可复核性（请先读这一段）

| 证据类型 | 获取方式 | 可信度 | 说明 |
|---|---|---|---|
| foliate-js `README.md` | jsDelivr 原始 Markdown | **行号可靠** | Markdown 经读取器保留换行，行号可直接复核 |
| foliate-js `paginator.js` / `epub.js` | jsDelivr 原始文件 | **内容精确、行号不可靠** | 读取器会把 JS 的换行折叠为空格；因此本文对这些文件给出**字符偏移**（`@NNNN`）+ 逐字代码片段，可精确复核。行号另引 task-6 对 **Readest fork** 的核实值（**fork 与上游行号不同**，已标注） |
| Wails Go 源码 | task-6 已核实 | 引用 | 本次独立复核受工具限制未完成（详见 `B 的「本次未独立复核」标注） |
| Wails JS 运行时 | jsDelivr `runtime.debug.js` | **内容精确、偏移可复核** | 本文用它独立复核了请求头构造与 URL 来源 |

> **⚠️ 行号声明**：本文凡标「上游 @偏移」者为**本次亲自取证的字符偏移**；凡标「task-6 行号」者为**引用他人已核实结论，本次未独立复核**；两者不混用。

---

## 0. 结论速览

| # | 问题 | 结论 | 证据强度 |
|---|---|---|---|
| **A1** | foliate-js 是否**必须**同源访问 `contentDocument`？ | **必须，且是硬约束**。`paginator.js` 的 `View` 类用 `get document() { return this.#iframe.contentDocument }` 作为**唯一**文档入口（全文件唯一一处 `contentDocument`），其后所有分页/定位/选区逻辑都建立在这个 `doc` 上。iframe 若为 opaque origin，`contentDocument` 返回 `null` → `View.load()` 在第二步就抛异常 | **源码级（亲自取证）** |
| **A2** | 它是否向 iframe 内**注入脚本**？ | **完全不注入**。整个 `paginator.js` 中**没有** `<script`、没有 `createElement('script')`、没有 `document.write`；内容通过 `this.#iframe.src = src` 加载。→ **`CSP script-src 'none'` 不会破坏分页本身** | **源码级（亲自取证）** |
| **A3** | 是否有**逐节文档变换钩子**？ | **有，而且是官方公开 API**：`.transformTarget` 是 `EventTarget`，`"data"` 事件的 `.detail` 为 `{data,type,name}`，官方原话「**Event handlers should mutate `.data` to transform the data**」（`README.md:115`）。`epub.js` 的 `createURL()` 派发该事件并**回读** `event.detail.data` 后再建 blob URL → 这是注入 CSP、剥离脚本、重写 URL 的**正确且唯一早于解析的位置** | **文档级 + 源码级** |
| **A4** | 保留分页能力时的**最高隔离等级**？ | **同源 frame + 严格 CSP + 内容净化 + 受控 scheme**（本文记作 **L2/L3**）。**opaque origin（L4）与 foliate-js 分页不兼容**——不是"功能降级"，是"整体不可用" | **源码级推论** |
| **B5** | 能否在 `/wails/runtime` 前挂自建中间件？ | **可行**（task-6 定位到 `AssetServerOptions.Middleware` 与 asset server 中间件链）。**但中间件与 runtime handler 的执行顺序本次未独立复核** → 列为 PoC 必测项 | 引用 + 待验证 |
| **B6** | 请求里能否拿到**可信的窗口标识**？能否区分主窗口与阅读器窗口？ | **窗口粒度可得，帧粒度不可得**。⚠️ 关键不确定性：`x-wails-client-id` / `x-wails-window-name` 是**由 JS 侧 fetch 显式设置**的（本文亲自取证于 `runtime.debug.js`）→ **JS 可任意改写**；而 `x-wails-window-id` 据 task-6 是**原生层注入**（可信）。**原生层是"覆盖"还是"仅追加"决定 Arch-B 成立与否 → 必须实测** | 部分亲自取证 + 待验证 |
| **B7** | 自定义 scheme 是否产生**独立 origin**？ | **未验证**。官方文档只说明「iOS 用 `wails://` 自定义 scheme」「Android 用 `WebViewAssetLoader` 进程内提供」，**未描述同源模型**；桌面侧据 task-6 的 PoC 草案出现 `http://wails.localhost`。**blob: URL 明确继承创建者 origin**（`README.md:78` 官方自述） | **未验证** |
| **B8** | per-window 权限能否让某窗口**完全没有绑定能力**？ | **不能**。v3.0.0 的 per-window permissions map 只管**摄像头/麦克风/定位/通知**这类 WebView 能力授权，与"绑定方法可见性"无关。近似实现只能靠「窗口 ID + 中间件」 | 发布说明级 |
| **B9** | Arch-A / Arch-B 可行性 | **Arch-A（opaque 内容帧）不可行**（与 A1 冲突，除非重写 `View`）。**Arch-B（阅读器窗口按 window-id 拒绝）可行且是当前唯一现实路径**，前提是 B6 的信任问题通过实测 | 源码级推论 |
| **C** | 兜底 | 若 B6 实测不可信 → 只能走 **A5 结构化渲染**（放弃 foliate-js 分页器，见 task-4 第 11 节 A5） | 设计结论 |

**一句话**：**foliate-js 的分页器在设计上就要求"父窗口能读子 frame 的 DOM"，这与 opaque origin 互斥。因此本项目的隔离不能靠"把内容帧变成不可信源"，只能靠"让内容所在的那个 frame 拿到的东西足够少"——即 L2/L3 的 CSP 硬约束 + Arch-B 的窗口级限权。**

---

# A 部分：foliate-js 的 iframe 契约

## A.1 它**必须**持有 `contentDocument`（同源）——这是硬约束

### A.1.1 唯一入口

`paginator.js` 中 `class View` 的定义（上游字符偏移 `@6868` 起）：

```js
class View {
  #observer = new ResizeObserver(() => this.expand())
  #element = document.createElement('div')
  #iframe = document.createElement('iframe')          // ← @6868
  #contentRange = document.createRange()
  ...
  constructor({ container, onExpand }) { ... }
```

沙箱属性的设置（上游 `@~7760`，含官方注释原文）：

```js
// \`allow-scripts\` is needed for events because of WebKit bug
// https://bugs.webkit.org/show_bug.cgi?id=218086
this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')   // ← @~7760
this.#iframe.setAttribute('scrolling', 'no')
```

**唯一的文档访问入口**（上游 `@7829`，全文件仅此一处 `contentDocument`）：

```js
get element() { return this.#element }
get document() { return this.#iframe.contentDocument }     // ← @7829
async load(src, afterLoad, beforeRender) { ... }          // ← @8006
```

### A.1.2 `load()` 的完整执行路径（上游 `@8006` 起，逐字）

```js
async load(src, afterLoad, beforeRender) {
  if (typeof src !== 'string') throw new Error(...)
  return new Promise(resolve => {
    this.#iframe.addEventListener('load', () => {
      const doc = this.document                                   // ← 若 opaque，这里拿到 null
      afterLoad?.(doc)
      this.#iframe.style.display = 'block'
      const { vertical, rtl } = getDirection(doc)                 // ← 立即解引用 doc
      const background = getBackground(doc)
      this.#iframe.style.display = 'none'
      this.#vertical = vertical
      this.#rtl = rtl
      this.#contentRange.selectNodeContents(doc.body)             // ← @8345，直读书文档 body
      const layout = beforeRender?.({ vertical, rtl, background })
      this.#iframe.style.display = 'block'
      this.render(layout)
      this.#observer.observe(doc.body)                            // ← @8357，观察书文档 body
      doc.fonts.ready.then(() => this.expand())                   // ← 直读书文档 font API
      resolve()
    }, { once: true })
    this.#iframe.src = src                                        // ← 内容经 src 加载（不是 srcdoc）
  })
}
```

> **判定**：`contentDocument` 在 opaque origin 下为 `null`，而 `load()` 紧接着就调用 `getDirection(doc)` → `doc.defaultView` 上抛 `TypeError`。**`View` 根本无法完成一次加载**。因此「opaque origin 会导致部分功能失效」这个说法是**低估**了：它是**引擎无法工作**。

### A.1.3 依赖这个 `doc` 的功能点全清单（实测位置）

| 功能 | 依赖的代码 | 上游偏移 | opaque 下的后果 |
|---|---|---|---|
| **分页（列布局）** | `columnize(layout)` → `setStylesImportant(doc.documentElement, {...})`、`setStylesImportant(doc.body, {...})` | `@9588`、`@9102` | **失效**（无法写书文档样式） |
| **滚动模式布局** | `scrolled()` → 同上 | `@9102` | **失效** |
| **页面尺寸/边距测量** | `const contentRect = this.#contentRange.getBoundingClientRect()`、`documentElement.getBoundingClientRect()`（`const { documentElement } = this.document`） | `@11240` | **失效** |
| **书写方向 / RTL** | `const getDirection = doc => { const { defaultView } = doc; const { writingMode, direction } = defaultView.getComputedStyle(doc.body) ... }` | `@5860` | **失效** |
| **背景色继承** | `const getBackground = doc => doc.defaultView.getComputedStyle(doc.body) ...` | `@6032`、`@6154` | **失效** |
| **页边距元素（页眉/页脚）** | `const makeMarginals = (length, part) => ... document.createElement(...)` 注入到书文档 | `@6295`、`@6316` | **失效** |
| **划词 / 选区** | `doc.addEventListener('selectionchange', ...)`、`const sel = doc.getSelection()` | `@16493` | **失效** |
| **点击定位/折叠光标** | `range.startContainer.ownerDocument.defaultView.getSelection()` → `sel.addRange(range)` | `@5597` | **失效** |
| **CFI 定位** | `CFI.toRange(doc, parts)`（`doc` 由 `View` 提供） | `@~23167` 区段 | **失效** |
| **高亮/标注覆盖层** | `create-overlayer` 事件携带 `doc`，`attach(overlay)` 需要往书文档挂 overlay | `README.md:157` | **失效** |
| **脚注 / 目录跳转** | `.getTOCFragment(doc, id)` —— 接收 `Document` 对象 | `README.md:113` | **失效** |
| **字体加载完成后重排** | `doc.fonts.ready.then(...)` | `@8006` 内 | **失效** |
| **内容尺寸监听** | `this.#observer.observe(doc.body)`（ResizeObserver） | `@8357` | **失效** |
| **搜索** | 走同一 `doc`（`search.js` 消费被渲染的文档） | **本次未逐行取证** | **推定失效（未验证）** |

> **结论 A1**：**`contentDocument` 同源访问不是可选项，而是 foliate-js 分页器的架构前提。** 想让内容帧变成 opaque origin，等价于**重写 `View` 为「帧内 agent + postMessage 协议」**——那不是配置改动，是渲染引擎核心重写。

## A.2 它**不**注入脚本——这是本文最重要的好消息

### A.2.1 取证结果

对 `paginator.js`（32,729 字符）做全文模式检索：

| 检索目标 | 结果 |
|---|---|
| 字面量 `<script` | **0 处** |
| `createElement('script')` | **0 处** |
| `document.write` / `insertAdjacentHTML` | **0 处** |
| `innerHTML` | 仅 1 处，是 **`View` 自己的宿主容器**：`this.#root.innerHTML = ...`（`@14168`，`Paginator` 建立 marginals 容器），**不是往书文档写** |
| 内容注入方式 | `this.#iframe.src = src`（`@8006`）；`src` 是 `createURL()` 产出的 **`blob:` URL** |

### A.2.2 这意味着什么（关键推论）

1. **`CSP: script-src 'none'` 不会破坏 foliate-js 的分页。** 分页逻辑全部运行在**父窗口**，通过 `contentDocument` 直接操作书文档的 DOM/CSSOM；书文档内**不需要执行任何脚本**。
2. `allow-scripts` 之所以出现，是 **`README.md:79` 所述的 WebKit Bug 218086 的规避**（"the `allow-scripts` attribute **is required** on iframes, which renders iframe sandbox useless"），**不是**因为 foliate-js 自己要注入脚本。
3. 因此**「书文档内的脚本」与「引擎自身」是两件事**：我们可以对书文档下 `script-src 'none'`，而不影响引擎。

> ⚠️ **但必须同时记住反向事实**：`allow-same-origin` + `allow-scripts` 的组合意味着**书文档若真能执行脚本，它就能同源触达父窗口**。所以 `script-src 'none'` 不是"锦上添花"，而是**唯一把书内容变成惰性数据的手段**。

### A.2.3 上游**不**清理书内脚本（重要）

`epub.js` 的 `loadReplaced()`（上游 `@26215` 起）会解析并重写书内 HTML（替换 href、处理 `[style]` 属性），其中留下了这句原文注释（上游 `@29072` 附近）：

```js
for (const el of doc.querySelectorAll('[style]'))
  el.setAttribute('style', await this.replaceCSS(el.getAttribute('style'), href, parents))
// TODO: replace inline scripts? probably not worth the trouble
const result = new XMLSerializer().serializeToString(doc)
return this.createURL(href, result, item.mediaType, parent)
```

> **判定**：**foliate-js 上游不会剥离书内 `<script>`**（作者明说"probably not worth the trouble"）。**净化必须由我们做**——幸运的是，A.3 的钩子提供了正规接入点。这也解释了 `README.md:84` 的 CAUTION 为何措辞如此重。

## A.3 逐节文档变换钩子：有，且是官方 API

### A.3.1 官方文档原文（`README.md:115`）

> "In addition, the `.transformTarget`, if present, can be used to transform the contents of the book as it loads. It is an `EventTarget` with a custom event `"data"`, whose `.detail` is `{ data, type, name }`, where `.data` is either a string or `Blob`, or a `Promise` thereof, `.type` the content type string, and `.name` the identifier of the resource. **Event handlers should mutate `.data` to transform the data.**"

### A.3.2 源码验证：钩子确实会**回读**被改写的数据

`epub.js` 的 `createURL()`（上游 `@~23810`，逐字）：

```js
const event = new CustomEvent('data', { detail })
this.eventTarget.dispatchEvent(event)      // ← 同步派发给所有监听者
const newData = await event.detail.data    // ← 回读：监听者可替换数据
const newType = await event.detail.type
const url = URL.createObjectURL(new Blob([newData], { type: newType }))   // ← 建 blob URL
this.#cache.set(href, url)
```

`transformTarget` 的对外暴露（`epub.js` 上游 `@~32974`）：

```js
this.transformTarget = this.#loader.eventTarget
```

> 即 `Loader` 的 `eventTarget = new EventTarget()`（上游 `@23167` 区段）被直接暴露为 `epub.transformTarget`。**这是一个"官方支持的、发生在 blob URL 生成之前的、按资源逐份"的变换点。**

### A.3.3 其他可用钩子（层级与时机）

| 钩子 | 位置 | 时机 | 用途 | 能否替代 A.3.2 |
|---|---|---|---|---|
| `epub.transformTarget` 的 `"data"` 事件 | `README.md:115`；`epub.js` `@23810` / `@32974` | **字符串/Blob 生成 blob URL 之前**（解析之前） | 注入 `<meta CSP>`、剥离 `<script>`/`<iframe>`/远程引用、重写 URL | ✅ **首选，唯一"早于解析"的点** |
| `sections[i].load()` 返回值 | `README.md:90`「returns a string containing the URL that will be rendered」 | 拿到的已是 URL | 只能改 URL（如换成我们自己的受控 scheme） | ⚠️ 需配合 A.3.2 才能改内容 |
| `view.load(src, afterLoad, beforeRender)` | `paginator.js` `@8006` | iframe `load` 事件后（**已解析**） | `afterLoad(doc)` 可在渲染前遍历 DOM 做二次净化；`beforeRender` 可调布局参数 | ⚠️ **补救层**，脚本可能已执行过；不能作为主防线 |
| `"load"` 事件 `{doc, index}` | `README.md:155` | 章节加载完成 | 同 `afterLoad` | 同上 |
| `"relocate"` `{range,index,fraction}` | `README.md:156` | 位置变化 | 进度、标注锚定 | — |
| `"create-overlayer"` `{doc,index,attach}` | `README.md:157` | 需要覆盖层时 | 高亮/标注绘制 | — |

### A.3.4 最小改造方案（**不改 foliate-js 源码**）

在集成层（我们的 Vue 代码里）挂监听，所有资源在生成 blob URL 之前被改写：

```js
// 设计草案：不改 foliate-js 源码，仅使用官方 transformTarget
epub.transformTarget.addEventListener('data', (e) => {
  const { name, type } = e.detail
  // 1) 只处理文档类资源；二进制资源（图片/字体）走白名单校验
  if (!/xhtml|html|svg/i.test(type ?? '')) { /* 二进制：校类型+大小 */ return }
  e.detail.data = e.detail.data.then((html) => {
    // 2) 注入 CSP 必须位于 <head> 最前，早于任何资源
    const csp = '<meta http-equiv="Content-Security-Policy" content="' +
      "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; " +
      "font-src data:; script-src 'none'; connect-src 'none'; frame-src 'none'; " +
      "object-src 'none'; base-uri 'none'; form-action 'none'" + '">'
    // 3) 净化：剥离 script/iframe/object/embed/link(远程)/@import/远程 url()
    // 4) 重写资源引用为受控 URL
    return sanitizeAndRewrite(html, { csp, name })
  })
})
```

> **接入成本评估**：**低**（纯集成层，零引擎改动）。**但有效的前提**是净化足够严、CSP 确实生效——这正是 A.4 与 C 部分要验证的。

## A.4 A 部分结论：保留 foliate-js 分页时的**最高隔离等级**

### A.4.1 隔离等级阶梯

| 等级 | 结构 | 分页可用性 | 隔离强度 | 判定 |
|---|---|---|---|---|
| **L0** | 同源 iframe + `sandbox="allow-same-origin allow-scripts"` + blob: + **无 CSP** | ✅ | **无隔离**（书内容可同源触达父窗口 → 直接调用全部绑定） | ❌ 现状，**不可接受** |
| **L1** | L0 + DOMPurify 净化（剥 `script/iframe/object/embed` 与远程引用） | ✅ | **弱**（单点防线；净化被绕过即失守） | ⚠️ 必要但不充分 |
| **L2** | L1 + **书文档严格 CSP**（经 `transformTarget` 注入 meta；或经受控 scheme 下发 **header**） | ✅（A.2 已证引擎不依赖书内脚本） | **中强**（净化 + **浏览器强制**双防线；书内脚本不再执行） | ✅ **本方案推荐下限** |
| **L3** | L2 + `sandbox` **去掉 `allow-scripts`**（仅 `allow-same-origin`） | ⚠️ **取决于 WebKit Bug 218086 是否仍存在**（`README.md:79` 称 `allow-scripts` "is required"） | **强**（双保险：即使 CSP 被绕过也无脚本执行） | ✅ **可达上限（待实测）** |
| **L4** | **opaque origin**（`sandbox` 不给 `allow-same-origin`） | ❌ **完全不可用**（A.1：`contentDocument` 为 `null`） | 最强 | ❌ **与 foliate-js 分页互斥** |

### A.4.2 判断依据

1. **上界由 `contentDocument` 决定**：只要保留 foliate-js 的 `View`，帧就必须同源；同源 ⇒ `allow-same-origin` 必须保留 ⇒ 书文档与宿主**同源**。因此**"书内容成为不可信源"这一目标在保留分页的前提下无法达成**。
2. **下界由"书内脚本"决定**：既然无法把内容变成不同源，就必须让书内**根本不能执行脚本**。两条独立的路：①**CSP `script-src 'none'`**（浏览器强制，最可靠）；②**去掉 `allow-scripts`**（受 WebKit Bug 218086 制约）。
3. **净化只是"减少攻击面"**，不是边界——`README.md:84` 官方自己就警告不要把安全建立在"信任内容"上。

### A.4.3 因此**可达最高等级 = L2（确定可达）+ L3（若 Bug 218086 已修/可规避）**

**必须叠加的硬性前提**：

| 前提 | 理由 |
|---|---|
| ① CSP 必须**逐字生效**：meta 注入必须在 `<head>` **最前**，早于任何可达资源；二进制资源不得绕过 | CSP 只在解析点之后生效，注入位置错了等于没注入 |
| ② 更优：用**受控 scheme 的响应头**下发 CSP（header 强于 meta，且覆盖所有子资源） | ⚠️ **是否可行取决于 B7（自定义 scheme 同源模型）** —— 未验证 |
| ③ `default-src 'none'` 必须完整写出（`connect-src`/`frame-src`/`object-src`/`base-uri`/`form-action` 都要显式禁） | 只禁 `script-src` 会留下 `<iframe srcdoc>`、`<base>`、表单外发等旁路 |
| ④ **仍然必须**叠加 B 部分的桥侧限制（Arch-B） | L2/L3 把概率压到很低，但"绕过 CSP = 完全失守"，需要纵深 |
| ⑤ 书内**不允许**出现 `<iframe>`/`<object>`/`<embed>`（含嵌套绕过） | 嵌套文档有自己的 CSP，是我们控制不到的边界 |

### A.4.4 A 部分不确定项

| # | 不确定项 | 影响 |
|---|---|---|
| A-U1 | **WebKit Bug 218086 的当前状态**（`README.md:79` 称 `allow-scripts` "is required"）：是否仍在？去掉它在新版 WebKit/WKWebView/WebKitGTK 上是否可行？ | 决定 L3 能否成立 |
| A-U2 | 去掉 `allow-scripts` 后，`contentDocument` 在 **各平台 WebView** 上是否仍可访问（这就是该 bug 的争议核心？） | 同上；**必须逐平台实测** |
| A-U3 | `search.js` 是否完全依赖同一 `doc` | 影响 L4 下"仅搜索可用"这类折中的可能性（估计没有） |
| A-U4 | meta CSP 在某些平台上是否被**同时**用于 `blob:` 文档时正确强制 | 决定 L2 是否等于"真"防线 |
| A-U5 | `transformTarget` 对**所有**文档类资源（含 SVG、封面页）都触发 | 漏掉即出现未净化入口 |

---

# B 部分：Wails v3 到底允许我们做什么

## B.1 前提（承接 task-6，本文不重复取证）

task-6 已用源码证明：桌面/移动构建（`!server`）对 `/wails/runtime` **不做任何来源/帧校验**（`v3/pkg/application/transport_http_notserver.go` 的 `checkRuntimeRequest` 直接 `return true`）；只有 server 构建才校验 Origin（`transport_http_server.go`）。**本文把 task-6 的行号引用与本文亲自取证的偏移区分标注。**

## B.2 请求中间件：可行（但顺序待实测）

| 项 | 内容 | 证据 |
|---|---|---|
| 可用挂载点 | `AssetServerOptions.Middleware`，被挂进 asset server 的中间件链 | **task-6 行号**：`v3/pkg/application/transport.go:58-67`（本文**未独立复核**） |
| 能做什么 | (a) 校验自建 token；(b) 按窗口 ID 拒绝；(c) 限制请求体大小（默认 `/wails/runtime` 上限 **64 MiB**，超限 413） | 能力来自 `net/http` 中间件语义 + Wails 官方 server-build 文档（task-4 已核实） |
| ⚠️ **关键不确定性** | **中间件与 runtime handler 的执行顺序**：若 runtime handler 先于中间件注册，中间件可能拦不到 `/wails/runtime` | **本次未取证** → 列为 C-01 首测项 |
| 兜底方案 | 若中间件顺序不可控：桌面端在**应用自己的 HTTP 层**做；server 端在**反向代理**做（官方 server-build 文档明确建议用 middleware 或反向代理限制请求体，说明两者都被支持） | 官方文档（task-4 已核实） |

> **判定**：**方向可行，但"能挂"≠"能拦到 `/wails/runtime`"**。必须先做 C-01 的日志验证，再设计依赖它的防线。

## B.3 窗口/帧身份：能拿窗口，拿不到帧（**Arch-B 的成立条件**）

### B.3.1 请求里到底有哪些头，谁设置的（本文亲自取证）

对 `v3/internal/assetserver/bundledassets/runtime.debug.js`（475,218 字符）的检索结果：

| 头 | 出现位置 | **由谁设置** |
|---|---|---|
| `x-wails-client-id` | 上游 `@4553` / `@4653` | **JS 侧 fetch 显式设置**，逐字：`let headers = { ["x-wails-client-id"]: clientId, ["Content-Type"]: "application/json" }` |
| `x-wails-window-name` | 上游 `@4553` / `@4653` | **JS 侧**：`if (windowName) headers["x-wails-window-name"] = windowName` |
| `Content-Type: application/json` | 同上 | JS 侧 |
| `x-wails-chunk-*`（`chunk-id/index/total`） | 上游 `@6237` 起 | JS 侧（分块上传） |
| `x-wails-stream-*`（`session/generation/conn/kind/name/chunk/chunk-index/chunk-total`） | 上游 `@99238` 起 | JS 侧（流） |
| `x-wails-window-id` / `x-wails-window-name` | — | 据 **task-6**：**原生层**在 webview 请求上注入（`v3/pkg/application/application.go:390-402`）；本文**未独立复核** |

### B.3.2 直接回答：「不可伪造的窗口标识」存在吗？

| 问题 | 回答 |
|---|---|
| 有 window 粒度的标识吗？ | **有**（`x-wails-window-id`，原生注入） |
| 有 **frame** 粒度的标识吗？ | **没有**。同一 webview 内**所有帧**的请求携带同一个 window id（task-6 结论），框架**不记录帧来源** |
| `x-wails-client-id` 可信吗？ | ❌ **不可信**。它是 **JS 自己填的**（本文亲自取证），任何能执行 JS 的帧都能改写它 → **不能作为授权依据** |
| `x-wails-window-id` 可信吗？ | ⚠️ **取决于一个未验证的实现细节**：原生层是 **`Header.Set`（覆盖）** 还是 **`Header.Add`（追加/仅缺失时设置）**？<br>• 若**覆盖** → 页面无法篡改 → **可信** → **Arch-B 成立**<br>• 若**仅追加** → Go 侧 `getTargetWindow` 取到哪个值不确定，攻击者可注入伪造值 → **不可信** → **Arch-B 不成立** |
| 内容帧能否伪造？ | 在**同源**前提下（L2/L3 的书文档与宿主同源）：**能读到父窗口的变量**，因此即使不伪造头，它也能直接复用 `window.top` 的 runtime helper 发起合法请求。**所以"窗口标识"只能用来做"按窗口限权"，不能用来做"区分帧"。** |

### B.3.3 对 Arch-B 的判定

**Arch-B（阅读器窗口按 window-id 拒绝 `/wails/runtime`）的成立条件**：

| # | 条件 | 状态 |
|---|---|---|
| 1 | 原生注入的 `x-wails-window-id` **覆盖**页面自填值 | **未验证** → C-09 必测 |
| 2 | 自建中间件确实能拦到 `/wails/runtime` | **未验证** → C-01 必测 |
| 3 | 阅读器窗口只放行**窄接口**（如 `bookBytes(id)` / `saveProgress`），且窄接口自身不接受任意路径 | **设计约束**（我方可控） |

**若条件 1 不成立**：恶意书内容可冒充主窗口调用全部绑定 → **Arch-B 失效** → 只能走 **A5 结构化渲染**（放弃 foliate-js 分页器）。

**Arch-B 成立时的隔离强度**：**中强**。书内容仍在同源帧内、仍可能执行脚本（若 L2/L3 被绕过），但它能触达的桥面被压缩到**阅读器窗口的窄接口**（读当前书、存进度），拿不到"读任意文件""执行命令"这类能力。**这是"爆炸半径控制"，不是"绝对隔离"** —— 因此 **Arch-B 必须与 L2/L3 叠加**。

## B.4 独立 origin / 自定义 scheme：**未验证**

| 平台 | 官方描述的加载方式 | 同源模型 | 能否与宿主分离 |
|---|---|---|---|
| Windows/macOS/Linux 桌面 | asset server 提供资源（task-6 的 PoC 草案使用 `http://wails.localhost/wails/runtime`） | 未在官方文档中找到对 origin 的说明 | **未验证** |
| iOS | **`wails://` 自定义 scheme**（「Assets served via a custom `wails://` scheme — no open ports」，task-4 已核实官方原文） | **未描述** | **未验证** |
| Android | **`WebViewAssetLoader`**，assets **进程内**由 Go asset server 提供（无 localhost、无开放端口） | **未描述** | **未验证**（进程内 loader 通常对应单一 app origin，分离可能性低） |
| 书籍内容（现状） | `URL.createObjectURL(new Blob([...]))` → **`blob:` URL** | **继承创建者 origin** —— 官方原文（`README.md:78`）："It is currently impossible to do so securely due to the content being served from **the same origin (using `blob:` URLs)**" | **不能**（官方明确自述） |

> **判定**：**"让书文档拥有独立 origin"目前没有官方依据，且官方明确说 `blob:` 就是同源——这正是 foliate-js 认为无法安全支持脚本的原因。**
> **待验证的替代路径**：①作品资源是否可改由**自定义 scheme/协议**提供（从而可下发 **CSP header** 而非 meta）；②该 scheme 在各平台是否产生独立 origin。**两者均未取证** → C-05/C-06。

## B.5 多窗口与 per-window 权限：**不能**让某窗口"零绑定能力"

| 问题 | 回答 | 证据 |
|---|---|---|
| v3 有 per-window 权限配置吗？ | **有**，但管的是 **WebView 能力授权**：摄像头、麦克风、定位、通知 | v3.0.0 发布说明（task-4 已核实） |
| 能让某个窗口完全没有绑定能力吗？ | **不能**。**Services 是全局单例，对所有窗口可见**（task-4 已核实官方原文："Services are **shared across all windows**"）。没有任何"按窗口屏蔽导出方法"的官方开关 | 同上 |
| 近似实现 | **可以用「窗口 ID + 中间件」近似**：中间件按 `x-wails-window-id` 拒绝阅读器窗口对 `/wails/runtime` 的调用 | 即 Arch-B |
| 缺口 | 近似实现**依赖 B.3 的信任前提**，且同一窗口内**无法区分主帧与书内容帧** | 本文分析 |

## B.6 B 部分结论：Arch-A / Arch-B 可行性对照

| 方案 | 结构 | 可行性 | 残余风险 |
|---|---|---|---|
| **Arch-A**（opaque 内容帧） | 引擎帧（可信，同源）+ 内容帧（**opaque origin**） | ❌ **与 foliate-js 分页互斥**（A.1：`contentDocument` 为 `null`）。除非**重写 `View`** 为"帧内 agent + postMessage"——那是渲染引擎核心重写，不是配置 | — |
| **Arch-B**（阅读器窗口按 window-id 限权） | 整个阅读器（引擎+内容）独立 WebViewWindow，主窗口不渲染书；中间件按窗口拒 `/wails/runtime`，只放行窄接口 | ✅ **当前唯一现实路径**，但**成立与否取决于两个必测项**（C-01 中间件顺序、C-09 头是否可伪造） | 书内容仍在同源帧内 → 依赖 **L2/L3** 的 CSP 作为第二道防线；爆炸半径 = 窄接口 |
| **A5**（结构化渲染） | 放弃 foliate-js 分页器，解析 EPUB → 安全内部模型 → Vue 组件渲染 | ✅ **兜底路径**（不依赖任何未验证前提） | 牺牲 EPUB CSS 保真度；分页/CFI 需自研（或改用 Locator 模型） |

> **建议**：**Arch-B + L2/L3 并行推进**；**C-01 与 C-09 是 Go/No-Go 门**（两者通过 → Arch-B 成立；任一失败 → 转 A5）。同时把 **A5 的结构化渲染**作为长期主方案评估，因为它**不依赖任何未验证前提**。

---

# C 部分：必须实测的清单（PoC）

> **本文不写代码**。每条给：做法 / **预期结果** / **若不符合预期说明什么**。
> 环境建议：Windows 11 + WebView2、macOS 14+ + WKWebView、Ubuntu 24.04 + WebKitGTK、Android 系统 WebView（移动端进 M1 才必测）。

## C.1 优先级最高（决定 Arch-B 生死）

| ID | 做法 | 预期结果 | 若不符合预期 |
|---|---|---|---|
| **C-01** | 挂一个**所有请求都打日志**的中间件，然后从主窗口调一次绑定 | 中间件**先于** runtime handler 看到 `POST /wails/runtime` | 中间件拦不到 → **B.2 失效** → Arch-B 需改用反向代理/自定义 HTTP 层，或放弃 Arch-B |
| **C-09** | 从任意帧手写 `fetch` 并**故意设置 `x-wails-window-id: <伪造值>`**，服务端打印它看到的该头 | 服务端看到的是**原生注入的真实值**（被覆盖） | 看到伪造值 → **头不可信** → **Arch-B 判死** → 转 A5 |
| **C-10** | 在阅读器窗口内调用一个**只应主窗口可用**的绑定，中间件按 window-id 拒绝 | 阅读器窗口 **403**；主窗口正常 200 | 阅读器窗口拿到 200 → Arch-B 未生效 |
| **C-11** | 从主窗口内嵌一个**同源无沙箱 iframe**，在其内 `fetch(window.location.origin + "/wails/runtime")` 调一个读文件绑定 | **加固前成功（漏洞真实存在，作为 PoC 有效性证据）**；加固后 403 且无副作用 | 加固后仍成功 → 防线无效 |

## C.2 决定 foliate-js 能否保住（L2/L3 边界）

| ID | 做法 | 预期结果 | 若不符合预期 |
|---|---|---|---|
| **C-02** | 在书文档注入 `script-src 'none'` 的 **meta CSP**（经 `transformTarget` 置入 `<head>` 最前），打开一本**含 `<script>`** 的 EPUB | 书内脚本**不执行**；分页/翻页/目录**全部正常** | 脚本仍执行 → CSP 未生效（注入位置/时机问题）；分页坏 → CSP 误伤了引擎（A.2 推论被推翻，需回查） |
| **C-03** | 书文档**去掉 `allow-scripts`**（仅留 `allow-same-origin`），打开普通 EPUB | `contentDocument` **仍可访问**，分页正常 | 不可访问/分页坏 → **Bug 218086 仍在，L3 不可达**，上限锁定 L2 |
| **C-04** | 记录书文档在**各平台**的 `document.origin`（`blob:` 下） | 等于宿主 origin（同源） | 若不同源 → 与 `README.md:78` 矛盾，需重查 |
| **C-12** | 书内尝试 `window.top.document` / `window.parent.<任意变量>`（同源时） | **能读到**（这正是必须靠 CSP 的原因） | 读不到 → 同源假设错，隔离强度可上调 |
| **C-13** | 书内 `<iframe srcdoc>` / `<object>` / `<meta http-equiv=refresh>` / `<a target=_top>` / `<form>` 提交 | 被 **`frame-src 'none'` / `object-src 'none'` / `form-action 'none'` / `sandbox`** 全部拦下 | 任一成功 → CSP 指令集不完整，需补齐 |

## C.3 决定能否用 header 级 CSP（比 meta 强）

| ID | 做法 | 预期结果 | 若不符合预期 |
|---|---|---|---|
| **C-05** | 把书资源改由**自定义 scheme/协议**提供，打印该文档的 `document.origin` 与 `location.href` | 能拿到期望的 origin；**理想结果是独立 origin** | 仍与宿主同源 → 无法靠 origin 分离，只能靠 CSP |
| **C-06** | 在 C-05 的 scheme 响应上下发 **`Content-Security-Policy` 响应头** | 书文档遵守 header CSP（强于 meta，可覆盖所有子资源） | 头不生效 → 退回 meta（L2），并把"注入位置必须最前"作为硬约束 |

## C.4 回归（隔离不得牺牲功能）

| ID | 做法 | 预期结果 | 若不符合预期 |
|---|---|---|---|
| **C-07** | 在 L2/L3 加固下走完整主流程：打开 EPUB/TXT/PDF、翻页、目录跳转、**划词**、**高亮**、脚注跳转、搜索、进度同步 | **全部正常** | 某项失效 → 说明该项依赖被 CSP 阻断的机制，需定位（A.1.3 的清单可对照） |
| **C-08** | 恶意语料：含 `<script>`、`onerror=`、`javascript:` 链接、远程图片/CSS/字体、`<!ENTITY xxe>`、高压缩比 zip 的 EPUB | 均被剥离/拒绝；**抓包零出站** | 有出站/有执行 → 净化或 CSP 有缺口 |

## C.5 通过标准

| 类别 | 标准 |
|---|---|
| **Go/No-Go 门** | **C-01 与 C-09 必须通过**，否则 Arch-B 不成立，转 A5 |
| 阻断类 | C-10、C-11、C-13 全部「403/无副作用 + 服务端有拒绝日志」 |
| 隔离类 | C-02 书内脚本零执行；C-12 明确记录"同源可读父窗口"这一事实 |
| 功能类 | C-07 全通过（**隔离不能以牺牲分页/划词/高亮为代价**） |
| 证据 | 每项留：抓包、服务端日志（含 403）、加固前后对照截图 |

---

# 附录 A · 不确定项总清单

| # | 不确定项 | 归属 | 影响 |
|---|---|---|---|
| A-U1 | WebKit Bug 218086 当前状态；`allow-scripts` 是否可去 | A | 决定 L3（可达上限） |
| A-U2 | 去掉 `allow-scripts` 后 `contentDocument` 在各平台是否仍可访问 | A | 同上 |
| A-U3 | `search.js` 是否完全依赖同一 `doc` | A | 影响任何"部分功能保留"的折中 |
| A-U4 | meta CSP 对 `blob:` 文档在各平台是否被正确强制 | A | 决定 L2 是否是真防线 |
| A-U5 | `transformTarget` 是否覆盖**所有**文档类资源 | A | 漏掉即为未净化入口 |
| B-U1 | 中间件与 runtime handler 的**执行顺序** | B | **Arch-B 生死**（C-01） |
| B-U2 | 原生层对 `x-wails-window-id` 是 **Set（覆盖）** 还是 **Add** | B | **Arch-B 生死**（C-09） |
| B-U3 | 各平台自定义 scheme 的 origin 模型 | B | 决定能否用 header CSP 与独立 origin |
| B-U4 | 移动端 `WebViewAssetLoader` / `wails://` 能否分离 origin | B | 决定移动端隔离强度 |
| B-U5 | `getTargetWindow` 在收到多个同名头时的取值语义 | B | 影响 B-U2 的严重性 |
| C-U1 | 老旧 Android WebView 上 CSP / sandbox 的实际执行是否可靠 | C | 移动端隔离可信度 |

# 附录 B · 证据索引

| # | 来源 | 位置 | 采集 |
|---|---|---|---|
| E1 | foliate-js `README.md` Security 段（`blob:` 同源、Bug 218086、必须用 CSP） | 行 **74-84** | 2026-11-02（jsDelivr，行号可靠） |
| E2 | foliate-js `README.md` `transformTarget` 契约（原文 "mutate `.data`"） | 行 **115** | 同上 |
| E3 | foliate-js `README.md` 事件（`load` / `relocate` / `create-overlayer`） | 行 **155-157** | 同上 |
| E4 | foliate-js `README.md` `.load()` 返回"要渲染的 URL" | 行 **90** | 同上 |
| E5 | foliate-js `README.md` `getTOCFragment(doc, id)` 接收 Document | 行 **113** | 同上 |
| E6 | `paginator.js` `View`：`createElement('iframe')` / `sandbox` / `contentDocument` / `load()` | 上游偏移 **@6868 / @~7760 / @7829 / @8006** | 2026-11-02（jsDelivr，内容精确） |
| E7 | `paginator.js` 依赖 `doc` 的功能点（`selectNodeContents@8345`、`observe@8357`、`getDirection@5860`、`getBackground@6032@6154`、`selectionchange@16493`、`getSelection@5597`、`getBoundingClientRect@11240`、`makeMarginals@6295`） | 上游偏移 | 同上 |
| E8 | `paginator.js` **无** `<script>` / `createElement('script')` / `document.write`（全文检索 0 命中） | 全文 | 同上 |
| E9 | `epub.js` `createURL()` 派发 `data` 事件并**回读** `detail.data` → `createObjectURL(Blob)` | 上游偏移 **@~23810** | 同上 |
| E10 | `epub.js` `this.transformTarget = this.#loader.eventTarget` | 上游偏移 **@~32974** | 同上 |
| E11 | `epub.js` `loadReplaced()` 与 "TODO: replace inline scripts? probably not worth the trouble" | 上游偏移 **@~29072** | 同上 |
| E12 | Wails `runtime.debug.js`：`x-wails-client-id` / `x-wails-window-name` 由 **JS fetch** 设置；`x-wails-chunk-*`；`x-wails-stream-*` | 上游偏移 **@4553 / @4653 / @6237 / @99238** | 2026-11-02（jsDelivr） |
| E13 | Wails 桌面/移动 `checkRuntimeRequest` 直接 `return true` | task-6：`transport_http_notserver.go:1-13` | 引用（**未独立复核**） |
| E14 | Wails 原生注入 `x-wails-window-id/name` | task-6：`application.go:390-402` | 引用（**未独立复核**） |
| E15 | Wails `getTargetWindow` 只看 ClientID/WebviewWindowName/WebviewWindowID | task-6：`messageprocessor.go:85-160` | 引用（**未独立复核**） |
| E16 | Wails 中间件挂载点 `AssetServerOptions.Middleware` / `transport.go:58-67` | task-6 | 引用（**未独立复核**） |
| E17 | Wails services 为**跨所有窗口共享的单例**（无按窗口屏蔽绑定的开关） | task-4（官方 `features/bindings/services.md`） | 2026-11-02 |
| E18 | Wails 移动端加载方式：iOS `wails://` scheme；Android `WebViewAssetLoader` 进程内 | task-4（官方 `guides/mobile/index.md`） | 2026-11-02 |
| E19 | Wails `/wails/runtime` 64 MiB 上限、Origin/loopback 校验仅在 server 构建 | task-4（官方 `guides/server-build.md`） | 2026-11-02 |

---

## 一句话交接（给 lead）

> **A 部分钉死了**：foliate-js 的 `View` 用 `get document() { return this.#iframe.contentDocument }`（上游 `@7829`）作为唯一文档入口，分页/划词/高亮/CFI/脚注**全部**建立在这个同源 `doc` 上 → **opaque 帧（Arch-A）会把 `contentDocument` 变成 `null`，让引擎在 `load()` 的第二步就抛异常，arch-A 直接判死**（除非重写 `View` 为帧内 agent）。好消息：**它完全不注入脚本**（`<script>` 全文 0 命中），所以 `script-src 'none'` 不破坏分页——**可达上限是同源 + 严格 CSP + 净化（L2/L3，L3 取决于 WebKit Bug 218086 是否仍逼着用 `allow-scripts`）**。
> **B 部分**：中间件方向可行但顺序未验证；**`x-wails-client-id` 是 JS 自填的、明确不可信**（本文亲自取证），**`x-wails-window-id` 若为原生覆盖则可信** → **C-01 + C-09 是 Arch-B 的 Go/No-Go 门**。任一失败 → 转 **A5 结构化渲染**。

**文档结束** · 相关：docs/research/40-wails-v3.md（第 11 节补偿清单）、docs/research/60-webview-security-backend-lang.md（task-6 源码证据）、docs/DESIGN.md。
