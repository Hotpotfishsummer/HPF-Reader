/**
 * ★ 把 CSS `@layer` 展平成普通规则（构建期降级，task-14 追加项）。
 *
 * ## 为什么需要
 *
 * Tailwind v4 输出的样式表整体包在 `@layer theme/base/components/utilities` 里：
 *
 *   @layer properties{...}
 *   @layer theme{...}
 *   @layer base{...}
 *   @layer components;@layer utilities{...}
 *
 * 而 **`@layer` 是 Chrome 99+ 才有的**。在 WebView 91 上，浏览器会把整个
 * `@layer` 块**静默丢弃**（不报错、不抛异常、console 干净）—— 于是我们的
 * 全部 Tailwind 工具类失效：
 *
 *   .absolute{position:absolute}  → 算出来是 static
 *   .flex{display:flex}           → 算出来是 block
 *   .h-full{height:100%}          → 算出来是 auto
 *
 * 阅读器的根容器是 `relative flex h-full w-full`、正文宿主是
 * `relative min-h-0 min-w-0 flex-1`。这些类全失效后，宿主高度变成 auto，
 * foliate-view 撑到内容高度（实测 1482px，视口只有 843px），
 * paginator 拿到的容器尺寸是错的 → 真书渲染不出正文。
 *
 * 这个 bug 和 builtin 缺失、和 deflate 都无关，是**纯 CSS 能力缺失**。
 *
 * ## 为什么展平是正确做法，而不是 hack
 *
 * `@layer` 的唯一作用是**层叠顺序**（layer 内部/之间的优先级）。Tailwind
 * 按 theme → base → components → utilities 的顺序输出这些块，**展平后文档顺序
 * 与层叠顺序完全一致**，因此普通 CSS 的层叠结果与 `@layer` 等价 ——
 * 这正是 `postcss-cascade-layers` 这类 polyfill 做的事。对支持 `@layer` 的
 * 浏览器，展平后的语义同样正确（我们并没有引入新的优先级差异）。
 *
 * 这和 `vite.config.ts` 把 `build.target` 下调到 chrome91 是同一思路：
 * **构建期把语法/特性降到目标浏览器能接受的形态**。
 *
 * ## 实现要点
 * - 只处理 `@layer <名字>{ ... }` 块：剥掉外壳，保留内部规则；
 * - 丢掉 `@layer a, b;` 这种**只声明顺序、没有块**的语句（91 上会被忽略，
 *   留着只是噪音；展平后顺序已由文档顺序表达）；
 * - 用括号配平找块边界（不能靠正则匹配嵌套的 `{}`）；
 * - 不碰 `@supports` / `@media` / `@property` 等其它 at-rule。
 */

/** 找到与 `openIndex` 处 `{` 配对的 `}` 下标（忽略字符串里的括号）。 */
function findMatchingBrace(text, openIndex) {
  let depth = 0
  let inString = null
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i += 1
      else if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'") inString = ch
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 展平所有 `@layer`。返回 `{ css, blocks, statements }`，便于测试断言。
 * @param {string} css
 */
export function flattenCssLayers(css) {
  let out = ''
  let i = 0
  let blocks = 0
  let statements = 0
  while (i < css.length) {
    const at = css.indexOf('@layer', i)
    if (at < -1 || at === -1) {
      out += css.slice(i)
      break
    }
    out += css.slice(i, at)
    // 跳过 "@layer" 与其后的空白，读出层名
    let j = at + '@layer'.length
    while (j < css.length && /\s/.test(css[j])) j += 1
    // 只声明顺序的语句：@layer a, b;  → 直接丢掉
    const brace = css.indexOf('{', j)
    const semi = css.indexOf(';', j)
    if (semi !== -1 && (brace === -1 || semi < brace)) {
      statements += 1
      i = semi + 1
      continue
    }
    if (brace === -1) {
      // 畸形输入：原样保留剩余部分，避免吞掉内容
      out += css.slice(at)
      break
    }
    const close = findMatchingBrace(css, brace)
    if (close === -1) {
      out += css.slice(at)
      break
    }
    // 剥壳：保留块内部规则
    out += css.slice(brace + 1, close)
    blocks += 1
    i = close + 1
  }
  return { css: out, blocks, statements }
}
