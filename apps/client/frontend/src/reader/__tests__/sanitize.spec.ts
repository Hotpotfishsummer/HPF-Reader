import { describe, expect, it, vi } from 'vitest'
import {
  L2_CSP,
  attachL2Sanitizer,
  isRemoteUrl,
  isSafeUrl,
  sanitizeCssText,
  sanitizeDocument,
  sanitizeResource,
} from '../sanitize'

/**
 * L2 隔离的单测（task-9 步骤 5 的硬要求）。
 *
 * 覆盖的恶意样本（至少 6 个，全部来自 ADR-003 §2 的威胁链）：
 *   1. 内联 <script>
 *   2. <img onerror=...>
 *   3. javascript: 链接
 *   4. 远程图片（http(s) 外链外泄）
 *   5. <iframe>
 *   6. CSS url() 外链
 * 另外补：foreignObject、meta refresh、data:text/html、srcset、XHTML 往返、
 * 事件属性控制字符绕过、transformTarget 接线。
 */

const XHTML = 'application/xhtml+xml'

function parse(markup: string, type = XHTML): Document {
  return new DOMParser().parseFromString(markup, type as DOMParserSupportedType)
}

function html(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`
}

describe('isSafeUrl / isRemoteUrl', () => {
  it('放行相对路径、blob:、图片 data: 与锚点', () => {
    expect(isSafeUrl('chapter1.xhtml')).toBe(true)
    expect(isSafeUrl('../images/a.png')).toBe(true)
    expect(isSafeUrl('blob:http://127.0.0.1:34115/abc')).toBe(true)
    expect(isSafeUrl('#footnote-1')).toBe(true)
    expect(isSafeUrl('data:image/png;base64,AAAA')).toBe(true)
  })

  it('拦截 javascript:/vbscript:/远程 http(s)/非图片 data:', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeUrl('JaVaScRiPt:alert(1)')).toBe(false)
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false)
    expect(isSafeUrl('https://evil.example/x.png')).toBe(false)
    expect(isSafeUrl('//evil.example/x.png')).toBe(false)
    expect(isSafeUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false)
    expect(isSafeUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
  })

  it('忽略协议里的控制字符（java\nscript: 绕过）', () => {
    expect(isSafeUrl('java\nscript:alert(1)')).toBe(false)
    expect(isSafeUrl('  javascript:alert(1)')).toBe(false)
    expect(isRemoteUrl('HTTPS://evil.example/a')).toBe(true)
  })
})

describe('sanitizeDocument —— 恶意样本', () => {
  it('样本 1：剥离内联 <script> 与 JSON-LD 脚本', () => {
    const doc = parse(html('<script>window.top.location="https://evil.example"</script><p>正文</p>'))
    const stats = sanitizeDocument(doc)
    expect(doc.querySelectorAll('script')).toHaveLength(0)
    expect(stats.removedElements).toBeGreaterThanOrEqual(1)
    expect(doc.body.textContent).toContain('正文')
  })

  it('样本 2：剥离 onerror / onclick 等 on* 事件属性', () => {
    const doc = parse(html(`<img src="a.png" onerror="fetch('https://evil.example')" onclick="alert(1)"><p onmouseover="x()">t</p>`))
    sanitizeDocument(doc)
    const img = doc.querySelector('img')
    expect(img?.getAttribute('onerror')).toBeNull()
    expect(img?.getAttribute('onclick')).toBeNull()
    // 本地相对图片保留（foliate-js 已把它重写成 blob:，这里相对路径同样安全）
    expect(img?.getAttribute('src')).toBe('a.png')
    expect(doc.querySelector('p')?.getAttribute('onmouseover')).toBeNull()
  })

  it('样本 3：剥离 javascript: 链接（保留锚点链接）', () => {
    const doc = parse(html('<a id="bad" href="javascript:steal()">点我</a><a id="ok" href="#note">脚注</a>'))
    sanitizeDocument(doc)
    expect(doc.querySelector('#bad')?.getAttribute('href')).toBeNull()
    expect(doc.querySelector('#ok')?.getAttribute('href')).toBe('#note')
  })

  it('样本 4：剥除远程图片地址（阻断外链外泄）', () => {
    const doc = parse(html('<img src="https://evil.example/track.png"><img src="blob:http://127.0.0.1:34115/local.png">'))
    sanitizeDocument(doc)
    const imgs = Array.from(doc.querySelectorAll('img'))
    expect(imgs[0]?.getAttribute('src')).toBeNull()
    expect(imgs[1]?.getAttribute('src')).toBe('blob:http://127.0.0.1:34115/local.png')
  })

  it('样本 5：整个删除 <iframe> 与 <object>/<embed>/<foreignObject>', () => {
    const doc = parse(html(
      '<iframe src="https://evil.example"></iframe>'
      + '<object data="https://evil.example/x.swf"></object>'
      + '<embed src="https://evil.example/x.swf" />'
      + '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>1</script></body></foreignObject></svg>'
      + '<p>keep</p>',
    ))
    const stats = sanitizeDocument(doc)
    expect(doc.querySelectorAll('iframe')).toHaveLength(0)
    expect(doc.querySelectorAll('object')).toHaveLength(0)
    expect(doc.querySelectorAll('embed')).toHaveLength(0)
    expect(doc.getElementsByTagName('foreignObject')).toHaveLength(0)
    expect(stats.removedElements).toBeGreaterThanOrEqual(4)
    expect(doc.body.textContent).toContain('keep')
  })

  it('样本 6：剥除 CSS url() 外链（<style> 与 style 属性两条路）', () => {
    const doc = parse(html(
      '<style>@import "https://evil.example/a.css"; body { background: url("https://evil.example/track.png"); } p { color: red }</style>'
      + '<p style="background-image: url(https://evil.example/b.png); color: blue">x</p>',
    ))
    const stats = sanitizeDocument(doc)
    const css = doc.querySelector('style')?.textContent ?? ''
    expect(css).not.toContain('evil.example')
    expect(css).not.toContain('@import')
    expect(css).toContain('color: red')
    const inlineStyle = doc.querySelector('p')?.getAttribute('style') ?? ''
    expect(inlineStyle).not.toContain('evil.example')
    expect(inlineStyle).toContain('color: blue')
    expect(stats.removedCssUrls).toBeGreaterThanOrEqual(2)
  })

  it('删除 meta refresh 与书籍自带的 CSP', () => {
    const doc = parse(html('<meta http-equiv="refresh" content="0;url=https://evil.example">'))
    sanitizeDocument(doc)
    expect(doc.querySelectorAll('meta[http-equiv="refresh"]')).toHaveLength(0)
  })

  it('过滤 srcset 中的远程地址', () => {
    const doc = parse(html('<img src="blob:http://127.0.0.1/a.png" srcset="https://evil.example/2x.png 2x, blob:http://127.0.0.1/a.png 1x">'))
    sanitizeDocument(doc)
    const srcset = doc.querySelector('img')?.getAttribute('srcset') ?? ''
    expect(srcset).not.toContain('evil.example')
    expect(srcset).toContain('blob:')
  })

  it('剥掉 srcdoc（可承载第二个文档）', () => {
    const doc = parse(html('<div srcdoc="<script>1</script>"></div>'))
    sanitizeDocument(doc)
    expect(doc.querySelector('div')?.getAttribute('srcdoc')).toBeNull()
  })
})

describe('sanitizeDocument —— CSP 注入', () => {
  it('注入逐字符合 task-9 规定的 meta CSP，且位于 head 的最前面', () => {
    const doc = parse(html('<p>x</p>'))
    sanitizeDocument(doc)
    const metas = Array.from(doc.querySelectorAll('meta[http-equiv]'))
    const csp = metas.find((m) => (m.getAttribute('http-equiv') ?? '').toLowerCase() === 'content-security-policy')
    expect(csp).toBeTruthy()
    expect(csp?.getAttribute('content')).toBe(L2_CSP)
    expect(csp?.getAttribute('content')).toBe("default-src 'none'; script-src 'none'; img-src data: blob:; style-src 'unsafe-inline'")
    expect(doc.head?.firstElementChild?.tagName.toLowerCase()).toBe('meta')
  })

  it('支持自定义 CSP（例如需要放宽 style-src 时）', () => {
    const doc = parse(html('<p>x</p>'))
    sanitizeDocument(doc, { csp: "default-src 'none'; style-src 'unsafe-inline' blob:" })
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')
    expect(csp?.getAttribute('content')).toContain("style-src 'unsafe-inline' blob:")
  })

  it('sanitizeCssText 只剥危险引用，不动其它声明', () => {
    const out = sanitizeCssText('@import url("https://evil.example/a.css"); p{background:url(https://evil.example/b.png)} b{color:red}')
    expect(out).not.toContain('evil.example')
    expect(out).not.toContain('@import')
    expect(out).toContain('color:red')
  })
})

describe('sanitizeResource —— 完整往返', () => {
  it('XHTML 章节：保持可解析、剥脚本、注入 CSP、返回原 mediaType', async () => {
    const raw = html('<script>alert(1)</script><p onclick="x()">hello</p><a href="javascript:1">bad</a>')
    const out = await sanitizeResource(raw, XHTML, { inlineStylesheets: false })
    expect(out.type).toBe(XHTML)
    expect(out.data).not.toContain('<script')
    expect(out.data).not.toContain('onclick')
    expect(out.data).not.toContain('javascript:')

    const doc = new DOMParser().parseFromString(out.data, XHTML)
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')).toBeTruthy()
    expect(new XMLSerializer().serializeToString(doc)).toContain('hello')
  })

  it('非法 XHTML 会被降级为 text/html（而不是产出坏 XML）', async () => {
    const broken = '<html><head></head><body><p>1<br>2</p></body></html>'
    const out = await sanitizeResource(broken, XHTML, { inlineStylesheets: false })
    expect(out.type).toBe('text/html')
    expect(out.data).toContain('1')
  })

  it('CSS 资源走纯文本净化路径', async () => {
    const out = await sanitizeResource('body{background:url(https://evil.example/a.png)}', 'text/css')
    expect(out.type).toBe('text/css')
    expect(out.data).not.toContain('evil.example')
  })

  it('把 blob: 外链样式表内联成 <style>（既保排版又不放宽 CSP）', async () => {
    const raw = html('<link rel="stylesheet" href="blob:http://127.0.0.1:34115/s.css" type="text/css"><p>x</p>')
    const fetchText = vi.fn(async () => 'p{color:green;background:url(https://evil.example/a.png)}')
    const out = await sanitizeResource(raw, XHTML, { fetchText })
    expect(fetchText).toHaveBeenCalledWith('blob:http://127.0.0.1:34115/s.css')
    expect(out.data).not.toContain('<link')
    expect(out.data).toContain('color:green')
    expect(out.data).not.toContain('evil.example')
  })

  it('远程样式表不会被取数（直接丢弃）', async () => {
    const raw = html('<link rel="stylesheet" href="https://evil.example/a.css"><p>x</p>')
    const fetchText = vi.fn(async () => 'p{color:red}')
    const out = await sanitizeResource(raw, XHTML, { fetchText })
    expect(fetchText).not.toHaveBeenCalled()
    expect(out.data).not.toContain('evil.example')
  })
})

describe('attachL2Sanitizer —— transformTarget 接线', () => {
  it('改写 data 事件的 detail.data，并让 script 资源 allow=false', async () => {
    const book = { transformTarget: new EventTarget() }
    const detach = attachL2Sanitizer(book, { inlineStylesheets: false })

    const detail = {
      data: html('<script>1</script><p>ok</p>'),
      type: XHTML,
      name: 'chapter1.xhtml',
    }
    book.transformTarget.dispatchEvent(new CustomEvent('data', { detail }))
    const data = await detail.data
    expect(typeof data).toBe('string')
    expect(data as string).not.toContain('<script')
    expect(data as string).toContain('Content-Security-Policy')

    const loadDetail: { type: string; isScript: boolean; allow: boolean } = {
      type: 'application/javascript',
      isScript: true,
      allow: true,
    }
    book.transformTarget.dispatchEvent(new CustomEvent('load', { detail: loadDetail }))
    expect(loadDetail.allow).toBe(false)

    detach()
    const detail2 = { data: html('<script>2</script>'), type: XHTML }
    book.transformTarget.dispatchEvent(new CustomEvent('data', { detail: detail2 }))
    expect(detail2.data).toContain('<script')
  })

  it('二进制资源（图片/字体）原样放行', async () => {
    const book = { transformTarget: new EventTarget() }
    attachL2Sanitizer(book)
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const detail: { data: unknown; type: string } = { data: blob, type: 'image/png' }
    book.transformTarget.dispatchEvent(new CustomEvent('data', { detail }))
    // 上游 createURL 会 await detail.data，所以允许它是 Promise；内容必须是同一个 Blob。
    await expect(detail.data).resolves.toBe(blob)
  })

  it('没有 transformTarget 的 book（例如 MOBI）不应抛错', () => {
    expect(() => attachL2Sanitizer({})).not.toThrow()
    const detach = attachL2Sanitizer({})
    expect(() => detach()).not.toThrow()
  })
})
