import { computed, type ComputedRef } from 'vue'
import { useViewport, type Orientation } from '@/app/useViewport'

/**
 * ★ 阅读器的排版决策（task-12 §3）。
 *
 * 用户的硬要求：**窄屏竖屏单栏、宽屏横屏双栏或可折叠侧栏，两种方向都要能读，
 * 而且旋转后要重排且不丢位置**。
 *
 * 本文件把 useViewport() 的原始尺寸折算成 `columns` / `tocMode` 这类**意图**，
 * 再交给 useFoliateEngine.setLayout() 变成 paginator 的 attribute。
 *
 * 为什么不能只靠 CSS 媒体查询：foliate-js 的分栏是**算出来的**
 * （paginator 按容器宽度计算每栏宽度与页码），单纯改 CSS 不会让引擎重新分栏，
 * 必须把新的列数交给 `renderer.setAttribute('max-column-count', ...)`。
 *
 * 补充一个上游事实（vendored paginator.js:493）：paginator 自带
 * `@container (orientation: portrait)` → 强制 `--_max-column-count-portrait: 1`。
 * 也就是说"竖屏单栏"是引擎原生保证的，我们只在横屏时决定"最多几栏"。
 */

export type TocMode = 'overlay' | 'sidebar'

export interface ReaderLayoutState {
  width: number
  height: number
  orientation: Orientation
  compact: boolean
  /** 宽屏横屏时目录常驻侧栏；否则覆盖层（不挤压正文宽度）。 */
  tocMode: TocMode
  /** 交给 foliate 分栏的列数（landscape 且够宽才给 2）。 */
  columns: 1 | 2
  /** 单栏正文宽度上限（px）。foliate 内部乘以列数得到整体最大宽度。 */
  maxInlineSize: number
  /** 当前窗口下**允许**的最大页边距（真正的值取 min(用户设置, 这个)）。 */
  maxMarginInline: number
}

/** 常驻侧栏要求足够宽，**并且**是横屏（竖屏下侧栏会把正文挤没）。 */
const SIDEBAR_MIN_WIDTH = 1080
/** 双栏要求足够宽，**并且**是横屏（竖屏下两栏会窄到没法读）。 */
const TWO_COLUMN_MIN_WIDTH = 1024
/** 单栏正文的可读行宽上限。 */
const MAX_INLINE_SIZE = 720
/** 栏间距，foliate 按容器宽度的百分比解释。 */
export const COLUMN_GAP_PERCENT = 7

function decide(vp: { width: number; height: number; orientation: Orientation; compact: boolean }): ReaderLayoutState {
  const { width, orientation, compact } = vp
  const tocMode: TocMode =
    !compact && orientation === 'landscape' && width >= SIDEBAR_MIN_WIDTH ? 'sidebar' : 'overlay'
  const columns: 1 | 2 = orientation === 'landscape' && width >= TWO_COLUMN_MIN_WIDTH ? 2 : 1

  // 页边距随宽度走：窄屏 16px 起步，宽屏最多 64px。
  const maxMarginInline = Math.round(Math.min(64, Math.max(16, width * 0.05)))

  return {
    ...vp,
    tocMode,
    columns,
    maxInlineSize: MAX_INLINE_SIZE,
    maxMarginInline,
  }
}

/** 随窗口尺寸变化的阅读器排版状态。 */
export function useReaderLayout(): ComputedRef<ReaderLayoutState> {
  const viewport = useViewport()
  return computed(() => decide(viewport.value))
}
