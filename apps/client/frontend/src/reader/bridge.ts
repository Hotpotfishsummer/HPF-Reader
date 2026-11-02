/**
 * iframe 事件桥接：章节文档里的输入不会自动冒泡到主文档，必须显式挂监听。
 * 做法照抄 docs/research/50-vue3-reader-stack.md §5.4，并补上清理纪律。
 */

export interface BridgeHandlers {
  /** 分页模式下 wheel 不滚文档，而是翻页（带阈值 + 去抖）。 */
  onWheel(deltaY: number): void
  onKey(event: KeyboardEvent): void
  onSelection(selection: { text: string; range: Range } | null): void
}

export interface BridgeOptions {
  /** wheel 累计多少像素才算一次翻页。 */
  wheelThreshold?: number
  /** wheel 去抖窗口（ms）。 */
  wheelDebounceMs?: number
}

/**
 * 给一个章节文档挂上桥接监听。
 * @returns 清理函数（必须在下一次 load / 组件卸载时调用）
 */
export function bridgeSectionDocument(
  doc: Document,
  handlers: BridgeHandlers,
  options: BridgeOptions = {},
): () => void {
  const win = doc.defaultView
  if (!win) return () => {}
  const threshold = options.wheelThreshold ?? 750
  const debounceMs = options.wheelDebounceMs ?? 50

  const ac = new AbortController()
  const { signal } = ac
  let acc = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  doc.addEventListener(
    'wheel',
    (event: Event) => {
      acc += (event as WheelEvent).deltaY
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (Math.abs(acc) >= threshold) handlers.onWheel(acc)
        acc = 0
      }, debounceMs)
    },
    { signal, passive: true },
  )

  doc.addEventListener('keydown', (event: Event) => handlers.onKey(event as KeyboardEvent), { signal })

  // ★ 必须用 iframe 自己的 selectionchange：主文档的 selection 看不到 iframe 内选区。
  doc.addEventListener(
    'selectionchange',
    () => {
      const sel = win.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return handlers.onSelection(null)
      const text = sel.toString().trim()
      if (!text) return handlers.onSelection(null)
      // ★ cloneRange：直接持有活 Range 会在下一次选择时被浏览器改写。
      handlers.onSelection({ text, range: sel.getRangeAt(0).cloneRange() })
    },
    { signal },
  )

  return () => {
    if (timer) clearTimeout(timer)
    ac.abort()
  }
}
