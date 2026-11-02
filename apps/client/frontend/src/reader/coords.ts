/**
 * 坐标系换算：阅读器里最容易出错的一块，全部集中在这里（不许散落各组件）。
 *
 * 三个坐标空间（docs/research/50-vue3-reader-stack.md §5.5）：
 *   A. iframe 视口坐标   —— 在**章节文档内**调用 Range.getClientRects() 得到
 *   B. 主文档视口坐标     —— 在主文档里 getBoundingClientRect() 得到（position: fixed 用）
 *   C. 主文档页面坐标     —— B + window.scrollX/Y（position: absolute 用）
 *
 * 关键事实：overlayer 的 SVG 不在 iframe 里，而在 foliate-paginator 的 shadow root 里、
 * 尺寸与 iframe 对齐 —— 所以 overlayer 用的就是空间 A，而主文档浮层必须做换算。
 */

/** iframe 内容盒在"主文档视口"中的矩形（扣掉 border 与 padding）。 */
export function iframeContentRect(iframe: HTMLIFrameElement): DOMRect {
  const r = iframe.getBoundingClientRect()
  const cs = getComputedStyle(iframe)
  const px = (v: string): number => Number.parseFloat(v) || 0
  const left = px(cs.borderLeftWidth) + px(cs.paddingLeft)
  const top = px(cs.borderTopWidth) + px(cs.paddingTop)
  const right = px(cs.borderRightWidth) + px(cs.paddingRight)
  const bottom = px(cs.borderBottomWidth) + px(cs.paddingBottom)
  return new DOMRect(r.left + left, r.top + top, r.width - left - right, r.height - top - bottom)
}

/** A → B：iframe 视口坐标 → 主文档视口坐标（position: fixed 的浮层用）。 */
export function toViewportRect(rangeRect: DOMRect, iframe: HTMLIFrameElement): DOMRect {
  const base = iframeContentRect(iframe)
  return new DOMRect(
    base.left + rangeRect.left,
    base.top + rangeRect.top,
    rangeRect.width,
    rangeRect.height,
  )
}

/** B → C：主文档视口坐标 → 主文档页面坐标（position: absolute 的浮层用）。 */
export function toPageRect(viewportRect: DOMRect, win: Window = window): DOMRect {
  return new DOMRect(
    viewportRect.left + win.scrollX,
    viewportRect.top + win.scrollY,
    viewportRect.width,
    viewportRect.height,
  )
}

/**
 * 该 rect 是否真的落在 iframe 可见区域内。
 *
 * ⚠️ 分页模式用 CSS 多列：一个 Range 的 getClientRects() 会返回**跨列的多段矩形**，
 * 其中包含当前不可见列（坐标为很大的负数或超出视口）。
 * 高亮绘制不受影响（overlayer 会画全部列），**只有"瞄准点"必须过滤**，
 * 否则气泡会飘到屏幕外。
 */
export function isVisibleInIframe(rect: DOMRect, iframe: HTMLIFrameElement): boolean {
  return (
    rect.bottom > 0
    && rect.top < iframe.clientHeight
    && rect.right > 0
    && rect.left < iframe.clientWidth
  )
}

/** 从一组候选矩形里挑"最后一行"作为气泡锚点（更符合直觉）。 */
export function pickAnchorRect(rects: DOMRect[]): DOMRect | null {
  if (rects.length === 0) return null
  return rects.reduce((a, b) => {
    if (b.bottom > a.bottom) return b
    if (b.bottom === a.bottom && b.right > a.right) return b
    return a
  })
}

/** 便捷组合：把 Range 的客户端矩形换算成主文档视口锚点。 */
export function anchorFromRange(
  range: Range,
  iframe: HTMLIFrameElement,
): { rect: DOMRect; visibleRectCount: number } | null {
  const all = Array.from(range.getClientRects())
  const visible = all.filter((r) => isVisibleInIframe(r, iframe))
  const picked = pickAnchorRect(visible)
  if (!picked) return null
  return { rect: toViewportRect(picked, iframe), visibleRectCount: visible.length }
}
