/**
 * iframe 事件桥接：章节文档里的输入不会自动冒泡到主文档，必须显式挂监听。
 * 做法照抄 docs/research/50-vue3-reader-stack.md §5.4，并补上清理纪律。
 *
 * ★ 动效/动线优化新增两项：
 *   - `onTap`：章节文档里的点击不冒泡到主文档，所以"点左三分之一上一页、
 *     点右三分之一下一页"必须在这里接（在阅读区上盖一层透明按钮会挡住划词）。
 *   - wheel 冷却：原来只要 50ms 内累计过阈值就翻页，连续滚轮/触控板会连翻好几页。
 *     现在一个手势最多翻一页，翻完有冷却窗口。
 */

export interface TapInfo {
  /** 点击位置在章节视口内的横向比例（0~1）。 */
  ratioX: number
  /** 点击位置在章节视口内的纵向比例（0~1）。 */
  ratioY: number
  /**
   * 触发这次点击的指针类型。
   *
   * ★ 触屏（touch/pen）上单击翻页要**延迟**一小段再执行：双击在本端用于切换顶部
   *   状态栏，如果单击立刻翻页，双击的第一次点击就先把页翻走了 —— 结果就是
   *   「想切状态栏，却先翻了一页」。ReaderView 用这个字段判断要不要走延迟窗口。
   */
  pointerType: 'mouse' | 'touch' | 'pen'
}

export interface BridgeHandlers {
  /** 分页模式下 wheel 不滚文档，而是翻页（带阈值 + 去抖 + 冷却）。 */
  onWheel(deltaY: number): void
  onKey(event: KeyboardEvent): void
  onSelection(selection: { text: string; range: Range } | null): void
  /** 章节内单击（已过滤掉拖拽划词、链接点击、双击）。 */
  onTap?(tap: TapInfo): void
  /**
   * 章节内双击。**只有触屏/触控笔会调用**（桌面端的状态栏由光标靠近触发，
   * 不抢"双击选词"的语义），用来切换顶部状态栏的显示。
   */
  onDoubleTap?(pointerType: TapInfo['pointerType']): void
  /**
   * 指针在章节文档内移动时，把指针的**页面纵坐标**报给宿主。
   *
   * ★ iframe 是 DOM 里的"洞"：指针落在 iframe 内时事件不会冒泡到主文档，
   *   主文档的 pointermove 收不到。状态栏要按"光标离阅读面顶部多近"判断，
   *   就必须由这边把坐标报回去（见 pointerPageY）。
   */
  onHover?(pageY: number): void
}

export interface BridgeOptions {
  /** wheel 累计多少像素才算一次翻页。 */
  wheelThreshold?: number
  /** wheel 去抖窗口（ms）：停止滚动多久后结算。 */
  wheelDebounceMs?: number
  /** 一次翻页后的冷却（ms）：这段时间内的滚动一律忽略。 */
  wheelCooldownMs?: number
  /**
   * 阅读面宿主元素。**翻页热区必须按阅读面算**，否则分栏排版下热区会整段错位
   * （见 toHostRatio 的说明）。
   */
  surface?: () => HTMLElement | null
}

/**
 * 把章节文档内的点击位置换算成**阅读面**的横向/纵向比例（0~1）。
 *
 * ★ 不能直接拿 `mouse.clientX / win.innerWidth` 当分母。实测（探针数据）在双栏排版下
 *   iframe 的视口宽度是**整章展开宽**（9523px），而阅读面只有 1024px —— 拿它当分母，
 *   整个屏幕的点击都会被算到 0.13 以内，翻页热区整段失效（点最右侧也被当成左侧）。
 *
 * 正确的换算：
 *   - `mouse.clientX` 是**iframe 视口内**的坐标，要加 `frameElement.getBoundingClientRect().left`
 *     才是页面坐标；
 *   - 再减去阅读面的 `left`、除以阅读面的 `width`，得到的才是"点在阅读面的哪个位置"。
 *
 * ★ 冻结期间 foliate-view 被 transform 缩放过，所以要用 rect 宽与布局宽的比反推缩放系数，
 *   否则缩放预览下算出来的位置依然是错的。
 */
function toHostRatio(
  win: Window,
  mouse: MouseEvent,
  surface: () => HTMLElement | null,
  pointerType: TapInfo['pointerType'],
): TapInfo {
  const frame = win.frameElement
  const rect = frame instanceof HTMLElement ? frame.getBoundingClientRect() : null
  const innerW = win.innerWidth || 1
  const innerH = win.innerHeight || 1
  const host = surface()
  const hostRect = host instanceof HTMLElement ? host.getBoundingClientRect() : null
  const scale =
    rect && frame instanceof HTMLElement ? (rect.width || innerW) / (frame.offsetWidth || innerW) : 1
  const hostW = hostRect?.width || innerW
  const hostH = hostRect?.height || innerH
  const offsetLeft = (rect?.left ?? 0) - (hostRect?.left ?? 0)
  const offsetTop = (rect?.top ?? 0) - (hostRect?.top ?? 0)
  return {
    ratioX: Math.min(1, Math.max(0, (offsetLeft + mouse.clientX * scale) / hostW)),
    ratioY: Math.min(1, Math.max(0, (offsetTop + mouse.clientY * scale) / hostH)),
    pointerType,
  }
}

/**
 * 把 iframe 内的指针纵坐标换算成**页面坐标**（状态栏"光标靠近顶部"的判定基准）。
 *
 * 只算 Y：状态栏只关心指针离阅读面顶部多近。换算逻辑与 toHostRatio 一致
 * （frame rect + 缩放系数），只是不做阅读面内的归一化 —— 宿主要的是原始页面 Y，
 * 好跟自己缓存的阅读面顶边直接比。
 */
function pointerPageY(win: Window, mouse: PointerEvent, surface: () => HTMLElement | null): number {
  const frame = win.frameElement
  if (!(frame instanceof HTMLElement)) return mouse.clientY
  const rect = frame.getBoundingClientRect()
  const innerH = win.innerHeight || 1
  const scale = (rect.height || innerH) / (frame.offsetHeight || innerH)
  return rect.top + mouse.clientY * scale
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
  const cooldownMs = options.wheelCooldownMs ?? 220

  const ac = new AbortController()
  const { signal } = ac
  let acc = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 上一次真正翻页的时间；冷却窗口内不再翻页。 */
  let lastTurnAt = -Infinity
  /** 本次指针按下时是否已经有选区（决定这次 click 是"划词"还是"点空白"）。 */
  let selectionAtPointerDown = false
  /**
   * 最近一次 pointerdown 的指针类型。
   *
   * ★ `MouseEvent` 不带 `pointerType`，但 click 之前必然有一次 pointerdown，
   *   在那里取一次就够了；取不到就按 mouse 处理（桌面端不需要延迟翻页）。
   */
  let lastPointerType: TapInfo['pointerType'] = 'mouse'

  doc.addEventListener(
    'wheel',
    (event: Event) => {
      const deltaY = (event as WheelEvent).deltaY
      const t = performance.now()
      if (t - lastTurnAt < cooldownMs) {
        // 冷却中：把累计量清掉，免得冷却一结束就"补翻"一页。
        acc = 0
        if (timer) clearTimeout(timer)
        timer = undefined
        return
      }
      acc += deltaY
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        if (Math.abs(acc) >= threshold) {
          lastTurnAt = performance.now()
          handlers.onWheel(acc)
        }
        acc = 0
      }, debounceMs)
    },
    { signal, passive: true },
  )

  doc.addEventListener('keydown', (event: Event) => handlers.onKey(event as KeyboardEvent), { signal })

  // ★ 指针在 iframe 内移动时主文档收不到（iframe 是 DOM 里的"洞"），
  //   状态栏的"光标靠近顶部"必须由这边把页面纵坐标报回宿主。
  if (handlers.onHover) {
    const onHover = handlers.onHover
    doc.addEventListener(
      'pointermove',
      (event: Event) => {
        onHover(pointerPageY(win, event as PointerEvent, options.surface ?? (() => null)))
      },
      { signal, passive: true },
    )
  }

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

  if (handlers.onTap || handlers.onDoubleTap) {
    const onTap = handlers.onTap
    doc.addEventListener(
      'pointerdown',
      (event: Event) => {
        const sel = win.getSelection()
        selectionAtPointerDown = Boolean(sel && !sel.isCollapsed && (sel.toString().trim() !== ''))
        const type = (event as PointerEvent).pointerType
        if (type === 'touch' || type === 'pen' || type === 'mouse') lastPointerType = type
      },
      { signal, passive: true },
    )
    doc.addEventListener(
      'click',
      (event: Event) => {
        const mouse = event as MouseEvent
        // 只处理主键。
        if (mouse.button !== 0) return
        // ★ 双击：交给 onDoubleTap（触屏上用于切换顶部状态栏），不翻页。
        //   改造前这里直接 return，双击除了"不翻页"什么都不做。
        if (mouse.detail > 1) {
          handlers.onDoubleTap?.(lastPointerType)
          return
        }
        // 划词刚结束：这次 click 是选区的副作用，不是"点空白翻页"。
        if (selectionAtPointerDown) {
          selectionAtPointerDown = false
          return
        }
        const sel = win.getSelection()
        if (sel && !sel.isCollapsed && sel.toString().trim() !== '') return
        // 链接交给引擎自己的 external-link 处理（脚注、超链接）。
        const target = mouse.target
        if (target instanceof Element && target.closest('a[href]')) return
        if (onTap) onTap(toHostRatio(win, mouse, options.surface ?? (() => null), lastPointerType))
      },
      { signal },
    )
  }

  return () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    ac.abort()
  }
}
