/**
 * JS 驱动的动效工具（只有"必须由 JS 决定时机"的动效才放这里）。
 *
 * 为什么用 Web Animations API 而不是加一个 CSS class：
 *   1. 翻页提示需要**打断**上一次动画（连按方向键时不能排队，否则越按越慢）；
 *   2. 动画结束后必须干净地回到"没有 transform"的状态，class 方案要靠
 *      animationend 事件或 setTimeout 清理，容易残留；
 *   3. WAAPI 的 transform/opacity 动画直接跑在合成线程上，
 *      与主线程的重排解耦 —— 这正是高刷屏能跑满 120/144Hz 的前提。
 *
 * 时长与缓动刻意与 styles/motion.css 的 `--dur-*` / `--ease-*` 对齐：
 * CSS 动画和 JS 动画如果各用一套时间轴，同一个界面里会出现"两种手感"。
 */

/** 与 motion.css 的 `--dur-3` / `--ease-out` 保持一致。 */
const CUE_DURATION_MS = 200
const CUE_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'
const CUE_DISTANCE_PX = 10

/** 系统是否要求弱动效。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const runningCues = new WeakMap<HTMLElement, Animation>()

/**
 * 翻页方向提示：新的一页从对应方向"落定"进来（位移 + 淡入），
 * 用来**盖住** paginator 一次性 scrollLeft 跳变带来的突兀感。
 *
 * ★ 只动 transform / opacity，不碰任何布局属性。
 * ★ 位移用 translate3d：强制走合成层，避免和宿主上的缩放预览打架。
 *
 * @param direction `next` 从右侧进、`prev` 从左侧进
 */
export function pageTurnCue(
  el: HTMLElement | null,
  direction: 'next' | 'prev',
  options: { durationMs?: number; distancePx?: number } = {},
): void {
  if (!el || typeof el.animate !== 'function') return
  if (prefersReducedMotion()) return

  const duration = options.durationMs ?? CUE_DURATION_MS
  const distance = options.distancePx ?? CUE_DISTANCE_PX
  const from = direction === 'next' ? distance : -distance

  runningCues.get(el)?.cancel()
  const animation = el.animate(
    [
      { opacity: 0.78, transform: `translate3d(${from}px, 0, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    ],
    { duration, easing: CUE_EASING, fill: 'none' },
  )
  runningCues.set(el, animation)
  animation.addEventListener('finish', () => {
    if (runningCues.get(el) === animation) runningCues.delete(el)
  })
}

/** 取消在跑的翻页提示（例如窗口开始缩放时，别让两套 transform 叠在一起）。 */
export function cancelPageTurnCue(el: HTMLElement | null): void {
  if (!el) return
  const animation = runningCues.get(el)
  if (!animation) return
  animation.cancel()
  runningCues.delete(el)
}
