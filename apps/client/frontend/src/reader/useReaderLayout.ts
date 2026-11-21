import { computed, type ComputedRef, type Ref } from 'vue'
import { useViewport, type Orientation } from '@/app/useViewport'

/**
 * ★ 阅读器的排版决策（task-12 §3）。
 *
 * 用户的硬要求：**窄屏竖屏单栏、宽屏横屏双栏或可折叠侧栏，两种方向都要能读，
 * 而且旋转后要重排且不丢位置**。
 *
 * 本文件把视口尺寸折算成 `columns` / `tocMode` 这类**意图**，
 * 再交给 useFoliateEngine.setLayout() 变成 paginator 的 attribute。
 *
 * 为什么不能只靠 CSS 媒体查询：foliate-js 的分栏是**算出来的**
 * （paginator 按容器宽度计算每栏宽度与页码），单纯改 CSS 不会让引擎重新分栏，
 * 必须把新的列数交给 `renderer.setAttribute('max-column-count', ...)`。
 *
 * 补充一个上游事实（vendored paginator.js:493）：paginator 自带
 * `@container (orientation: portrait)` → 竖屏时把
 * `--_max-column-count-spread` 切成 `--_max-column-count-portrait`（1 栏）。
 *
 * ★ task-17：这条 `@container` 是 **Chrome 105+** 才生效的，在老 WebView 上
 * 完全不应用。但它对我们**没有影响**，因为我们自己已经按同一个方向逻辑
 * 算出列数（`decide()`：竖屏 1 / 横屏且够宽 2），并通过 `setLayout` 写进
 * `max-column-count` 属性；而 spread 的默认值就是 `var(--_max-column-count)`。
 * 所以 @container 生效与不生效，最终 spread 的值**恰好相同**。
 * 真正"竖屏单栏"的保证来自这里的 `decide()`，不是上游那条容器查询。
 *
 * ★ 动效优化（本次新增）：**分栏与页边距改看"阅读面"的实测宽度，而不是窗口宽度**。
 *
 * 原来两者都取 `window.innerWidth`，于是有一个真实但不容易一眼看出的问题：
 * 宽屏下目录侧栏常驻（256px）、窄屏下有页边距，正文实际可用宽度比窗口小得多。
 * 1280px 窗口把侧栏算进去只剩 1024px，用窗口宽度判"够不够两栏"会把
 * 两条 400px 的窄栏塞给人读。改成按阅读面判，逻辑才对得上用户看到的东西。
 *
 * 这里刻意**不**引入反馈环：`tocMode`（要不要侧栏）只看窗口宽度，侧栏有没有
 * 显示不会反过来改变"要不要侧栏"的判断；`columns` 只看阅读面宽度，而分栏数
 * 也不会改变阅读面宽度。两条依赖都是单向的。
 *
 * ★ 缓存只比较**会改变 UI 的字段**：页边距是脚本侧（重排用的几何）单独现算的，
 * 不放进这个状态对象。否则拖动时每过几像素就是一个新的 `surfaceWidth`，
 * 缓存永远命中不了，工具栏会跟着每一帧重渲染 —— 而它并不需要知道页边距。
 */

export type TocMode = 'overlay' | 'sidebar'

export interface ViewerSize {
  width: number
  height: number
}

/** 交给 foliate 的几何（`useReaderLayout` 的决策结果 + 计算出来的边距）。 */
export interface ReaderGeometry {
  /** 1 | 2 栏。 */
  columns: 1 | 2
  /** 单栏正文宽度上限（px）。foliate 内部乘以列数得到整体最大宽度。 */
  maxInlineSize: number
  /** 当前阅读面下**允许**的最大页边距（真正的值取 min(用户设置, 这个)）。 */
  maxMarginInline: number
}

/** 只含"工具栏 / 目录要用"的字段。 */
export interface ReaderLayoutState {
  /** 窗口横竖屏（决定工具栏形态，与阅读面无关）。 */
  orientation: Orientation
  /** 窄屏：工具栏压缩成图标、目录走覆盖层。 */
  compact: boolean
  /** 宽屏横屏时目录常驻侧栏；否则覆盖层（不挤压正文宽度）。 */
  tocMode: TocMode
  /** 交给 foliate 分栏的列数（横屏且阅读面够宽才给 2）。 */
  columns: 1 | 2
}

/** 常驻侧栏要求**窗口**足够宽，并且是横屏（竖屏下侧栏会把正文挤没）。 */
const SIDEBAR_MIN_WIDTH = 1080
/**
 * 双栏要求**阅读面**足够宽。
 * 1024px 太保守：那是「两栏各 500px」的下限；这里取 960 是因为阅读面
 * 已经扣掉了侧栏与页边距，960 意味着两栏各约 480px，仍然好读。
 */
const TWO_COLUMN_MIN_WIDTH = 960
/** 单栏正文的可读行宽上限。 */
export const MAX_INLINE_SIZE = 720
/** 栏间距，foliate 按容器宽度的百分比解释。 */
export const COLUMN_GAP_PERCENT = 7

/**
 * 页边距随可用宽度走：窄屏 16px 起步，宽屏最多 64px。
 * ★ 量化到 4px 一档：否则每拖动 1px 都会产生一个新的几何值，
 *   下游（重排）就得跟着做无意义的微调。
 */
export function maxMarginFor(surfaceWidth: number): number {
  const raw = Math.min(64, Math.max(16, surfaceWidth * 0.05))
  return Math.round(raw / 4) * 4
}

export function decide(
  vp: { width: number; height: number; orientation: Orientation; compact: boolean },
  surfaceWidth: number,
): ReaderLayoutState {
  const { width, orientation, compact } = vp
  const tocMode: TocMode =
    !compact && orientation === 'landscape' && width >= SIDEBAR_MIN_WIDTH ? 'sidebar' : 'overlay'
  const columns: 1 | 2 =
    orientation === 'landscape' && surfaceWidth >= TWO_COLUMN_MIN_WIDTH ? 2 : 1

  return { orientation, compact, tocMode, columns }
}

function sameState(a: ReaderLayoutState, b: ReaderLayoutState): boolean {
  return a.orientation === b.orientation && a.compact === b.compact && a.tocMode === b.tocMode && a.columns === b.columns
}

/**
 * 随窗口尺寸变化的阅读器排版状态（只含 UI 字段）。
 *
 * @param surfaceSize 阅读面实测尺寸。拖动窗口时它每帧都在变，但这里**只在与
 *   决策有关的字段真的变了时才返回新对象**（否则缓存的对象会每帧换身份，
 *   让工具栏/目录这些依赖它的组件每帧重渲染一次）。
 */
export function useReaderLayout(
  surfaceSize?: Readonly<Ref<ViewerSize>>,
): ComputedRef<ReaderLayoutState> {
  const viewport = useViewport()
  let cache: ReaderLayoutState | null = null

  return computed(() => {
    const vp = viewport.value
    // 首次观测之前没有真实宽度，退回窗口宽度（只影响"够不够两栏"的判断，
    // 真正的初值由 ReaderView 的 onReady / 首次 ResizeObserver 观测回填）。
    const surfaceWidth = Math.round(surfaceSize?.value.width || vp.width)
    const next = decide(vp, surfaceWidth)
    if (cache !== null && sameState(cache, next)) return cache
    cache = next
    return next
  })
}
