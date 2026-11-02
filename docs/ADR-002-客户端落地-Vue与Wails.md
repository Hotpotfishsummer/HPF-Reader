# ADR-002 客户端落地：Vue 3 + Wails v3（用户决策）

- 状态：**已接受**（2026-11-02 由用户拍板）
- 取代：ADR-001 中关于 React 与 Tauri v2 的两条推荐（其证据与对比保留，作为复评依据）
- 影响：客户端外壳、前端框架、本地数据层、构建发布链路、以及**后端语言选型**

---

## 1. 决策

| 项 | 决策 | 此前推荐 |
|---|---|---|
| 前端框架 | **Vue 3 + Vite** | React 19 + Vite |
| 客户端外壳 | **Wails v3（Go）** | Tauri v2（Rust） |
| 渲染内核 | foliate-js（MIT，自持 fork） | 不变 |
| 后端 | **待定**（见第 4 节，task-6 正在评估 Go vs TS） | TS + Fastify/NestJS |

**立场说明（写进文档以免日后扯皮）**：ADR-001 里我给出的两条反对理由是真实的（移动端 experimental、iframe 可触达原生绑定）。你做了决定，我不再重复争论，而是把它们转换成**有时间点、有失败判据、有回退预案的工程闸门**（第 3 节）。闸门失败就按预案走。

---

## 2. 这个选择带来的真实红利

| # | 红利 | 为什么对我们重要 | 状态 |
|---|---|---|---|
| 1 | **本地核心可以放在 Go 侧** | Wails 的 Go 后端能直接跑真正的 SQLite（纯 Go 驱动、免 cgo），通过 bindings 给 Vue 用。这**彻底删掉**了 Tauri 方案里最麻烦的一块：浏览器内 WASM SQLite + OPFS + SharedArrayBuffer + COOP/COEP 响应头 + 存储配额治理 | 需 task-6 确认驱动选型 |
| 2 | **Web 版可能用同一份代码** | Wails v3 提供 server builds：同一个应用与服务以纯 HTTP 服务形式运行、无原生窗口。若成立，Web 版不再是另写一套，而是同一份 Go 服务 + 同一份 Vue 前端 | **待 task-4 核实**（本轮最关键的一条） |
| 3 | **构建发布开箱即用** | 签名、NSIS/MSIX、DMG、AppImage/deb/rpm、内置 updater（含加密校验与回滚）都是官方能力；Tauri 方案要自己拼插件 | 官方发布说明已证实 |
| 4 | **少一门工具链** | 不需要 Rust；你本机目前 Node 24 已有，Rust 与 pnpm 都没装 | 需你确认接受 Go |

> 一个反直觉提醒：选 Wails **不等于**语言变少，反而可能变多 —— 若外壳是 Go、后端仍是 TypeScript、前端也是 TypeScript，我们就要同时维护 Go 与 TS 两套服务端逻辑（其中同步合并逻辑最容易分叉）。这恰恰是我现在倾向「后端也用 Go」的原因，详见第 4 节。

---

## 3. 三个必须补偿的风险 + 工程闸门

### 闸门 G1：移动端可用性（Go / No-Go，M1 第一件事，早于任何业务代码）

- **风险**：Wails v3 官方把 iOS/Android 标注为 experimental，明确不在稳定性承诺内。
- **动作**：写一个最小 Spike（不是产品代码）：Wails v3 空应用 → 用 foliate-js 渲染一个真实 EPUB 样本 → 分别构建 **iOS 与 Android 真机包**。
- **判据（全过才算过）**：① 两端都能打开书并翻页；② 中低端安卓机（含 **Onyx Boox 类 e-ink 设备**）不白屏；③ 能读写本地 SQLite；④ 能保持阅读进度并同步。
- **失败预案（按优先级）**：① 移动端改 **PWA**（同一份 Vue 代码，牺牲部分原生能力）；② 移动端延后，先交付 Web + 桌面；③ 仅移动端换原生双栈（Readium Swift/Kotlin）。**不做**两个壳混用（Wails 桌面 + Tauri 移动），维护成本会吃掉全部收益。
- **时间盒**：2–3 天。**建议你批准的第一笔投入，先于任何架构搭建。**

### 闸门 G2：不可信 EPUB 的隔离（M1 验收项，有失败判据）

- **风险**：Wails v3.0.0 的 Known limitations 明确写着：所有平台上子 frame 的绑定方法调用走 HTTP 到 /wails/runtime，守卫不限制它们；Android 上 window.wails 对所有 frame 暴露（修复计划排在 3.0.1，**是否已修复待 task-4 核实**）。而阅读器的本质就是把不可信 EPUB 渲染进 iframe。
- **动作（纵深防御，四层）**：
  1. 书籍 HTML/CSS **消毒**（去掉 script / on* 事件 / javascript: / foreignObject 等）；
  2. 渲染在 **独立 origin** 的 frame 中，sandbox 属性**不授予 allow-same-origin**（即 opaque origin）；
  3. 该 frame 的 CSP：禁脚本、**禁一切远程请求**（只允许 blob: / data: 的图片与字体）；
  4. 原生桥调用要求**主 frame 独享的会话 token**（子 frame 受同源策略限制，读不到父窗口变量，因而拿不到 token）。
- **判据**：从书本 iframe 内部尝试（a）调用任意绑定方法、（b）读写本地 SQLite、（c）发起远程请求、（d）注入到主 frame，**必须全部失败**。
- **失败预案**：书籍内容改为**独立窗口或独立 WebView 实例**渲染（牺牲内嵌排版的便利），或改用非 Wails 的原生渲染承载正文。

### 闸门 G3：WebView 碎片化（与外壳选型无关）

- **风险**：系统 WebView 版本过旧导致白屏，命中 e-ink 阅读器与部分国产 ROM。
- **动作**：并入 G1 的 Spike 一起测；同时调研 Android 上是否有 WebView 升级路径。
- **说明**：这条不是选 Wails 造成的，选 Tauri 同样要面对，因此不构成改回 Tauri 的理由。

---

## 4. 语言栈收敛策略（重要）

| 方案 | 组成 | 评价 |
|---|---|---|
| X | Go（外壳）+ TS（前端）+ TS（后端） | 两门语言，但**同步与合并逻辑会出现 Go 与 TS 两份实现**。Readest 的最大教训就是两份合并实现必须同构，这是长期维护负担 |
| **Y（我倾向）** | **Go（外壳 + 本地核心 + 后端）** + TS（前端） | 仍只有两门语言，且 **HLC、合并、定位核心是同一个 Go 包**，桌面、移动、服务端三处共用，测试只写一遍 |
| Z | Go（外壳）+ TS（前端）+ Go（后端）+ Python（AI 侧车） | 若 RAG 需要 Python 生态再叠加，属后期可选，不进 v1 |

> 关键前提：**浏览器里跑不了 Go**。因此 Web 版要么走「在线优先、服务端权威合并」（我倾向，代价是 Web 端离线能力弱），要么在 TS 里再实现一遍合并逻辑（正是 X 方案被否的理由）。最终结论由 task-6 给出。

---

## 5. 因本次决策必须重做的设计（清单）

| 文档/章节 | 要改什么 | 状态 |
|---|---|---|
| TECH-PLAN 2 选型总表 | 跨端壳改 Wails v3；前端改 Vue 3 + Vite；本地 DB 改 Go 侧 SQLite；后端语言待定 | 待 task-4 / task-6 回填 |
| TECH-PLAN 3.1 代码库组织 | 目录结构改为 Go + Vue；bindings 与 platform 抽象层的位置 | 待 task-5 |
| TECH-PLAN 3.2 跨端策略 | 三个宿主改为 Wails 桌面 / Wails 移动(experimental) / Wails server build（或独立 Web 前端） | 待 task-4 |
| TECH-PLAN 3.4 本地数据层 | **大改**：删除 wa-sqlite / OPFS / SharedArrayBuffer 路线，改为 Go 侧 SQLite + bindings | 待 task-6 |
| TECH-PLAN 3.3 渲染层 | foliate-js 部分不变；新增「Vue 响应式 Proxy 与命令式库冲突」的工程约定 | 待 task-5 |
| TECH-PLAN 7 安全与合规 | 恶意电子书一行已升级为硬门槛；再补桥 token 校验 | 部分完成 |
| TECH-PLAN 9 里程碑 | M1 前置插入 G1 Spike（2–3 天）与 G2 PoC | 本轮可完成 |
| ADR-001 | 标注两条推荐被 ADR-002 取代，证据保留 | 本轮完成 |

---

## 6. 环境前置条件（开工前需要装）

| 工具 | 状态 | 说明 |
|---|---|---|
| Go | **未装** | Wails v3 要求 **Go 1.26+**（官方发布说明） |
| Node.js 24 | 已有 v24.20.0 | 够用 |
| pnpm | **未装** | monorepo 需要；也可用 npm workspaces 起步 |
| Rust | 不再需要 | 选 Wails 后省掉 |
| Docker | 已有 28.3.3 | 后端部署用 |
| Python 3.12 | 已有 | 仅作可能的 AI 侧车 |

---

## 7. 复评触发条件

| 触发 | 动作 |
|---|---|
| G1 移动端 Spike 失败且 PWA 不可接受 | 重新评估外壳（回 Tauri，或移动端原生双栈） |
| G2 隔离 PoC 失败且 token 方案无效 | 书籍内容改独立窗口渲染，或重评外壳 |
| task-4 证实 server build 不能用于多用户 Web 部署 | Web 端退回「独立前端 + Go/TS 后端」两套产物，工作量上调 |
| 你不接受维护 Go 代码 | 立即重评：退回 Tauri + Vue（需 Rust 工具链），或接受 X 方案的两份合并实现 |

---

## 8. 证据来源

| 结论 | 来源 | 日期 |
|---|---|---|
| Wails v3.0.0 GA；iOS/Android 为 experimental 且不在稳定性承诺内；iframe 限制条款；内置 updater/签名/安装器；存在 server builds | https://github.com/wailsapp/wails/releases/tag/v3.0.0 | 发布 2026-10-26，访问 2026-11-02 |
| Wails 要求 Go 1.26+ | 同上（Install 与 Requirements 段） | 同上 |
| Tauri 2.0 stable 含移动端（对照保留） | https://v2.tauri.app/blog/tauri-20/ | 发布 2024-10-02 |
| foliate-js 为 MIT、自称 unstable、无 release | https://github.com/johnfactotum/foliate-js | 访问 2026-11-02 |

> 未验证项：Wails server build 在多用户生产场景的可用性、移动端真机表现、/wails/runtime 的 Origin 校验现状、Go 侧 SQLite 驱动对移动端的适配 —— 分别由 task-4 / task-6 / G1、G2 闸门解决。
