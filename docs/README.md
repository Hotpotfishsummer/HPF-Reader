# HotPotFish Reader（HPF-Reader）— 前期调研与方案文档

> 阶段：**方案评审中（未开工）** ｜ 日期：2026-11-02
> 本阶段只产出调研与设计文档，**没有初始化任何工程、没有写一行业务代码**。

---

## 1. 先看这三份（按顺序）

| # | 文档 | 是什么 | 行数 |
|---|---|---|---|
| 1 | [DESIGN.md](docs/DESIGN.md) | **产品设计方案**：目标与范围、竞品矩阵、Readest 事实基线、功能清单与 P0/P1/P2、信息架构、横竖屏适配矩阵、关键流程、里程碑、风险 | 362 |
| 2 | [TECH-PLAN.md](docs/TECH-PLAN.md) | **技术方案（前端 + 后端）**：总体架构、选型总表与理由、monorepo 结构、渲染层、本地数据层、后端模块、**数据模型 DDL**、**同步引擎（HLC + 冲突规则 + 游标）**、AI 网关、书源引擎、API 草案、部署备份、测试、排期 | 701 |
| 3 | [OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | **需要你拍板的 9 个问题**（每题给推荐项与影响），含快速回复模板 | 152 |
| 4 | [ADR-002-客户端落地-Vue与Wails.md](docs/ADR-002-客户端落地-Vue与Wails.md) | **当前生效的决策**：Vue 3 + Wails v3 落地；含 4 项红利、3 个风险闸门（G1 移动端 Spike / G2 隔离 PoC / G3 WebView 碎片化）、语言栈收敛策略 | 105 |
| 5 | [ADR-001-客户端选型.md](docs/ADR-001-客户端选型.md) | 决策记录（已被取代，证据保留）：React vs Vue、Tauri v2 vs Wails v3 的对比与证据 | 130 |
| 6 | [ADR-003-内容隔离架构.md](docs/ADR-003-内容隔离架构.md) | **当前唯一阻塞项**：Wails 桥零校验 + foliate-js 默认最弱 sandbox 导致的越权通路；四套隔离方案 A/B/C/D 与待你批准 2–3 天 Spike | 95 |

## 2. 调研证据（三份独立调研，全部标注来源与日期）

| 文档 | 覆盖 | 行数 |
|---|---|---|
| [10-client-frontend.md](docs/research/10-client-frontend.md) | 客户端/跨端框架横评、Tauri v2 移动端真实成熟度、渲染引擎、Readest 技术栈核实、构建发布链路 | 807 |
| [20-backend-sync.md](docs/research/20-backend-sync.md) | 后端栈横评、Readest 同步后端一手核实、Readium Locator、KOReader kosync、冲突方案、DDL/API 草案、部署运维、成本 | 1170 |
| [30-formats-zlib-llm.md](docs/research/30-formats-zlib-llm.md) | 逐格式解析库 + 许可证矩阵、Z-Library 技术路径与合规风险、LLM 翻译/实体归一化/RAG、成本与分期 | 497 |

---

## 3. 三份调研里最值钱的 7 条结论

1. **Readest 是 AGPL-3.0，但它的渲染内核 foliate-js 是 MIT。** 复用 MIT 内核合规，抄 Readest 代码会传染 —— 这决定了 Q4 的答案空间。
2. **foliate-js 并不"成熟"**：上游 README 自称 not stable、无 release、约 6 个月未提交，npm 上同名包是别人发的假包。→ 必须 **fork 自持 + 固定 commit**，并自建格式回归集。
3. **不存在 readest-supabase 这个仓库**（GitHub org/API 均 404）。Readest 的同步后端实际内联在主仓库（`docker/volumes/db/*` + `src/pages/api/sync*` ），所以网上任何"抄它表结构"的说法都不可靠；我们的方案建立在一手文件上。
4. **同步的两个致命细节**（Readest 真踩过的坑）：① 增量游标必须**服务端分配**，用客户端 updated_at 当游标会导致"合并过的行永远同步不到"（issue #4678）；② 阅读进度**不是取最大值**，正确语义是"同文件按时间可回退、跨副本只按百分比前移"。
5. **Tauri v2 移动端能用但有硬风险**：旧版 Android WebView（83–99）白屏，受影响的正是 **Onyx Boox 等 e-ink 阅读器**和部分国产 ROM —— 这正对阅读器的核心用户群。→ 方案里把它设成 **M2 的 Go/No-Go 决策点**。
6. **Z-Library 技术上完全可接，但合规上不可内置**：建议一期只内置合法书源（Gutenberg / Standard Ebooks / Open Library / IA / OPDS），通用书源接口列为"需法务确认"的备选。
7. **LLM 成本远低于直觉**：按 DeepSeek 官方价，**100 万字符整书翻译约 $0.24–$3.96 一次**；瓶颈是输出 token 与重试，不是输入。真正的技术难点是**人名/术语译名一致性**（同一人物三个名字），方案给出了 L1–L5 五层流水线，核心思路是"**LLM 只做裁定，不做发现**"。

---

## 4. 我推荐的技术路线（三句话）

1. **一份 TypeScript/React 代码库**，通过 **Tauri v2** 跑桌面与 Android/iOS、通过浏览器跑 Web —— 不为每个平台写一遍界面。
2. **渲染不自研**：用 **foliate-js（MIT，自持 fork）+ pdf.js（Apache-2.0）**，把力气花在排版体验和 AI 上，而不是重复造解析器。
3. **离线优先 + 自托管后端**：客户端本地 SQLite 是真相源，服务端只做复制与裁决；后端 **TypeScript + PostgreSQL + MinIO + Redis** 的单机 Docker Compose 起步，用**服务端游标 + HLC 字段级 LWW** 保证多设备收敛。

---

## 5. 下一步：需要你回答 9 个问题

打开 [OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)，其中最关键的是这 4 个：

| 问题 | 为什么它最重要 |
|---|---|
| **Q1 服务器规格**（CPU/内存/磁盘/带宽/能否 Docker/域名/所在地） | 直接决定后端能不能用 Postgres + 对象存储，还是必须降级 |
| **Q4 代码策略**（fork Readest / 参考架构自研 / 混合） | 决定项目是否必须 AGPL 开源，以及工作量差 6–9 人月 |
| **Q5 Z-Library**（不做 / 只做插件接口 / 内置） | 法律与商店审核风险的最终承担者是你，我不能替你选 |
| **Q6 平台优先级**（先 Web / 先桌面 / 先移动） | 决定前 3 个月先交付什么 |

---

## 6. 证据强度声明

- 所有关键结论均附来源链接与抓取日期（2026-11-02）。
- 抓不到一手来源的一律标注 **「未验证」**，三份调研共列出 30+ 条未验证项，**没有编造任何仓库名、字段名、版本号或价格**。
- 关于「Legado 作者因分享书源被判刑」：知乎原页返回 403、**未取得任何裁判文书**，故在文档中标注为 **「未核实传闻，不得作为事实引用」**；仅采用可核实的方向性证据（Legado 官网自述 Google Play 版已下架）。**但风险结论不依赖该传闻。**
- 调研中的对比评分（如跨端框架加权分）是研究员的**主观判断**，不是实测；包体、帧率、跨引擎渲染一致性均**未实测**。
---

## 7. 开发阶段新增（2026-11-02 起）

决策变更后新增的文档与工程文件：

| 文件 | 内容 |
|---|---|
| [ADR-002-客户端落地-Vue与Wails.md](ADR-002-客户端落地-Vue与Wails.md) | **生效决策**：Vue 3 + Wails v3 落地，含 3 个风险闸门与语言栈收敛策略 |
| [ADR-003-内容隔离架构.md](ADR-003-内容隔离架构.md) | **核心**：Wails 桥零校验 + foliate-js 默认最弱 sandbox 的越权通路；L1–L5 定案；Arch-A 判死 |
| [research/40-wails-v3.md](research/40-wails-v3.md) | Wails 版本线、移动端定位、Server 构建、22 条补偿清单 |
| [research/50-vue3-reader-stack.md](research/50-vue3-reader-stack.md) | Vue 3 全栈选型与 foliate-js 集成铁律 |
| [research/60-webview-security-backend-lang.md](research/60-webview-security-backend-lang.md) | 源码级威胁模型、20 条 M1 安全 PoC、后端语言评估 |
| [research/70-isolation-feasibility.md](research/70-isolation-feasibility.md) | 隔离可行性核实（Arch-A 判死、CSP 可行性、两个生死门） |
| [MOBILE-PLATFORM-NOTES.md](MOBILE-PLATFORM-NOTES.md) | **移动端现实**：Android 可构建（需 gomobile）；**iOS 在 Windows 上无法构建** |
| [../api/openapi.yaml](../api/openapi.yaml) | 唯一跨端契约（16 路径 / 21 schema） |
| [../README.md](../README.md) | 仓库总览与本机环境（Go / wails3 / pnpm 的确切路径） |

**当前阶段**：开发中。已完成方案冻结与三项工具链准备（Go→1.26 自动切换、wails3 v3.1.0、Docker 已启动、gomobile 已装）。

三个并行开发流：`apps/server`（Go 服务端 + Docker）、`apps/client`（Wails v3 + Vue 3）、`spikes/isolation`（G2 隔离 PoC）。
