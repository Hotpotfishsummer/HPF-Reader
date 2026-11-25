import { describe, expect, it, vi } from 'vitest'
import { togglePanel } from '../panelToggle'

/**
 * 这些用例锁死一个曾经真实发生、且肉眼极难发现的 bug：
 * 「Aa」排版按钮点了打不开。
 *
 * 原因：模板里写的是
 *   @toggle-typography="typographyOpen = !typographyOpen; ...; typographyOpen = false; ..."
 * —— 先翻转成 true，再在同一条语句里关掉自己。用户看到的现象就是"按钮没反应"。
 *
 * 现在翻转逻辑收敛到 togglePanel()，这里逐条钉住语义。
 */
describe('togglePanel（阅读器右侧面板互斥开关）', () => {
  it('关闭状态 → 打开', () => {
    expect(togglePanel(false)).toBe(true)
  })

  it('打开状态 → 关闭', () => {
    expect(togglePanel(true)).toBe(false)
  })

  it('★ 回归：打开后不会被"关闭其它面板"顺带关掉自己', () => {
    // 模拟真实调用：others 里刻意包含一个会把自己写回 false 的"错误"关闭动作，
    // 只要 togglePanel 在关别人**之后**才返回自己的新状态，结果就必须是 true。
    const self = { open: false }
    const next = togglePanel(self.open, [() => (self.open = false)])
    self.open = next
    expect(self.open).toBe(true)
  })

  it('打开时关掉其它所有面板（互斥）', () => {
    const closeAi = vi.fn()
    const closeGlossary = vi.fn()
    const closeSearch = vi.fn()

    const next = togglePanel(false, [closeAi, closeGlossary, closeSearch])

    expect(next).toBe(true)
    expect(closeAi).toHaveBeenCalledTimes(1)
    expect(closeGlossary).toHaveBeenCalledTimes(1)
    expect(closeSearch).toHaveBeenCalledTimes(1)
  })

  it('关闭时不碰其它面板（用户只是收起自己）', () => {
    const closeAi = vi.fn()

    const next = togglePanel(true, [closeAi])

    expect(next).toBe(false)
    expect(closeAi).not.toHaveBeenCalled()
  })

  it('不传 others 也能工作', () => {
    expect(togglePanel(false, [])).toBe(true)
    expect(togglePanel(true, [])).toBe(false)
  })

  it('连续点击两次回到原状态（幂等翻转）', () => {
    let open = false
    open = togglePanel(open)
    open = togglePanel(open)
    expect(open).toBe(false)
  })
})
