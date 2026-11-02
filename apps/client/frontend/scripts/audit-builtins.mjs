#!/usr/bin/env node
/**
 * ★ 老旧 WebView 兼容性审计（task-14）。
 *
 * 打包器只降**语法**，不会 polyfill **运行时内置对象**。Android 实测 WebView
 * 是 Chromium 91，而 foliate-js 用了 Chrome 117 才有的 Object.groupBy、
 * Chrome 97 才有的 findLastIndex —— 这类问题只能靠"扫一遍实际用到的内置 API，
 * 再对照最低浏览器版本"来发现。
 *
 * 用法：
 *   node scripts/audit-builtins.mjs                    # 扫 src/
 *   node scripts/audit-builtins.mjs dist               # 扫构建产物（更接近真实发货内容）
 *   node scripts/audit-builtins.mjs src --chrome 91
 *
 * 退出码：只要存在"低于基线且没有 polyfill 且不在豁免清单里"的 API 就返回 1，可直接进 CI。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const [, , targetArg = 'src', ...rest] = process.argv
const chromeIndex = rest.indexOf('--chrome')
const BASELINE = chromeIndex >= 0 ? Number(rest[chromeIndex + 1]) : 91

/**
 * 已安装 polyfill 的模块**本身**当然会提到这些 API 名字（定义、文档表格、安装调用）。
 * 审计的目的是"业务/上游代码有没有裸用"，所以把修复层自己排除掉。
 */
const POLYFILL_DIR = path.join('src', 'compat')

/**
 * 行级豁免：已知的**假阳性**，必须写明原因，且必须精确到行号。
 * 行号一旦漂移就会立刻重新报出来 —— 这正是我们想要的效果（避免"整文件忽略"掩盖真问题）。
 */
const ALLOWLIST = [
  {
    pattern: 'Promise.try',
    fileSuffix: path.join('vendor', 'foliate-js', 'epub.js'),
    line: 782,
    reason: '只是注释 NOTE: this can be replaced with Promise.try()，没有真的调用',
  },
]

/**
 * 每个条目：min = 该 API 进入 Chrome 稳定的版本；polyfill = src/compat/polyfills.ts 是否已补齐。
 */
const CHECKS = [
  { name: 'Object.groupBy', pattern: /Object\s*\.\s*groupBy/g, min: 117, polyfill: true, note: 'ES2024；foliate-js epub.js 解析 metadata 用' },
  { name: 'Map.groupBy', pattern: /Map\s*\.\s*groupBy/g, min: 117, polyfill: true, note: 'ES2024；foliate-js epub.js 用' },
  { name: 'Promise.withResolvers', pattern: /Promise\s*\.\s*withResolvers/g, min: 119, polyfill: true, note: 'pdf.js 用' },
  { name: 'Promise.try', pattern: /Promise\s*\.\s*try\b/g, min: 128, polyfill: true, note: 'pdf.js 用；epub.js:782 只是注释' },
  { name: 'Array.prototype.with', pattern: /\.with\s*\(/g, min: 110, polyfill: true, note: 'ES2023 不可变数组方法；Vue 响应式数组插桩会调' },
  { name: 'Array.prototype.toSorted', pattern: /\.toSorted\s*\(/g, min: 110, polyfill: true, note: 'ES2023；Vue 插桩/deps 会调' },
  { name: 'Array.prototype.toReversed', pattern: /\.toReversed\s*\(/g, min: 110, polyfill: true, note: 'ES2023；Vue 插桩/deps 会调' },
  { name: 'Array.prototype.toSpliced', pattern: /\.toSpliced\s*\(/g, min: 110, polyfill: true, note: 'ES2023；Vue 插桩/deps 会调' },
  { name: 'Array.prototype.findLast', pattern: /\.findLast\s*\(/g, min: 97, polyfill: true, note: 'pdf.js 用' },
  { name: 'Array.prototype.findLastIndex', pattern: /\.findLastIndex\s*\(/g, min: 97, polyfill: true, note: '★ foliate-js paginator.js:1089 分页必挂' },
  { name: 'Array.prototype.at', pattern: /\.at\s*\(/g, min: 92, polyfill: true, note: 'foliate-js epub.js / epubcfi.js；含非数组误报，需人工确认' },
  { name: 'String.prototype.at', pattern: /String\.prototype\.at/g, min: 92, polyfill: true, note: '与上一条成对补齐' },
  { name: 'structuredClone', pattern: /structuredClone/g, min: 98, polyfill: true, note: 'zip.js 能力探测' },
  { name: 'Object.hasOwn', pattern: /Object\s*\.\s*hasOwn/g, min: 93, polyfill: true, note: 'ES2022；vue-router/pinia/@vueuse 真的在用' },
  { name: 'String.prototype.replaceAll', pattern: /\.replaceAll\s*\(/g, min: 85, polyfill: false, note: 'foliate-js 用；91 已支持' },
  { name: 'Object.fromEntries', pattern: /Object\s*\.\s*fromEntries/g, min: 73, polyfill: false, note: '91 已支持' },
  { name: 'String.prototype.matchAll', pattern: /\.matchAll\s*\(/g, min: 73, polyfill: false, note: '91 已支持' },
  { name: 'Array.prototype.flatMap', pattern: /\.flatMap\s*\(/g, min: 69, polyfill: false, note: '91 已支持' },
  { name: 'Promise.allSettled', pattern: /Promise\s*\.\s*allSettled/g, min: 76, polyfill: false, note: '91 已支持' },
  { name: 'WeakRef', pattern: /\bWeakRef\b/g, min: 84, polyfill: false, note: '91 已支持' },
  { name: 'FinalizationRegistry', pattern: /\bFinalizationRegistry\b/g, min: 84, polyfill: false, note: '91 已支持' },
  { name: 'crypto.randomUUID', pattern: /randomUUID/g, min: 92, polyfill: true, note: 'platform/server.ts 用' },
  { name: 'AbortSignal.timeout', pattern: /AbortSignal\s*\.\s*timeout/g, min: 103, polyfill: true, note: 'api/client.ts 用' },
  { name: 'URL.canParse', pattern: /URL\s*\.\s*canParse/g, min: 120, polyfill: false, note: 'ES2023' },
  { name: 'RegExp.escape', pattern: /RegExp\s*\.\s*escape/g, min: 136, polyfill: false, note: 'ES2025' },
  { name: 'Set.prototype.union', pattern: /\.union\s*\(/g, min: 122, polyfill: false, note: 'ES2025' },
  { name: 'Array.fromAsync', pattern: /Array\s*\.\s*fromAsync/g, min: 121, polyfill: false, note: 'ES2024' },
  { name: 'Uint8Array base64', pattern: /fromBase64|toBase64/g, min: 133, polyfill: true, note: 'ES2025；pdf.js 内联图片/签名用' },
  { name: 'CompressionStream', pattern: /\bCompressionStream\b/g, min: 80, polyfill: false, note: 'zip.js；91 已支持' },
  { name: 'Intl.Segmenter', pattern: /Intl\s*\.\s*Segmenter/g, min: 87, polyfill: false, note: '91 已支持' },
  { name: 'RegExp d flag', pattern: /hasIndices|\)\s*\/d[gimsuy]*[\s,;)]/g, min: 90, polyfill: false, note: 'hasIndices；91 已支持' },
]

/**
 * ★ Web API **格式支持**能力（不是 builtin，是"存在但能力不全"的一类）。
 *
 * 之前漏了这一类：`DecompressionStream` 在 Chrome 91 上**存在**，
 * 但 `'deflate-raw'` 格式要到 Chrome 103 才支持 —— 静态扫描扫不出这种"半残"能力，
 * 只能在运行时用 `new DecompressionStream('deflate-raw')` 探测。
 * 这里列出来，让审计报告把"运行时必须探测的能力"和"静态扫描出的 API"分开呈现。
 */
const RUNTIME_CAPABILITIES = [
  {
    name: "DecompressionStream('deflate-raw')",
    min: 103,
    probe: "new DecompressionStream('deflate-raw')",
    why: 'ZIP 压缩方法 8 存的是裸 deflate；缺它则**真实 EPUB 全部打不开**（示例书是 STORE 才没事）',
    handled: 'src/compat/polyfills.ts 的 DecompressionStream 兜底（复用 vendored fflate）',
  },
  {
    name: "CompressionStream('deflate-raw')",
    min: 103,
    probe: "new CompressionStream('deflate-raw')",
    why: 'ZIP 写入时才需要；我们只读不写，不阻塞阅读',
    handled: '不处理（只读场景不需要）',
  },
  {
    name: 'DecompressionStream 存在性',
    min: 80,
    probe: 'typeof DecompressionStream',
    why: 'zip.js 解压入口；91 上存在',
    handled: '91 原生就有',
  },
]

/**
 * ★ CSS 能力门禁（task-14 追加项）。
 *
 * 这一类**静态扫描源码扫不出来**：我们自己的 .css/.vue 里没有任何现代语法，
 * 但 **Tailwind v4 在构建产物里**把全部样式包进 `@layer`（Chrome 99+）。
 * 源码干净、产物有毒 —— 只有扫**构建产物**才能发现。
 *
 * 在 WebView 91 上 `@layer` 块会被**静默丢弃**（不报错），
 * 于是 `.absolute`/`.flex`/`.h-full` 全部失效 → 阅读器容器塌掉 →
 * 真书渲染不出正文（iframeCount=0）。修法是构建期展平（vite 插件）。
 *
 * 因此这里对 `dist/assets/*.css` 做产物级校验：**必须为 0**。
 */
const CSS_CAPABILITIES = [
  {
    name: '@layer（层叠层）',
    min: 99,
    // 注意：必须排除 `.\\@container` 这类**转义后的类名**，否则会误判。
    // at-rule 只出现在规则边界（开头 / }` 之后 / ;` 之后）。
    pattern: /(?:^|[};])@layer/,
    // 这一条是**硬门禁**：命中即失败。
    blocking: true,
    why: 'Tailwind v4 把整份样式表包进 @layer；91 上整块被静默丢弃 → 全部工具类失效、整份样式表作废',
    handled: 'vite.config.ts 用官方 @csstools/postcss-cascade-layers 在构建期扁平化（保留 Tailwind v4）',
  },
  {
    name: '@container（容器查询）',
    min: 105,
    pattern: /(?:^|[};])@container\s*[({]/,
    // 次要项：只影响 paginator 分栏精细度，不影响可读 → 记录但不算失败。
    blocking: false,
    // 这条规则其实在 paginator 的 **shadow DOM JS 模板串**里，不在 dist CSS 里 ——
    // 所以 dist 扫到 0 是正常的，真正要扫的是 vendor 的 paginator.js。
    jsTarget: 'src/vendor/foliate-js/paginator.js',
    // JS 里 at-rule 前面是行内缩进（不是 } 或 ;），需要单独的宽松模式
    jsPattern: /@container\s*[({]/,
    jsMin: 105,
    why:
      'paginator 用 @container(orientation:portrait) 在竖屏把 --_max-column-count-spread 切成 portrait 值（1 栏）；' +
      '91 上不生效，spread 退回 var(--_max-column-count)',
    handled:
      '不影响结果：我们的 useReaderLayout 已按**同一个方向逻辑**算出栏数（竖屏 1 / 横屏 2）并设 max-column-count 属性，' +
      '而 spread 默认就是 var(--_max-column-count)，所以缺失 @container 时值**恰好相同**',
  },
  {
    name: 'CSS 嵌套（&）',
    min: 120,
    pattern: /&\s*[.:\[>]/,
    blocking: false,
    why: 'paginator 的 &.vertical 等嵌套规则；不生效只影响细节排版，不影响正文渲染',
    handled: '不处理（实测 91 只丢弃嵌套选择器，不整块失效）—— 见 STATUS 已知限制',
  },
]

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'test-results', 'playwright-report'])
const EXTS = ['.ts', '.js', '.mjs', '.cjs', '.vue', '.mts']

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name === 'compat' && full.endsWith(POLYFILL_DIR)) continue
      walk(full, out)
    } else if (EXTS.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith('.map')) {
      out.push(full)
    }
  }
  return out
}

const root = path.resolve(process.cwd(), targetArg)
if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('目标目录不存在：' + root)
  process.exit(2)
}

const files = walk(root)
console.log('审计目标：' + root)
console.log('文件数：' + files.length + '    兼容基线：Chrome ' + BASELINE)
console.log('已跳过修复层：' + POLYFILL_DIR + '（polyfill 定义自身，不是问题来源）')
console.log('')

function isAllowed(checkName, relFile, lineNo) {
  return ALLOWLIST.some(
    (entry) => entry.pattern === checkName && relFile.endsWith(entry.fileSuffix) && entry.line === lineNo,
  )
}

const rows = []
const offenders = []

for (const check of CHECKS) {
  const hits = []
  for (const file of files) {
    const relFile = path.relative(process.cwd(), file)
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const lineNo = i + 1
      const matches = [...lines[i].matchAll(check.pattern)]
      if (matches.length === 0) continue
      if (isAllowed(check.name, relFile, lineNo)) continue
      // 以命中位置为中心取上下文：打包产物是压缩过的单行文件，从头截取等于什么都看不到。
      const at = matches[0].index ?? 0
      const snippet = lines[i].slice(Math.max(0, at - 110), at + 110).trim()
      hits.push({ file: relFile, line: lineNo, count: matches.length, snippet })
    }
  }
  if (hits.length === 0) continue

  const total = hits.reduce((sum, h) => sum + h.count, 0)
  const needs = check.min > BASELINE
  const verdict = !needs ? 'OK(基线已支持)' : check.polyfill ? 'POLYFILLED' : '未处理'
  rows.push({ name: check.name, min: check.min, total, verdict, note: check.note, sites: hits.length })
  if (needs && !check.polyfill) offenders.push({ name: check.name, min: check.min, total, hits })
}

const pad = (value, width) => String(value).padEnd(width)
console.log(pad('API', 32) + pad('最低Chrome', 11) + pad('命中', 7) + '结论')
console.log('-'.repeat(84))
for (const row of rows) console.log(pad(row.name, 32) + pad(row.min, 11) + pad(row.total, 7) + row.verdict)
console.log('')

const atRow = rows.find((r) => r.name === 'Array.prototype.at')
if (atRow) {
  console.log('提示：.at( 命中 ' + atRow.total + ' 处 / ' + atRow.sites + ' 行，含非数组误报（如 CSS 类名、字符串），需人工确认。')
  console.log('')
}

if (offenders.length > 0) {
  console.log('❌ 以下 API 低于兼容基线且**没有** polyfill：')
  for (const offender of offenders) {
    console.log('')
    console.log('  ' + offender.name + '（需要 Chrome ' + offender.min + '，命中 ' + offender.total + '）')
    for (const hit of offender.hits.slice(0, 20)) {
      console.log('    ' + hit.file + ':' + hit.line + '  ' + hit.snippet)
    }
    if (offender.hits.length > 20) console.log('    ...还有 ' + (offender.hits.length - 20) + ' 处')
  }
  process.exit(1)
}


console.log('--- Web API 能力（静态扫描扫不出，需运行时探测）---')
console.log('')
console.log(pad('能力', 44) + pad('最低Chrome', 11) + '状态')
console.log('-'.repeat(84))
for (const capability of RUNTIME_CAPABILITIES) {
  const needs = capability.min > BASELINE
  console.log(pad(capability.name, 44) + pad(capability.min, 11) + (needs ? '需兜底' : '基线已支持'))
  console.log('  原因：' + capability.why)
  console.log('  处理：' + capability.handled)
  console.log('')
}
console.log('注意：上面这些无法靠静态扫描确认，必须在真实 WebView 里执行 probe 探测；')
console.log('     启动探测结果见 src/compat/capabilities.ts（挂到 window.__HPF_CAPABILITIES__）。')
console.log('')

// ★ CSS 能力：只对构建产物有意义（源码里的 .css/.vue 是干净的，毒在 Tailwind 输出里）
const cssDir = path.resolve('dist/assets')
let cssFiles = []
try {
  cssFiles = readdirSync(cssDir).filter((name) => name.endsWith('.css'))
} catch {
  cssFiles = []
}
if (cssFiles.length > 0) {
  console.log('--- CSS 能力（源码扫不出，必须扫构建产物）---')
  console.log('')
  console.log(pad('能力', 26) + pad('最低Chrome', 11) + pad('产物命中', 11) + '处理')
  console.log('-'.repeat(96))
  let cssOffenders = 0
  for (const capability of CSS_CAPABILITIES) {
    let hits = 0
    for (const name of cssFiles) {
      const text = readFileSync(path.join(cssDir, name), 'utf8')
      const matches = text.match(new RegExp(capability.pattern.source, 'g'))
      if (matches) hits += matches.length
    }
    // 只有"硬门禁 + 产物里还有残留"才算违规；次要项只记录不拦。
    const isOffender = hits > 0 && capability.blocking === true
    if (isOffender) cssOffenders += 1
    // 若该特性实际存在于 vendor 的 JS（shadow DOM 模板串），如实报出来
    let jsHits = null
    if (capability.jsTarget) {
      try {
        const jsText = readFileSync(path.resolve(capability.jsTarget), 'utf8')
        const jsRe = capability.jsPattern ?? capability.pattern
        jsHits = (jsText.match(new RegExp(jsRe.source, 'g')) || []).length
      } catch {
        jsHits = null
      }
    }
    const verdict = hits === 0 ? '✅ 0' : capability.blocking ? '❌ ' + hits : '⚠️  ' + hits
    console.log(
      pad(capability.name, 26) + pad(capability.min, 11) + pad(verdict, 11) + capability.handled,
    )
    if (jsHits !== null) {
      console.log(
        '  产物 CSS 中 0 属正常；该规则在 vendor JS 的 shadow DOM 模板里，实命中 ' +
          jsHits +
          ' 处（' +
          capability.jsTarget +
          '，只读不改）',
      )
    }
    console.log('  原因：' + capability.why)
  }
  console.log('')
  if (cssOffenders > 0) {
    console.log('❌ 构建产物里仍有低于 Chrome ' + BASELINE + ' 且必须处理的 CSS 特性，会导致真实设备排版失败。')
    process.exit(1)
  }
  console.log('✅ 构建产物 CSS 无未处理的低于 Chrome ' + BASELINE + ' 的特性。')
  console.log('')
} else {
  console.log('（未找到 dist/assets/*.css，跳过 CSS 产物校验；构建后请用 audit:compat:dist）')
  console.log('')
}
console.log('✅ 未发现低于 Chrome ' + BASELINE + ' 且缺少 polyfill 的运行时内置 API。')