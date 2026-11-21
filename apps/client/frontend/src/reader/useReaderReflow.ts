import { onScopeDispose } from 'vue'

/**
 * ★ 阅读面重排调度器（"拖动时零重排"的核心）。
 *
 * ── 为什么要它 ────────────────────────────────────────────────────────────
 * 实测基线（apps/client/evidence/optimization-reflow-baseline.json）：
 * 拖动阅读面宽度时，**每一步尺寸变化平均花掉 7.5ms 主线程时间、触发 2 次重排**。
 * 7.5ms 是什么概念：
 *   - 60Hz  每帧预算 16.7ms → 勉强塞得下，所以"看起来还行"；
 *   - 120Hz 每帧预算 8.3ms  → **一步就用掉一整帧**；
 *   - 144Hz 每帧预算 6.9ms  → 每步都超预算。
 * 也就是说"高刷不适配"不是玄学：正文的逐帧重排本来就吃满了一整帧。
 * 再叠上原来 `reflow` 的 150ms 防抖（几何要等手停下才更新），
 * 拖动过程中正文就是"跟不动 + 最后猛跳一下" = 用户说的阻滞感。
 *
 * ── 做法 ──────────────────────────────────────────────────────────────────
 * 不再"每帧重新分栏"，而是把一次拖拽拆成三段：
 *
 *   ① 起手（第 1 次尺寸变化）：等 2 帧再落定。如果用户只是点了个按钮改尺寸
 *      （侧栏开合这类离散变化），第 2 帧就到了，直接正常重排 1 次 —— 没有副作用。
 *   ② 连续（第 2 次变化在 100ms 内到达）：**冻结排版**。
 *      把 foliate-view 的尺寸钉死在冻结那一刻的像素值，然后用 transform 缩放
 *      贴合新尺寸。因为元素自身的尺寸不变，paginator 内部
 *      `new ResizeObserver(() => this.render())`（paginator.js:430）**一次都不会触发**。
 *      逐帧成本从 7.5ms 掉到"写一个 transform"，全部在合成线程上跑。
 *   ③ 落定（最后一次变化后静置 130ms）：先把新几何写进引擎，再解除冻结。
 *      顺序很关键 —— 这样"容器尺寸变化 → 重排"那一次读到的已经是新几何，
 *      **整段拖拽只重排 1 次**，而不是 N 次。
 *
 * ── 视觉代价 ──────────────────────────────────────────────────────────────
 * 冻结期间正文是被等比缩放的（像"缩放预览"），落定时在同一帧里换成真实分栏，
 * 尺寸是连续的（缩放比例正好等于新尺寸/旧尺寸），所以只在落定那一帧发生
 * "断行重排"，不会有尺寸跳变。这已经是不重排前提下能做到的最小视觉不连续。
 *
 * 同一个机制顺带解决了**字号滑杆**：字号 18→20 时 `scale(20/18)` 的视觉效果
 * 和真实改字号完全一致，于是拖滑杆时不再需要"每 150ms 才重排一次"，
 * 而是逐帧顺滑放大、松手后落定重排。
 */

/** 两次尺寸变化间隔小于它 → 认为用户还在连续拖动。 */
const STREAM_GAP_MS = 100
/** 最后一次变化后静置多久算"落定"。 */
const SETTLE_MS = 130
/** 离散变化的落定延迟：留 2 帧给"第 2 次变化"插队。 */
const DISCRETE_FRAMES = 2

export interface ReflowGeometry {
  columns: 1 | 2
  maxInlineSize: number
  marginInline: number
  columnGapPercent: number
}

export interface ReaderReflowOptions {
  /** 阅读面宿主（foliate-view 的父元素）。 */
  surface: () => HTMLElement | null
  /** 当前应采用的几何（每次落定时重新求值，不在调用方缓存）。 */
  geometry: () => ReflowGeometry
  /** 把几何写进引擎（paginator attribute）。这里**不该**顺带重写样式表。 */
  applyLayout: (geometry: ReflowGeometry) => void
  /** 需要时才重写章节文档样式表（字号/行高/主题变了才调用）。 */
  applyStyles?: () => void
  /** 重排后把阅读位置拉回。 */
  restore?: () => void
  /** 阅读面尺寸的每次观测（含拖动中途），供排版决策读取。 */
  onSize?: (width: number, height: number) => void
  /** 冻结状态变化（供 UI / E2E 观测"此刻是否处于排版冻结中"）。 */
  onFreezeChange?: (frozen: boolean) => void
  /**
   * 是否允许"冻结 + 缩放跟随"（默认允许）。
   *
   * 电子墨水屏建议关掉：缩放滚动会在墨水屏上留下明显拖影，
   * 那种设备宁可"一次到位地跳一下"，也不要连续变化的画面。
   */
  allowFreeze?: () => boolean
  /** 未就绪 / 加载中时不做任何重排。 */
  enabled: () => boolean
}

export interface ReaderReflow {
  /**
   * 开始观察阅读面尺寸。
   *
   * 为什么不在 useReaderReflow() 里直接 observe：`surface` 是模板 ref，
   * setup 阶段还没挂载；由组件在 onMounted 里调一次最稳。
   */
  attach: () => void
  /** 当前是否处于"排版已冻结"状态（翻页等操作应避开这个窗口）。 */
  frozen: () => boolean
  /**
   * 只做合成层缩放预览，**不重排**。
   * @param factor 目标尺寸 / 冻结时尺寸（字号 18→20 就是 20/18）
   * @param stylesDirty 落定时是否需要重写样式表（字号/行高 = true）
   */
  previewScale: (factor: number, stylesDirty?: boolean) => void
  /** 立刻重排（离散改动，例如页边距、主题）。 */
  reflowNow: (stylesDirty?: boolean) => void
  dispose: () => void
}

export function useReaderReflow(options: ReaderReflowOptions): ReaderReflow {
  let surface: HTMLElement | null = null
  let observer: ResizeObserver | null = null

  /** 冻结中的实例（每次冻结/落定都重新取，避免书换了留下旧引用）。 */
  let frozenView: HTMLElement | null = null
  let frozen = false
  let baseW = 0
  let baseH = 0
  /** 冻结期间最新一次得到的宿主尺寸（来自 ResizeObserver 的 contentRect）。 */
  let latestW = 0
  let latestH = 0
  /** 预览缩放系数（字号滑杆用），与宿主尺寸缩放相乘。 */
  let previewK = 1
  let stylesDirty = false

  let transformFrame = 0
  let discreteFrame = 0
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let lastResizeAt = -Infinity
  let firstObservation = true
  let disposed = false

  function now(): number {
    return performance.now()
  }

  /** 是否允许"冻结 + 缩放跟随"。默认允许。 */
  const canFreeze = (): boolean => (options.allowFreeze === undefined ? true : options.allowFreeze())

  function viewElement(): HTMLElement | null {
    if (!surface) surface = options.surface()
    const host = surface
    if (!host) return null
    const child = host.firstElementChild
    return child instanceof HTMLElement ? child : null
  }

  function clearSettle(): void {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer)
      settleTimer = undefined
    }
  }

  function cancelDiscrete(): void {
    if (discreteFrame !== 0) {
      cancelAnimationFrame(discreteFrame)
      discreteFrame = 0
    }
  }

  function writeTransform(): void {
    if (!frozen || !frozenView) return
    if (baseW <= 0 || baseH <= 0) return
    const sx = (latestW / baseW) * previewK
    const sy = (latestH / baseH) * previewK
    frozenView.style.transform = `scale(${sx.toFixed(5)}, ${sy.toFixed(5)})`
  }

  /** 同一帧内多次变化只写一次 transform（ResizeObserver 本身已按帧批量，这里是兜底）。 */
  function queueTransform(): void {
    if (transformFrame !== 0) return
    transformFrame = requestAnimationFrame(() => {
      transformFrame = 0
      writeTransform()
    })
  }

  /**
   * 冻结排版：把 foliate-view 的尺寸钉死成当前像素值，之后只靠 transform 跟手。
   * @returns 是否成功进入冻结（未就绪 / 尺寸为 0 时返回 false，调用方退回"直接重排"）
   */
  function freeze(): boolean {
    if (frozen) return true
    const view = viewElement()
    if (!view) return false
    const box = view.getBoundingClientRect()
    if (box.width < 2 || box.height < 2) return false

    cancelDiscrete()
    clearSettle()
    frozenView = view
    baseW = box.width
    baseH = box.height
    latestW = box.width
    latestH = box.height
    previewK = 1
    frozen = true

    // ★ 顺序与取值都有讲究：
    //   - position: absolute 让它脱离宿主的内容流，宿主变窄不会挤压它；
    //   - width/height 用**像素**钉死，这样 paginator 内部容器的 border-box 不变
    //     → 它的 ResizeObserver 不触发 → 完全不重排。
    view.style.position = 'absolute'
    view.style.left = '0'
    view.style.top = '0'
    view.style.width = `${baseW}px`
    view.style.height = `${baseH}px`
    view.style.transformOrigin = '0 0'
    view.style.willChange = 'transform'
    view.style.transform = 'scale(1, 1)'
    options.onFreezeChange?.(true)
    return true
  }

  function unfreeze(): void {
    const view = frozenView
    const wasFrozen = frozen
    frozenView = null
    frozen = false
    previewK = 1
    if (transformFrame !== 0) {
      cancelAnimationFrame(transformFrame)
      transformFrame = 0
    }
    if (!view) {
      if (wasFrozen) options.onFreezeChange?.(false)
      return
    }
    // 只清我们自己写过的内联样式，不碰别的。
    view.style.position = ''
    view.style.left = ''
    view.style.top = ''
    view.style.width = ''
    view.style.height = ''
    view.style.transform = ''
    view.style.transformOrigin = ''
    view.style.willChange = ''
    if (wasFrozen) options.onFreezeChange?.(false)
  }

  /** 把"新几何（必要时还有新样式）+ 解除冻结"放进同一个任务里，保证只重排一次。 */
  function commit(): void {
    clearSettle()
    cancelDiscrete()
    if (!options.enabled()) {
      unfreeze()
      return
    }
    // ★ 先写几何、必要时写样式，最后才解除冻结：
    //   解除冻结会让容器尺寸变化 → paginator 的 ResizeObserver 触发 render()，
    //   那一次读到的已经是新几何/新样式，所以整段拖拽只重排这一次。
    const needStyles = stylesDirty
    stylesDirty = false
    if (needStyles) options.applyStyles?.()
    options.applyLayout(options.geometry())
    unfreeze()
    options.restore?.()
  }

  function scheduleSettle(): void {
    clearSettle()
    settleTimer = setTimeout(() => {
      settleTimer = undefined
      if (disposed) return
      commit()
    }, SETTLE_MS)
  }

  /** 离散变化：等 2 帧。给"其实用户是在拖"留出插队的机会。 */
  function scheduleDiscrete(): void {
    cancelDiscrete()
    discreteFrame = requestAnimationFrame(() => {
      discreteFrame = requestAnimationFrame(() => {
        discreteFrame = 0
        if (disposed) return
        commit()
      })
    })
  }

  function handleResize(width: number, height: number): void {
    if (!options.enabled()) return
    const t = now()
    const streaming = t - lastResizeAt < STREAM_GAP_MS
    lastResizeAt = t
    latestW = width
    latestH = height
    options.onSize?.(width, height)

    if (!frozen) {
      // 连续拖动的第 2 帧起才冻结：第 1 帧不冻结也不重排（离散操作由 scheduleDiscrete 落定）。
      if (streaming && canFreeze() && freeze()) {
        queueTransform()
        scheduleSettle()
        return
      }
      scheduleDiscrete()
      return
    }
    queueTransform()
    scheduleSettle()
  }

  function attach(): void {
    if (observer || disposed) return
    surface = options.surface()
    if (!surface) return
    observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      const box = entry.contentRect
      if (firstObservation) {
        firstObservation = false
        lastResizeAt = -Infinity
        // 首次观测不是"尺寸变化"，但排版需要一个真实初值（窗口宽度 ≠ 阅读面宽度）。
        options.onSize?.(box.width, box.height)
        return
      }
      handleResize(box.width, box.height)
    })
    observer.observe(surface)
  }

  onScopeDispose(() => {
    disposed = true
    clearSettle()
    cancelDiscrete()
    observer?.disconnect()
    observer = null
  })

  return {
    attach,
    frozen: () => frozen,
    previewScale(factor: number, dirtyStyles = false): void {
      if (!options.enabled()) return
      if (!Number.isFinite(factor) || factor <= 0) return
      if (factor === 1 && !frozen) return
      if (!frozen) {
        surface = surface ?? options.surface()
        const host = surface
        if (!host) return
        const box = host.getBoundingClientRect()
        if (!freeze()) return
        latestW = box.width
        latestH = box.height
      }
      previewK = factor
      if (dirtyStyles) stylesDirty = true
      writeTransform()
      scheduleSettle()
    },
    reflowNow(dirtyStyles = false): void {
      if (dirtyStyles) stylesDirty = true
      if (disposed) return
      if (!options.enabled()) {
        unfreeze()
        return
      }
      commit()
    },
    dispose(): void {
      disposed = true
      clearSettle()
      cancelDiscrete()
      observer?.disconnect()
      observer = null
      unfreeze()
    },
  }
}

/** 供测试与调试：暴露常量，避免测试里再写一遍魔法数字。 */
export const REFLOW_TIMINGS = { STREAM_GAP_MS, SETTLE_MS, DISCRETE_FRAMES } as const
