/**
 * foliate-js 的手写类型声明。
 *
 * 为什么手写：上游是纯 JS、无 .d.ts、无构建步骤（README 明说 unstable）。
 * 我们**不**开 allowJs 去类型检查上游源码 —— 那会把第三方代码的错误变成我们构建的失败。
 *
 * 只声明我们真正用到的那部分 API；签名取自上游源码与 README（commit 见 VENDOR.md）。
 */

declare module 'foliate-js/view.js' {
  export interface FoliateTOCItem {
    label: string
    href: string
    subitems?: FoliateTOCItem[]
  }

  export interface FoliateBook {
    sections: Array<{
      id: unknown
      cfi?: string
      linear?: string
      mediaOverlay?: unknown
      load?: () => Promise<string>
      unload?: () => void
      createDocument?: () => Promise<Document>
    }>
    toc?: FoliateTOCItem[]
    pageList?: FoliateTOCItem[]
    metadata?: Record<string, unknown>
    rendition?: { layout?: string }
    dir?: string
    /** EPUB 的变换钩子：EventTarget，派发 'data' / 'load' 事件（README:115）。 */
    transformTarget?: EventTarget
    destroy?: () => void
    splitTOCHref?: (href: string) => unknown[]
    getTOCFragment?: (doc: Document, href: string) => Node | null
  }

  export interface FoliateRenderer extends HTMLElement {
    setStyles?(styles: string | [string, string]): void
    getContents?(): Array<{ index: number; doc: Document }>
    destroy?(): void
  }

  export interface FoliateLocation {
    index: number
    fraction: number
    size?: number
    cfi?: string
    range?: Range
    tocItem?: { label?: string }
    pageItem?: { label?: string }
  }

  export class View extends HTMLElement {
    open(book: File | Blob | string | FoliateBook): Promise<void>
    close(): void
    init(options?: { lastLocation?: string | number; showTextStart?: boolean }): Promise<void>
    goTo(target: string | number | { fraction: number }): Promise<void>
    goToTextStart(): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    getCFI(index: number, range?: Range): string
    resolveNavigation(target: unknown): { index: number; anchor?: (doc: Document) => Node | null } | undefined
    addAnnotation(annotation: { value: string; [key: string]: unknown }): Promise<{ index: number; label: string }>
    deleteAnnotation(annotation: { value: string; [key: string]: unknown }): Promise<{ index: number; label: string }>
    renderer: FoliateRenderer
    book: FoliateBook
    lastLocation?: FoliateLocation
    isFixedLayout: boolean
  }

  export function makeBook(file: File): Promise<FoliateBook>
}

declare module 'foliate-js/overlayer.js' {
  export interface DrawRect {
    x: number
    y: number
    width: number
    height: number
  }
  export const Overlayer: {
    highlight(rects: DrawRect[], options?: { color?: string }): SVGElement
    underline(rects: DrawRect[], options?: { color?: string; width?: number; writingMode?: string }): SVGElement
    strikethrough(rects: DrawRect[], options?: { color?: string; width?: number; writingMode?: string }): SVGElement
    squiggly(rects: DrawRect[], options?: { color?: string; width?: number; writingMode?: string }): SVGElement
    outline(rects: DrawRect[], options?: { color?: string; width?: number; radius?: number }): SVGElement
  }
}

declare module 'foliate-js/paginator.js' {
  // 只为副作用（customElements.define('foliate-paginator')）而 import。
  export {}
}
