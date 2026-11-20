/**
 * 主题"双写"的第二节：把主文档的阅读器变量翻译成写进章节文档的样式表。
 *
 * 为什么必须双写（docs/research/50-vue3-reader-stack.md §4.2 关键点 1）：
 *   foliate-paginator 会往每个章节文档的 head 首尾各注入一个 <style>，
 *   书籍正文完全在 iframe 里 —— 只改主文档的 CSS 变量，正文不会有任何变化。
 *
 * 注意：paginator.setStyles 支持传字符串或 `[beforeStyle, style]` 两段，
 * 这里用两段：before 负责排版（先于书籍自身 CSS 生效），style 负责覆盖（后于书籍 CSS 生效）。
 *
 * ★ 与几何的分工（task-12）：
 *   本文件只负责**排版与配色**（字体、字号、行高、颜色、换行规则）；
 *   **几何**（几栏、单栏多宽、页边距、栏间距）由 paginator 的 attribute 控制，
 *   见 useFoliateEngine.setLayout()。两者不能混 —— CSS 改栏数不会让引擎重新分页。
 */

/**
 * ★ 把主文档的阅读器 CSS 变量**解析成具体值**。
 *
 * 为什么必须解析（这是 E2E 抓出来的真 bug）：
 *   章节正文在 iframe 里，而 CSS 自定义属性**不跨文档继承**。
 *   如果直接把字符串 `var(--reader-paper)` 写进 iframe 的样式表，
 *   那个变量在 iframe 的 `:root` 上根本不存在 → 声明失效 → 背景变透明。
 *   结果是"外层容器颜色看着对、正文其实没换主题"，夜间模式只有 UI 变了。
 *
 * `getComputedStyle` 读自定义属性时返回的是**已替换 var() 的计算值**，
 * 所以这里拿到的是真正的颜色/字体栈。
 */
export interface ReaderTokens {
  paper: string
  ink: string
  fontFamily: string
}

export function resolveReaderTokens(root: HTMLElement = document.documentElement): ReaderTokens {
  const style = getComputedStyle(root)
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  return {
    paper: read('--reader-paper', '#fbf8f2'),
    ink: read('--reader-ink', '#23201c'),
    fontFamily: read('--reader-font-family', 'Georgia, "Songti SC", serif'),
  }
}

export interface ReaderStyleInput {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  /** 正文上下留白；左右由 paginator 的 margin attribute 负责。 */
  marginBlock: number
  paper: string
  ink: string
  /** 允许段落首行缩进（中文书籍常见），书籍自身 CSS 优先。 */
  textIndent: boolean
  /** 墨水屏刷新优化：禁用所有过渡动画，增强图片对比度防残影 */
  einkMode?: boolean
}

export function buildReaderStyles(input: ReaderStyleInput): [string, string] {
  const before = `
:root {
  --hpf-paper: ${input.paper};
  --hpf-ink: ${input.ink};
}
html {
  background: var(--hpf-paper);
  color: var(--hpf-ink);
  font-family: ${input.fontFamily};
  font-size: ${input.fontSize}px;
  line-height: ${input.lineHeight};
  letter-spacing: ${input.letterSpacing}em;
  /* 窄屏时不要出现横向滚动条 */
  overflow-wrap: break-word;
  word-break: break-word;
  -webkit-text-size-adjust: 100%;
}
body { margin-block: ${input.marginBlock}px; }
`

  const style = `
html { color-scheme: light; }
p, li, div { orphans: 2; widows: 2; }
p { margin-block: 0.6em; }
a { color: inherit; text-decoration-color: currentColor; }
/* 图片在分栏模式下必须严格受限于单栏宽度，否则撑破多栏网格导致排版错乱 */
img, svg, video, table { max-inline-size: 100% !important; max-width: 100% !important; block-size: auto !important; height: auto !important; box-sizing: border-box !important; }
table { border-collapse: collapse; }
pre { white-space: pre-wrap; }
${input.textIndent ? 'p { text-indent: 2em; margin-block: 0.2em; }' : ''}
${input.einkMode ? '* { transition: none !important; animation: none !important; } img { filter: grayscale(100%) contrast(140%) !important; }' : ''}
`

  return [before, style]
}
