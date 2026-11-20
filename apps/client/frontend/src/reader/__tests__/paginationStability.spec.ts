import { describe, expect, it, vi } from 'vitest'
import { COLUMN_GAP_PERCENT } from '../useReaderLayout'
import '../../vendor/foliate-js/paginator.js'

describe('Pagination & Layout Stability', () => {
  it('数学验证：columnWidth 不截断消除多页累积像素漂移', () => {
    // 模拟测试多种常见缩放与窗口尺寸
    const testCases = [
      { size: 1180, maxColumnCount: 2, maxInlineSize: 720 },
      { size: 953.5, maxColumnCount: 2, maxInlineSize: 720 },
      { size: 847.25, maxColumnCount: 2, maxInlineSize: 720 },
      { size: 615.8, maxColumnCount: 1, maxInlineSize: 720 },
    ]

    for (const { size, maxColumnCount, maxInlineSize } of testCases) {
      const g = COLUMN_GAP_PERCENT / 100
      const gap = -g / (g - 1) * size
      const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
      const exactColumnWidth = (size / divisor) - gap
      const truncatedColumnWidth = Math.trunc(exactColumnWidth)

      // 精确值：两栏加边距必须严格等于页面尺寸 size
      const exactTotalSpread = divisor * (exactColumnWidth + gap)
      expect(Math.abs(exactTotalSpread - size)).toBeLessThan(1e-10)

      // 对比旧的截断逻辑：如果存在小数，截断会导致累积漂移
      const fractionalPart = exactColumnWidth - truncatedColumnWidth
      if (fractionalPart > 0.001) {
        const driftPerPage = divisor * fractionalPart
        const driftOver30Pages = driftPerPage * 30
        // 截断逻辑会在30页后累积显著漂移（漏出上一页内容）
        expect(driftOver30Pages).toBeGreaterThan(0.5)
      }
    }
  })

  it('Paginator #scrollToRect 亚像素容差计算与边界安全截断', () => {
    // 模拟 Paginator 中的计算公式
    function calculatePage(offset: number, size: number, pages: number, rtl: boolean): number {
      const rawPage = Math.floor((offset + (rtl ? -0.5 : 0.5)) / size) + (rtl ? -1 : 1)
      const maxPage = Math.max(1, pages - 2)
      return Math.max(1, Math.min(maxPage, rawPage))
    }

    const size = 800
    const totalPages = 10 // 页面有效索引为 1..8

    // 1. 正常第一页起点
    expect(calculatePage(0, size, totalPages, false)).toBe(1)

    // 2. 亚像素轻微负值（如由于字体抗锯齿或外边距偏移 -0.05px），不应跳到第0页（空白页）
    expect(calculatePage(-0.05, size, totalPages, false)).toBe(1)
    expect(calculatePage(-0.4, size, totalPages, false)).toBe(1)

    // 3. 第二页起点处发生 -0.05px 亚像素抖动（offset = 799.95px），应安全判定为第2页，而不是倒退回第1页
    expect(calculatePage(799.95, size, totalPages, false)).toBe(2)
    expect(calculatePage(800.0, size, totalPages, false)).toBe(2)
    expect(calculatePage(800.05, size, totalPages, false)).toBe(2)

    // 4. 第一页末尾文字（留有 gap 边距，如 offset = 760px），应正确属于第1页
    expect(calculatePage(760, size, totalPages, false)).toBe(1)

    // 5. 超出书籍边界的超大 offset，应被夹紧在最后一页有效内容（8），避免越界空白
    expect(calculatePage(99999, size, totalPages, false)).toBe(8)
  })

  it('Paginator attributeChangedCallback 对 max-inline-size 触发 render 重排', () => {
    const paginator = document.createElement('foliate-paginator') as any
    document.body.appendChild(paginator)

    const renderSpy = vi.spyOn(paginator, 'render').mockImplementation(() => {})

    // 变更 max-inline-size（foliate-js 原生显式触发 render）
    paginator.setAttribute('max-inline-size', '720px')

    expect(renderSpy).toHaveBeenCalled()

    paginator.remove()
  })

  it('Paginator size 抗 CSS scale 变形保护计算验证', () => {
    function computeEffectiveSize(
      isVertical: boolean,
      container: { clientWidth: number; clientHeight: number; getBoundingClientRect: () => DOMRect },
    ): number {
      const rect = container.getBoundingClientRect()
      if (isVertical) {
        const clientH = container.clientHeight
        return clientH > 0 && Math.abs(rect.height - clientH) >= 1 ? clientH : rect.height
      } else {
        const clientW = container.clientWidth
        return clientW > 0 && Math.abs(rect.width - clientW) >= 1 ? clientW : rect.width
      }
    }

    const unscaledContainer = {
      clientWidth: 952,
      clientHeight: 600,
      getBoundingClientRect: () => ({ width: 952.32, height: 600 } as DOMRect),
    }

    // 未缩放状态下保持亚像素精度
    expect(computeEffectiveSize(false, unscaledContainer)).toBe(952.32)

    // 缩放状态下 (scale 0.98 -> 933.27px)，自动回退到真实 clientWidth (952px)，防止翻页累积漂移
    const scaledContainer = {
      clientWidth: 952,
      clientHeight: 600,
      getBoundingClientRect: () => ({ width: 933.27, height: 588 } as DOMRect),
    }
    expect(computeEffectiveSize(false, scaledContainer)).toBe(952)
    expect(computeEffectiveSize(true, scaledContainer)).toBe(600)
  })
})
