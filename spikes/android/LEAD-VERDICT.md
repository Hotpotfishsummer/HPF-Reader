# Lead 独立复核：WebView 91 上的真书可读性判定

> 复核时间 2026-11-03 17:35 (Asia/Shanghai)；复核人 Lead；环境：`emulator-5554`（Android 12 / API 31 / **Chrome/91.0.4472.114**）
> APK：`apps/client/bin/hpfreader-android-debug.apk`，22,544,722 B，sha256 `490D0353BBD2C3D984F2A13286089197FDC8B41B70D3A04D995FBB5ACC0B40A8`
> 真书：`testdata/books/frankenstein.epub`，294,175 B，sha256 `bf04d57c…b662`，**31 章 / 38 条目 / deflate 压缩**

## 结论（与 mobile-dev 的 §3.2 相反）

**WebView 91 上真书可以正常阅读**：能打开、能渲染正文、能翻页、能跳章、横竖屏都出正文。

mobile-dev 判定「真书读不了」的两条依据都不成立：

| 它的依据 | 实际情况 |
|---|---|
| `iframes=0` | **测量假象**。`vendor/foliate-js/view.js:214` 用 `attachShadow({ mode: 'closed' })`，closed shadow root **故意不可被外部访问**，所以 `querySelectorAll('iframe')` 恒为 0。这与渲染成功/失败无关。 |
| 「正文空 / 0%」 | 它测的是**封面页**（fraction≈0.0009），封面本身就是大字号书名、`innerText` 很短；再加上 `@layer` 失效导致 `foliate-view` 被撑到 1482px（视口 843px），可视区只露出封面一角。**不是没渲染，是没滚动到正文。** |

## 判定性证据（原始输出）

### 1. 真书成功打开（封面页）
```json
STATE: {"hash":"#/reader/bf04d57cf243314a","bodyText":"←☰阅读0% ◐‹›",
  "view":{"hasBook":true,"hasRenderer":true,
    "lastLoc":{"fraction":0.0009081121170811464,"cfi":"epubcfi(/6/2!/4/2,,/2)"}}}
EVENTS: none   // 无任何 JS 异常
```

### 2. 连续翻页（fraction 与 CFI 同步前进）
```
INITIAL:      fraction=0.0009  cfi=epubcfi(/6/2!/4/2,,/2)
AFTER_NEXT_1: fraction=0.0035  cfi=epubcfi(/6/4!/4/2[pg-header],,/8[pg-start-sep…
AFTER_NEXT_2: fraction=0.0061  cfi=epubcfi(/6/4!/4,/4,/12)   bodyText 出现 "or, the Modern Prometheus"
EXC: none
```

### 3. 跳章成功（Chapter 10）
```json
JUMP_RESULT: {"tocCount":32,"tocLabels":["Frankenstein;","or, the Modern Prometheus","CONTENTS","Letter 1","Letter 2"],
  "target":"Chapter 10","afterFrac":0.3858,
  "afterCfi":"epubcfi(/6/34!/4/2[pgepubid00016],/2,/6/1:113","rendererType":"ge"}
EXC: none
```
→ **32 项目录全部解析出来**，跳到 Chapter 10 后 fraction 到 **0.3858（39%）**。

### 4. 视觉确认（截图，肉眼可见真实排版）
| 文件 | 内容 |
|---|---|
| `12-realbook-webview91-portrait.png` | 竖屏封面：`Frankenstein; or, the Modern Prometheus / by Mary Wollstonecraft (Godwin) Shelley` |
| `13-realbook-webview91-landscape.png` | 横屏同一页，正文居中 |
| `15-realbook-webview91-chapter10.png` | **竖屏 Chapter 10 正文整段**（"I spent the following day roaming through the valley…"），工具栏显示 `Chapter 10 39%` |

## 但 CSS 问题是真的（这部分 mobile-dev 完全正确）

同一份测量（`cdp-css.mjs` 原始输出）：
```json
{"supportsLayer":false, "layerProbe":0,
 "sheetCount":1, "topLevelRules":66, "layerBlockRules":0,
 "buttonBorderRadius":"0px", "buttonBg":"rgb(239, 239, 239)",
 "bodyFont":"sans-serif", "bodyBg":"rgba(0, 0, 0, 0)",
 "fvHeight":"1482px", "innerH":843}
```

- `@layer`（Chrome **99+**）不被支持 → Tailwind v4 输出的 `@layer` 规则**整块被丢弃** → 66 条顶层规则里 layer 块 = **0** → **整份样式表失效**。
- 视觉后果：工具栏是**无样式的原生按钮**（截图可见），书库是裸 HTML 链接（mobile-dev 的 `13-library-webview91-unstyled.png` 为证）。
- `foliate-view` 被撑到 **1482px**（视口 843px）→ 容器塌陷，正文被推到可视区之外（这正是「看起来没内容」的直接原因）。

## 判定：功能可用，观感不可交付

| 维度 | WebView 91 | WebView 124 |
|---|---|---|
| 打开真书 / 渲染正文 | ✅ | ✅ |
| 翻页 / 跳章 / 目录 | ✅ | ✅ |
| **UI 样式** | ❌ `@layer` 失效，裸 HTML | ✅ 完整 |
| 布局高度 | ❌ 1482px 溢出 843px | ✅ 正常 |

→ **要「Android 可用」，必须修 `@layer`（可交付性问题）；`@container` 只影响分栏精细度，可次要处理。**

## 复核方法（可重复）

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$pid1 = (& $adb -s emulator-5554 shell 'pidof com.wails.app').Trim()
& $adb -s emulator-5554 forward tcp:9333 localabstract:webview_devtools_remote_$pid1
node spikes/android/cdp-css.mjs      # CSS 能力与布局测量
node spikes/android/cdp-jump.mjs     # 目录 + 跳章
```

> 真书预置方法：按 `apps/client/libraryservice.go` 的存储布局，把 `books/<sha256[0:16]>.epub` 与 `library.json` 写进 `files/HPFReader/`。
> `run-as` 读不到 `/sdcard`，需先把文件 base64 到 `/data/local/tmp/` 再在 `run-as` 内解码。

## 给后续的教训

1. **不要用 `iframes=0` 判断 foliate 是否渲染**——closed shadow root 下永远看不到。判据应该是「`lastLocation.fraction` 是否变化」+「截图是否出正文」。
2. **不要在设备上装过诊断包之后直接下结论**。store-only 诊断 APK 不含 deflate 兜底，会给出假阴性；测前先核对 APK 大小与 polyfill 日志。
