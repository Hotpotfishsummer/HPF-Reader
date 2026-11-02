# scratch/ —— 一次性诊断脚本（不属于交付物）

这里的东西**不是产品代码，也不是验收证据**。它们是排查过程中写的一次性脚本，
留着只为了「这条结论当初是怎么得出的」还能被复核。

**阅读验收结论请看 `../RESULTS.md`，原始输出请看 `../evidence/`。**

## go-probes/ —— APK ZIP 结构与大小核算

用途：查清「旧 APK 22,544,722 B 里为什么有 7.9 MB 对不上账」。

| 文件 | 作用 |
|---|---|
| `ziplist.go.txt` | 列 `lib/` 条目与压缩/未压缩大小 |
| `ziplist2.go.txt` | 加打印 top-N 与 STORE 条目统计 |
| `zipdiff.go.txt` | 对比两个 APK 的条目差异（找出只在新包里的 arm64） |
| `zipspan.go.txt` / `zipspan2.go.txt` / `zipspan3.go.txt` | 定位 EOCD、算 APK Signing Block 大小 |
| `scanlfh.go.txt` | 顺序走 local file header，统计实际条目数 |
| `lfhcount.go.txt` | **关键**：对比 LFH 数 vs central directory 数 → 发现 1002 vs 882 |
| `sigblock.go.txt` | 解析 APK Signing Block magic |
| `zipaccount.go.txt` | 逐条累加核算总大小（这条没跑通，留作记录） |

**结论（已写进 RESULTS.md）**：旧 APK 有 **1002 个 local file header 但只有 882 个 central directory 条目**，
即 120 个增量构建遗留的孤儿条目。`gradlew clean assembleDebug` 后降到 891/883，
APK 从 22,777,553 B → 22,394,587 B。**发布前应始终 clean。**

> 用法：这些是 `.go.txt` 后缀（避免被 `go build ./...` 扫到）。要跑就复制成 `.go` 再 `go run`。

## cdp-oneoffs/ —— 早期的一次性 CDP 驱动变体

`../cdp.mjs` 是**收敛后的正式工具**（`list/eval/text/probe/rect/click/findtext/tap/hash/shot/watch/preloadrun`），
请一律用它。这里的 16 个 `cdp-*.mjs` 是它收敛之前一个个临时写的版本，功能已被 `cdp.mjs` 的子命令覆盖。

## js-probes/ —— 注入到 WebView 里跑的一次性探针

| 文件 | 作用 | 是否影响产品 |
|---|---|---|
| `probe.js` | 通用页面状态探针 | 只读 |
| `book-detail.js` | 读 `foliate-view` 的 `book`/`toc`/`lastLocation` | 只读 |
| `view-api-probe.js` | 探测 `foliate-view` 公开 API | 只读 |
| `verify-three.js` | 批量验证三本真书 | 只读 |
| `goto-chapter.js` | 调 `foliate-view.goTo()` 跳章 | 只读 |
| `list-assets.js` / `list-exports.js` | 列已加载 chunk 及其导出，用于找 bindings | 只读 |
| `css-nesting-probe.js` | 测 CSS 嵌套 `&` / `@container` 支持 | 只读 |
| **`flatten-layers.js`** | **诊断 `@layer` 假设**：运行时把 `@layer` 块摊平后重注入 | 仅当前页面，不落盘 |

> ⚠️ `flatten-layers.js` 是**诊断用**的：它证明 `@layer` 是根因，但**不是修复方案**。
> 真正的修复在构建链（`@csstools/postcss-cascade-layers`，见 task-17）。
> 这两个脚本**没有**、也不应该进入产品代码。

## 保留在上一层的两个

- `../cdp.mjs` —— 正式 CDP 驱动，`RESULTS.md` §7 引用了它。
- `../polyfill-es2024.js` / `../errorhook.js` —— 早期诊断注入，`RESULTS.md` 有引用。
  （`polyfill-es2024.js` 已被 client-dev 的正式 `src/compat/polyfills.ts` 取代，此处仅作存证。）