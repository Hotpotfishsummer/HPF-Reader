/**
 * 主题"双写"的第二节：把主文档的阅读器变量翻译成写进章节文档的样式表。
 *
 * 为什么必须双写（docs/research/50-vue3-reader-stack.md §4.2 关键点 1）：
 *   foliate-paginator 会往每个章节文档的 head 首尾各注入一个 <style>，
 *   书籍正文完全在 iframe 里 —— 只改主文档的 CSS 变量，正文不会有任何变化。
 *
 * 注意：paginator.setStyles 支持传字符串或 `[beforeStyle, style]` 两段，
 * 这里用两段：before 负责排版（先于书籍自身 CSS 生效），style 负责覆盖（后于书籍 CSS 生效）。
 */

export interface ReaderStyleInput {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  marginInline: number
  marginBlock: number
  columnGap: number
  maxInlineSize: number
  maxColumnCount: number
  paper: string
  ink: string
  /** 夜间/墨水屏：正文颜色反转由 foliate-view::part(filter) 处理，这里只管配色。 */
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
}
body { margin-block: ${input.marginBlock}px; }
`
  const style = `
html { color-scheme: light; }
p, li, div { orphans: 2; widows: 2; }
a { color: inherit; text-decoration-color: currentColor; }
img, svg, video { max-inline-size: 100% !important; block-size: auto !important; }
`
  void input.marginInline
  void input.columnGap
  void input.maxInlineSize
  void input.maxColumnCount
  return [before, style]
}
