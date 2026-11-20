import { markRaw, onScopeDispose, shallowRef, type ShallowRef } from 'vue'
import type { FoliateBook, FoliateTOCItem, View } from 'foliate-js/view.js'
import { attachL2Sanitizer, type SanitizeOptions, type SanitizeStats } from './sanitize'

/**
 * foliate-js 的命令式生命周期封装。
 *
 * 三条硬规则（docs/research/50-vue3-reader-stack.md §5.1 / §5.2，照抄不改）：
 *   1. 引擎实例（带方法、带内部状态）**绝不放进 ref/reactive** —— Vue 的 Proxy 会让
 *      `this` / `addEventListener` 记录的 currentTarget / `view.renderer` 身份不一致，
 *      表现为"翻页随机失效 / next is not a function"。
 *      这里的做法：真正引用放**闭包普通变量** `view`，对外只暴露方法。
 *   2. DOM 节点用模板 ref 或 shallowRef，永远不要 ref()。
 *   3. 跨边界只传"值"（string / number / plain object），不传 Range / Element / 库实例。
 */

/** 只把值交给 Vue，不传 Range（活对象陷阱）。 */
export interface RelocateDetail {
  index: number
  fraction: number
  cfi: string
  tocLabel: string
  pageItemLabel: string
  excerpt?: string
}

export interface EngineHooks {
  onReady?(book: FoliateBook): void
  onError?(error: unknown): void
  onRelocate(location: RelocateDetail): void
  /** doc 只用于挂监听，用完即弃；不要存进响应式状态。 */
  onLoad(doc: Document, index: number): void
  onExternalLink(href: string): void
  onSanitize?(stats: SanitizeStats): void
}

/**
 * ★ 排版几何（task-12 §3 横竖屏自适应）。
 *
 * foliate-paginator 通过 **attribute** 而不是 CSS 接收几何参数：
 *   `max-column-count` / `max-inline-size` / `margin` / `gap`
 * 其中 `max-inline-size` 的 attributeChangedCallback 会显式调用 `render()`，
 * 所以它是"让引擎真的重新分栏"的那一下（改 CSS 是不会重排的）。
 *
 * 另外 paginator 自带 container query：容器是竖屏时强制
 * `--_max-column-count-portrait`（=1），所以"竖屏单栏"是引擎原生行为，
 * 我们只需要在横屏时告诉它最多几栏。
 */
export interface EngineLayout {
  columns: 1 | 2
  /** 单栏正文宽度上限。 */
  maxInlineSize: number
  marginInline: number
  /** 百分比（foliate 按容器宽度解释）。 */
  columnGapPercent: number
}

export interface SearchResultItem {
  cfi: string
  excerpt: { pre: string; match: string; post: string }
}

export interface SearchResultGroup {
  label: string
  subitems: SearchResultItem[]
}

export type SearchYield =
  | { progress: number }
  | SearchResultGroup
  | SearchResultItem
  | 'done'

export interface FoliateEngine {
  ready: ShallowRef<boolean>
  open(source: File | Blob, options?: { lastLocation?: string }): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  goTo(target: string | number | { fraction: number }): Promise<void>
  getToc(): FoliateTOCItem[]
  getCurrentHref(): string
  /** 主题/字体（写进章节文档的 <style>）。 */
  setStyles(styles: string | [string, string]): void
  /** 几何（写在 paginator 的 attribute 上，会触发重排）。 */
  setLayout(layout: EngineLayout): void
  /** 当前分页后的总页数；未就绪时返回 0。用于观测"重排是否真的发生"。 */
  getPageCount(): number
  getCFI(index: number, range: Range): string
  addAnnotation(annotation: { value: string; [key: string]: unknown }): Promise<{ index: number; label: string }>
  deleteAnnotation(annotation: { value: string; [key: string]: unknown }): Promise<{ index: number; label: string }>
  search(query: string, options?: { matchCase?: boolean }): AsyncIterable<SearchYield>
  clearSearch(): void
  close(): Promise<void>
}

export interface EngineOptions {
  sanitize?: SanitizeOptions
}

export function useFoliateEngine(
  container: () => HTMLElement | null,
  hooks: EngineHooks,
  options: EngineOptions = {},
): FoliateEngine {
  const ready = shallowRef(false)
  /** ★ 真正的实例引用：闭包普通变量，不经过任何响应式系统。 */
  let view: View | null = null
  /** 竞态：每次 open 递增；异步步骤返回后比对，过期就直接销毁自己。 */
  let openSeq = 0
  let disposed = false
  /** open() 还没结束就被替换掉的实例，不能立刻 destroy（会打断内部状态）。 */
  const pending = new WeakSet<View>()
  let detachSanitizer: (() => void) | null = null

  const onRelocate = (event: Event): void => {
    const detail = (event as CustomEvent<Partial<{
      index: number
      fraction: number
      cfi: string
      tocItem: { label?: string }
      pageItem: { label?: string }
      range?: Range
    }>>).detail
    let excerpt = ''
    try {
      if (detail?.range) {
        const text = detail.range.toString()
        if (text) {
          excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 150)
        }
      }
    } catch {
      // 容错处理，避免异常打断渲染
    }
    // ★★ 只把值交给 Vue
    hooks.onRelocate({
      index: detail?.index ?? 0,
      fraction: detail?.fraction ?? 0,
      cfi: detail?.cfi ?? '',
      tocLabel: detail?.tocItem?.label ?? '',
      pageItemLabel: detail?.pageItem?.label ?? '',
      excerpt,
    })
  }
  const onLoad = (event: Event): void => {
    const detail = (event as CustomEvent<{ doc: Document; index: number }>).detail
    hooks.onLoad(detail.doc, detail.index)
  }
  const onExternalLink = (event: Event): void => {
    const detail = (event as CustomEvent<{ href_?: string; href?: string }>).detail
    hooks.onExternalLink(detail?.href_ ?? detail?.href ?? '')
  }

  function detachListeners(target: View): void {
    target.removeEventListener('relocate', onRelocate)
    target.removeEventListener('load', onLoad)
    target.removeEventListener('external-link', onExternalLink)
  }

  async function destroy(target: View): Promise<void> {
    detachListeners(target)
    try {
      target.close()
    } catch (error) {
      console.warn('[engine] close failed', error)
    }
    try {
      target.book?.destroy?.()
    } catch {
      // 未生成首页时 destroy 可能抛错，忽略
    }
    target.remove()
  }

  async function open(source: File | Blob, openOptions: { lastLocation?: string } = {}): Promise<void> {
    const seq = ++openSeq
    const previous = view
    view = null
    ready.value = false
    detachSanitizer?.()
    detachSanitizer = null
    if (previous && !pending.has(previous)) await destroy(previous)

    const host = container()
    if (!host || disposed) return

    // 动态 import：foliate-js 只在真正打开书时才加载（Web 首屏不为它付出代价）。
    const { makeBook } = await import('foliate-js/view.js')
    if (seq !== openSeq || disposed) return

    // ★ 命令式创建 custom element；markRaw 防止将来有人把它塞进响应式结构。
    const element = markRaw(document.createElement('foliate-view') as View)
    view = element
    pending.add(element)
    host.appendChild(element)
    element.addEventListener('relocate', onRelocate)
    element.addEventListener('load', onLoad)
    element.addEventListener('external-link', onExternalLink)

    try {
      // ★ makeBook 之后再 view.open(book)：这样我们能在 renderer.open 之前
      //   把 L2 净化挂到 book.transformTarget 上（第一个 data 监听器）。
      const book = await makeBook(source as File)
      if (seq !== openSeq || disposed) {
        await destroy(element)
        return
      }
      detachSanitizer = attachL2Sanitizer(book, {
        ...options.sanitize,
        onStats: (stats) => {
          options.sanitize?.onStats?.(stats)
          hooks.onSanitize?.(stats)
        },
      })
      await element.open(book)
      if (seq !== openSeq || disposed) return
      await element.init(
        openOptions.lastLocation
          ? { lastLocation: openOptions.lastLocation }
          : { showTextStart: true },
      )
      if (seq !== openSeq || disposed) return
      ready.value = true
      hooks.onReady?.(book)
    } catch (error) {
      console.error('[engine] open failed', error)
      hooks.onError?.(error)
      // 继续往外抛：调用方可能要换一种方式重试（例如"续读位置失效 → 从头打开"）。
      throw error
    } finally {
      pending.delete(element)
      if (view !== element) await destroy(element)
    }
  }

  async function close(): Promise<void> {
    openSeq += 1
    detachSanitizer?.()
    detachSanitizer = null
    const target = view
    view = null
    ready.value = false
    if (target) await destroy(target)
  }

  onScopeDispose(() => {
    disposed = true
    void close()
  })

  return {
    ready,
    open,
    next: async () => {
      await view?.next()
    },
    prev: async () => {
      await view?.prev()
    },
    goTo: async (target) => {
      await view?.goTo(target)
    },
    getToc: () => view?.book?.toc ?? [],
    getCurrentHref: () => view?.book?.sections[view.lastLocation?.index ?? 0]?.id as string ?? '',
    setStyles: (styles: string | [string, string]) => view?.renderer?.setStyles?.(styles),
    setLayout: (layout: EngineLayout) => {
      const renderer = view?.renderer
      if (!renderer) return
      // 顺序有意为之：先把不触发重排的设好，最后再设 max-inline-size（它会 render()）。
      renderer.setAttribute('gap', `${layout.columnGapPercent}%`)
      renderer.setAttribute('margin', `${layout.marginInline}px`)
      renderer.setAttribute('max-column-count', String(layout.columns))
      renderer.setAttribute('max-inline-size', `${layout.maxInlineSize}px`)
      // 供 E2E / 调试观测"我们要求了几栏"（真正是否生效由页数变化证明）。
      view?.setAttribute('data-hpf-columns', String(layout.columns))
    },
    getPageCount: () => {
      const renderer = view?.renderer as (HTMLElement & { pages?: number }) | undefined
      return typeof renderer?.pages === 'number' ? renderer.pages : 0
    },
    getCFI: (index: number, range: Range) => view?.getCFI(index, range) ?? '',
    addAnnotation: (annotation: { value: string; [key: string]: unknown }) => {
      return view?.addAnnotation?.(annotation) ?? Promise.resolve({ index: 0, label: '' })
    },
    deleteAnnotation: (annotation: { value: string; [key: string]: unknown }) => {
      return view?.deleteAnnotation?.(annotation) ?? Promise.resolve({ index: 0, label: '' })
    },
    search: (query: string, options?: { matchCase?: boolean }) => {
      if (!view?.search) {
        async function* empty() {}
        return empty()
      }
      return view.search({ query, matchCase: options?.matchCase })
    },
    clearSearch: () => {
      view?.clearSearch?.()
    },
    close,
  }
}
