/**
 * iframe 事件桥接：章节文档里的输入不会自动冒泡到主文档，必须显式挂监听。
 * 做法照抄 docs/research/50-vue3-reader-stack.md §5.4，并补上清理纪律。
 */

export interface BridgeHandlers {
  /** 分页模式下 wheel 不滚文档，而是翻页（带阈值 + 去抖）。 */
  onWheel(deltaY: number): void
  onKey(event: KeyboardEvent): void
  onSelection(selection: { text: string; range: Range } | null): void
  /** 点击正文区域（用于翻页热区或菜单呼出）。 */
  onClick?(point: { clientX: number; clientY: number; innerWidth: number; innerHeight: number }): void
}

export interface BridgeOptions {
  /** wheel 累计多少像素才算一次翻页。 */
  wheelThreshold?: number
  /** wheel 冷却窗口（ms），防止单次滚动多翻。 */
  wheelCooldownMs?: number
  /** @deprecated 保留兼容 */
  wheelDebounceMs?: number
}

/**
 * 创建统一的滚轮翻页事件处理器（兼容普通物理滚轮与触控板连续滑动）。
 */
export function createWheelTurnHandler(
  onWheel: (deltaY: number) => void,
  options: BridgeOptions = {},
): (event: WheelEvent) => void {
  const threshold = options.wheelThreshold ?? 60
  const cooldownMs = options.wheelCooldownMs ?? options.wheelDebounceMs ?? 220
  let acc = 0
  let lastTriggerTime = 0
  let resetTimer: ReturnType<typeof setTimeout> | undefined

  return (event: WheelEvent) => {
    // 阻止浏览器对 #container 的原生失真滚动，确保翻页始终受引擎对齐约束
    event.preventDefault()

    let dy = event.deltaY
    if (event.deltaMode === 1) {
      dy *= 30
    } else if (event.deltaMode === 2) {
      dy *= 400
    }

    const now = performance.now()
    if (now - lastTriggerTime < cooldownMs) {
      acc = 0
      return
    }

    acc += dy
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      acc = 0
    }, 200)

    if (Math.abs(acc) >= threshold) {
      const delta = acc
      acc = 0
      lastTriggerTime = now
      if (resetTimer) clearTimeout(resetTimer)
      onWheel(delta)
    }
  }
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

  const ac = new AbortController()
  const { signal } = ac

  const wheelHandler = createWheelTurnHandler(handlers.onWheel, options)

  doc.addEventListener(
    'wheel',
    (event: Event) => wheelHandler(event as WheelEvent),
    { signal, passive: false },
  )

  doc.addEventListener('keydown', (event: Event) => handlers.onKey(event as KeyboardEvent), { signal })

  doc.addEventListener(
    'click',
    (event: MouseEvent) => {
      const sel = win.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().trim()) return
      const target = event.target as HTMLElement | null
      if (target?.closest?.('a, button, input')) return
      handlers.onClick?.({
        clientX: event.clientX,
        clientY: event.clientY,
        innerWidth: win.innerWidth,
        innerHeight: win.innerHeight,
      })
    },
    { signal },
  )

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
    ac.abort()
  }
}
