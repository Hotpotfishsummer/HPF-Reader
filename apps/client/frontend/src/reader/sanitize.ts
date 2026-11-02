/**
 * L2 内容隔离：书籍章节文档的净化 + CSP 注入。
 *
 * 定位（docs/ADR-003-内容隔离架构.md §9.2）：
 *   Arch-A（opaque 内容帧）已被判死 —— foliate-js 的 `View` 只通过
 *   `this.#iframe.contentDocument` 访问章节文档（paginator.js 全文件唯一一处），
 *   opaque origin 下该值为 null，分页 / 定位 / 划词全部失效。
 *   因此可达的隔离上限是 **L2：同源 iframe + 逐节净化 + 逐节注入 meta CSP**。
 *
 * 关键前提（同 §9.2，源码级证据）：
 *   foliate-js **完全不注入脚本**（paginator.js 全文 `<script>` / createElement('script') /
 *   document.write 0 命中），所以 `script-src 'none'` 不会破坏分页 —— 这是 L2 成立的理由。
 *
 * 接入点：`book.transformTarget` 的 `data` 事件（epub.js Loader.createURL 在
 * createObjectURL **之前**派发并回读 `event.detail.data`，是唯一早于解析的变换点）。
 *
 * 本模块**不依赖任何 DOM 全局之外的运行时**，可在 happy-dom / jsdom / 浏览器中直接单测。
 */

/** 任务书（task-9 步骤 5）规定的 CSP。顺序与内容必须逐字保持。 */
export const L2_CSP = "default-src 'none'; script-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"

/**
 * 可选加固：把 `blob:` 加进 style-src。
 *
 * 为什么默认不开：task-9 明确要求注入上面那条逐字 CSP。
 * 什么时候需要开：如果选择**不**内联外部样式表（见 `inlineStylesheets: false`），
 *   foliate-js 会把 <link rel="stylesheet"> 重写成 blob: URL，此时 `style-src 'unsafe-inline'`
 *   会连书籍自带 CSS 一起拦掉。默认策略是"内联外部样式表"（既保排版又不需要放宽 CSP）。
 */
export const L2_CSP_WITH_BLOB_STYLE =
  "default-src 'none'; script-src 'none'; img-src data: blob:; style-src 'unsafe-inline' blob:"

/** 允许的 URL 协议白名单（其余一律视为不可信）。 */
const ALLOWED_SCHEMES = new Set(['data:', 'blob:', 'about:'])

/** 需要整个删除的"可执行/可内嵌外部文档"元素。 */
const FORBIDDEN_TAGS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'foreignobject', // SVG：可承载 HTML，等同于第二个文档
  'base', // 会改写全部相对 URL 的解析基准
])

/** 需要移除的 URL 属性（值可能是远程地址 / javascript: 等）。 */
const URL_ATTRIBUTES = [
  'src',
  'href',
  'xlink:href',
  'poster',
  'data',
  'action',
  'formaction',
  'background',
  'cite',
  'srcset',
  'imagesrcset',
  'ping',
  'manifest',
] as const

export interface SanitizeStats {
  removedElements: number
  removedAttributes: number
  rewrittenUrls: number
  removedCssUrls: number
  inlinedStylesheets: number
}

export interface SanitizeOptions {
  /** 注入的 CSP 字符串。默认 {@link L2_CSP}。 */
  csp?: string
  /**
   * 是否把 <link rel="stylesheet"> 的 blob: 内容内联成 <style>。
   * 默认 true —— 这样"禁一切远程/外部样式"的 CSP 仍然不牺牲书籍排版。
   */
  inlineStylesheets?: boolean
  /** 内联样式表时的取数函数（默认走全局 fetch；测试可注入）。 */
  fetchText?: (url: string) => Promise<string>
  /** 统计回调（测试与埋点用）。 */
  onStats?: (stats: SanitizeStats) => void
}

function emptyStats(): SanitizeStats {
  return {
    removedElements: 0,
    removedAttributes: 0,
    rewrittenUrls: 0,
    removedCssUrls: 0,
    inlinedStylesheets: 0,
  }
}

/** 去掉控制字符/空白后再判断协议，避免 `java\nscript:` 这类绕过。 */
function normalizeUrlToken(raw: string): string {
  return raw.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase()
}

/**
 * 判断一个 URL 是否可信。
 * 相对 URL 的解析基准已经被 foliate-js 重写成 blob:（loadReplaced 先跑），
 * 所以这里放行相对引用是安全的；真正的逃逸面是绝对远程地址。
 */
export function isSafeUrl(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true
  const value = raw.trim()
  if (value === '') return true
  const token = normalizeUrlToken(value)
  // 显式危险协议
  if (token.startsWith('javascript:') || token.startsWith('vbscript:')) return false
  // 协议相对地址（//evil.example/x.png）会继承 blob:/file: 之外的宿主协议，
  // 是典型的"看起来像相对路径"的远程逃逸，必须按远程处理。
  if (token.startsWith('//')) return false
  // data: 只允许图片，且不允许 SVG（SVG 可以带脚本）
  if (token.startsWith('data:')) {
    return /^data:image\/(png|jpeg|jpg|gif|webp|avif|bmp);/i.test(value.replace(/\s/g, ''))
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(token)
  if (!schemeMatch) return true // 相对的 / 锚点 / 查询串 —— 放行
  const scheme = `${schemeMatch[1]?.toLowerCase() ?? ''}:`
  return ALLOWED_SCHEMES.has(scheme)
}

/** URL 是否指向远程主机（http(s) / 协议相对）。 */
export function isRemoteUrl(raw: string | null | undefined): boolean {
  if (!raw) return false
  const token = normalizeUrlToken(raw)
  return token.startsWith('http:') || token.startsWith('https:') || token.startsWith('//')
}

/** 净化 CSS 文本：剥离 `@import` 与远程 `url()`。返回净化后的文本。 */
export function sanitizeCssText(css: string, onRemoved?: () => void): string {
  let out = css.replace(/@import[^;]*;?/gi, () => {
    onRemoved?.()
    return ''
  })
  out = out.replace(/url\(\s*("([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi, (match, _q, dq, sq, raw) => {
    const url = String(dq ?? sq ?? raw ?? '').trim()
    if (isSafeUrl(url)) return match
    onRemoved?.()
    return 'url("")'
  })
  return out
}

function removeAttribute(el: Element, name: string, stats: SanitizeStats): void {
  if (el.hasAttribute(name)) {
    el.removeAttribute(name)
    stats.removedAttributes += 1
  }
}

/** 处理单个元素上的 URL 属性。 */
function scrubUrlAttributes(el: Element, stats: SanitizeStats): void {
  for (const attr of URL_ATTRIBUTES) {
    const value = el.getAttribute(attr)
    if (value === null) continue
    if (attr === 'srcset' || attr === 'imagesrcset') {
      // srcset 是 "url descriptor, url descriptor" 列表
      const kept = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '' && isSafeUrl(part.split(/\s+/)[0] ?? ''))
      const next = kept.join(', ')
      if (next !== value) {
        stats.rewrittenUrls += 1
        if (next === '') removeAttribute(el, attr, stats)
        else el.setAttribute(attr, next)
      }
      continue
    }
    if (!isSafeUrl(value)) {
      // 远程 / 危险 URL：直接删属性，而不只是改写 —— 不留下任何"看起来可用"的诱饵。
      removeAttribute(el, attr, stats)
      stats.rewrittenUrls += 1
    }
  }

  // 内联 style 属性里的远程 url()
  const style = el.getAttribute('style')
  if (style && /url\(/i.test(style)) {
    const cleaned = sanitizeCssText(style, () => {
      stats.removedCssUrls += 1
    })
    if (cleaned !== style) el.setAttribute('style', cleaned)
  }
}

/** XHTML 命名空间（注入 meta/style 时必须用正确的命名空间，否则序列化会坏）。 */
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

function isXhtmlDoc(doc: Document): boolean {
  return doc.documentElement?.namespaceURI === XHTML_NS
}

function makeElement(doc: Document, tag: string): Element {
  return isXhtmlDoc(doc) ? doc.createElementNS(XHTML_NS, tag) : doc.createElement(tag)
}

/**
 * 就地净化一个已解析的章节文档。
 *
 * 实现要点：用**单次遍历 + localName 判定**，而不是 getElementsByTagName。
 * 原因：`foreignObject` 在 SVG 命名空间里是大小写敏感的，而 HTML 文档里的
 * `getElementsByTagName` 又会做小写归一，两者叠加会漏删。localName 两条路都覆盖。
 *
 * @param doc 已解析的 Document（由调用方决定 XHTML/HTML 解析方式）
 * @param options 见 {@link SanitizeOptions}
 * @returns 统计信息（可用于断言与埋点）
 */
export function sanitizeDocument(doc: Document, options: SanitizeOptions = {}): SanitizeStats {
  const stats = emptyStats()
  const csp = options.csp ?? L2_CSP

  // 1) 单次遍历：删除可执行/可内嵌文档元素，剥 on* 与危险 URL 属性
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    if (!el.isConnected) continue // 父节点已经被删掉了
    const local = el.localName.toLowerCase()

    if (FORBIDDEN_TAGS.has(local)) {
      el.remove()
      stats.removedElements += 1
      continue
    }

    if (local === 'meta') {
      const equiv = (el.getAttribute('http-equiv') ?? '').toLowerCase()
      // 书籍自带的 refresh 是一类"脚本替代品"；自带的 CSP 会盖掉我们注入的那条。
      if (equiv === 'refresh' || equiv === 'content-security-policy') {
        el.remove()
        stats.removedElements += 1
        continue
      }
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc') {
        removeAttribute(el, attr.name, stats)
      }
    }
    scrubUrlAttributes(el, stats)

    if (local === 'style') {
      const cssText = el.textContent ?? ''
      if (cssText) {
        const cleaned = sanitizeCssText(cssText, () => {
          stats.removedCssUrls += 1
        })
        if (cleaned !== cssText) el.textContent = cleaned
      }
    }
  }

  // 2) 注入 meta CSP（必须位于 <head> 内；插到最前，确保对后续内容都生效）
  const head = (doc.head ?? doc.getElementsByTagName('head')[0]) as Element | undefined
  if (head) {
    const meta = makeElement(doc, 'meta')
    meta.setAttribute('http-equiv', 'Content-Security-Policy')
    meta.setAttribute('content', csp)
    head.insertBefore(meta, head.firstChild)
  }

  options.onStats?.(stats)
  return stats
}

/**
 * 内联 <link rel="stylesheet">：把（已被 foliate-js 重写为 blob: 的）样式表内容读出来，
 * 净化后写成 <style>。
 *
 * 为什么要这一步：foliate-js 会把书籍自带的 CSS 重写成 `blob:` URL 挂在 <link> 上。
 * 如果只给 `style-src 'unsafe-inline'`（task-9 规定的逐字 CSP），这些外链样式会被 CSP 拦掉，
 * 于是出现"书能打开但完全没有排版"。内联之后：①排版保住；②不需要放宽 CSP；
 * ③CSS 里的远程引用同样被 {@link sanitizeCssText} 干掉。
 */
async function inlineStylesheets(
  doc: Document,
  fetchText: (url: string) => Promise<string>,
  stats: SanitizeStats,
): Promise<void> {
  for (const link of Array.from(doc.querySelectorAll('link'))) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase()
    if (!rel.split(/\s+/).includes('stylesheet')) {
      // 非样式表的外链（preload/prefetch/alternate…）一律删除：不允许任何外部引用。
      link.remove()
      stats.removedElements += 1
      continue
    }
    const href = link.getAttribute('href') ?? ''
    link.remove()
    stats.removedElements += 1
    if (href === '' || !isSafeUrl(href)) continue
    try {
      const raw = await fetchText(href)
      const cleaned = sanitizeCssText(raw, () => {
        stats.removedCssUrls += 1
      })
      const styleEl = makeElement(doc, 'style')
      styleEl.textContent = cleaned
      const head = (doc.head ?? doc.getElementsByTagName('head')[0]) as Element | undefined
      if (head) head.appendChild(styleEl)
      else doc.documentElement.appendChild(styleEl)
      stats.inlinedStylesheets += 1
    } catch {
      // 取不到就丢弃：宁可少样式，也不引入一个远程请求。
    }
  }
}

function parseMarkup(markup: string, mediaType: string): { doc: Document; outputType: string } {
  const parser = new DOMParser()
  if (mediaType.includes('xhtml') || mediaType.includes('svg')) {
    const doc = parser.parseFromString(markup, mediaType.includes('svg') ? 'image/svg+xml' : 'application/xhtml+xml')
    if (!doc.querySelector('parsererror')) return { doc, outputType: mediaType }
    // 非法 XHTML：按 HTML 解析（并如实改写 mediaType，避免输出仍是 XML 但已经不是合法 XML）
  }
  return { doc: parser.parseFromString(markup, 'text/html'), outputType: 'text/html' }
}

function serialize(doc: Document, outputType: string): string {
  if (outputType === 'text/html') {
    const doctype = doc.doctype ? '<!DOCTYPE html>' : ''
    return `${doctype}${doc.documentElement.outerHTML}`
  }
  return new XMLSerializer().serializeToString(doc)
}

export interface SanitizeResourceResult {
  data: string
  type: string
}

/**
 * transformTarget 的 `data` 事件处理器本体（纯函数版本，便于单测）。
 *
 * @param markup 资源原始内容
 * @param mediaType 资源 MIME（'application/xhtml+xml' / 'text/html' / 'image/svg+xml' / 'text/css'）
 * @param name 资源名（仅用于日志/调试）
 */
export async function sanitizeResource(
  markup: string,
  mediaType: string,
  options: SanitizeOptions = {},
  name = '',
): Promise<SanitizeResourceResult> {
  void name
  const isCss = mediaType.includes('css')
  if (isCss) {
    const stats = emptyStats()
    const cleaned = sanitizeCssText(markup, () => {
      stats.removedCssUrls += 1
    })
    options.onStats?.(stats)
    return { data: cleaned, type: mediaType }
  }

  const { doc, outputType } = parseMarkup(markup, mediaType)
  const stats = sanitizeDocument(doc, options)
  if (options.inlineStylesheets !== false) {
    const fetchText =
      options.fetchText ??
      (async (url: string) => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.text()
      })
    await inlineStylesheets(doc, fetchText, stats)
  }
  return { data: serialize(doc, outputType), type: outputType }
}

/** transformTarget 事件 detail 的最小结构（上游 README:115）。 */
export interface TransformTargetDetail {
  data: string | Blob | Promise<string | Blob>
  type: string
  name?: string
}

/**
 * 把一个 data 事件 detail 转成"净化后的 data"Promise。
 * 上游支持 data 为 Promise，所以这里也用 Promise 链，不阻塞其它监听器。
 */
export function sanitizeTransformDetail(
  detail: TransformTargetDetail,
  options: SanitizeOptions = {},
): Promise<string | Blob> {
  const type = detail.type ?? ''
  const textLike = type.includes('html') || type.includes('xml') || type.includes('css')
  if (!textLike) {
    // 二进制资源（图片/字体）原样放行：CSP 与 URL 白名单已经限制了它们的来源。
    return Promise.resolve(detail.data) as Promise<string | Blob>
  }
  return Promise.resolve(detail.data).then(async (data) => {
    if (data instanceof Blob) {
      const text = await data.text()
      const result = await sanitizeResource(text, type, options, detail.name ?? '')
      if (result.type === type) return new Blob([result.data], { type })
      return new Blob([result.data], { type: result.type })
    }
    const result = await sanitizeResource(data, type, options, detail.name ?? '')
    return result.data
  })
}

/**
 * 把 L2 净化挂到 foliate-js 的 transformTarget 上。
 *
 * 调用时机：拿到 book（makeBook 的产物）之后、`view.open(book)` **之前**。
 * 这样我们的监听器先于 paginator 自己的 CSS 变换监听器执行，净化后的字符串
 * 再交给上游做 vw/vh 替换。
 *
 * @returns 取消订阅函数
 */
export function attachL2Sanitizer(
  book: { transformTarget?: EventTarget },
  options: SanitizeOptions = {},
): () => void {
  const target = book.transformTarget
  if (!target) return () => {}

  const onData = (event: Event): void => {
    const detail = (event as CustomEvent<TransformTargetDetail>).detail
    if (!detail) return
    detail.data = sanitizeTransformDetail(detail, options)
  }

  // 额外一层纵深：直接拒绝 script 类资源（epub.js loadItem 会读 detail.allow）。
  const onLoad = (event: Event): void => {
    const detail = (event as CustomEvent<{ type?: string; isScript?: boolean; allow?: boolean }>).detail
    if (!detail) return
    if (detail.isScript) detail.allow = false
  }

  target.addEventListener('data', onData)
  target.addEventListener('load', onLoad)
  return () => {
    target.removeEventListener('data', onData)
    target.removeEventListener('load', onLoad)
  }
}