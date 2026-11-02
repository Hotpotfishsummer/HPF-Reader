import { expect, test } from '@playwright/test'

/**
 * 阅读器冒烟：在真实 Chromium 里打开内置示例 EPUB，断言**引擎的稳定输出**，
 * 而不是截图或像素（§11 的建议：断言 lastLocation.cfi / relocate.fraction / overlayer 数量）。
 */

declare global {
  interface Window {
    __hpfRelocates?: Array<{ index: number; fraction: number; cfi: string }>
  }
}

test.describe('阅读器（真实 EPUB）', () => {
  test('能打开示例书、完成分页、并施加 L2 净化', async ({ page }) => {
    // 区分两类"错误"：
    //   ① 真正的 JS 异常 / pageerror —— 必须为 0；
    //   ② 网络 404 —— 只允许"没有后端时进度上报失败"这一条（E2E 不启动 Go 服务）。
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    const notFound: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('response', (res) => {
      if (res.status() === 404) notFound.push(new URL(res.url()).pathname)
    })

    await page.goto('/#/reader/sample')

    // 1) foliate-view custom element 被创建（命令式 API，模板里没有它）
    const view = page.locator('foliate-view')
    await expect(view).toHaveCount(1, { timeout: 30_000 })

    // 2) 等到引擎真的排版完成（lastLocation.cfi 有值 = 分页成功）
    await page.waitForFunction(
      () => {
        const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
        return Boolean(el?.lastLocation?.cfi)
      },
      undefined,
      { timeout: 30_000 },
    )

    // 3) 章节文档里必须存在我们注入的 meta CSP（L2 的硬指标）
    const csp = await page.evaluate(() => {
      const el = document.querySelector('foliate-view') as unknown as {
        renderer?: { getContents?: () => Array<{ doc: Document }> }
      } | null
      const doc = el?.renderer?.getContents?.()[0]?.doc
      if (!doc) return null
      const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')
      return {
        content: meta?.getAttribute('content') ?? null,
        scripts: doc.querySelectorAll('script').length,
        anchors: doc.querySelectorAll('a[href]').length,
        remoteRefs: Array.from(doc.querySelectorAll('[src],[href]')).filter((n) => {
          const v = n.getAttribute('src') ?? n.getAttribute('href') ?? ''
          return /^(https?:)?\/\//i.test(v)
        }).length,
        text: (doc.body?.textContent ?? '').slice(0, 40),
      }
    })

    expect(csp).not.toBeNull()
    expect(csp?.content).toBe("default-src 'none'; script-src 'none'; img-src data: blob:; style-src 'unsafe-inline'")
    expect(csp?.scripts).toBe(0)
    expect(csp?.remoteRefs).toBe(0)
    // 正文确实排出来了（示例书第一章的第一句）
    expect(csp?.text ?? '').toContain('HPF Reader')

    // 4) 外链样式表被内联为 <style>（既保排版又不放宽 CSP）
    const inlinedStyle = await page.evaluate(() => {
      const el = document.querySelector('foliate-view') as unknown as {
        renderer?: { getContents?: () => Array<{ doc: Document }> }
      } | null
      const doc = el?.renderer?.getContents?.()[0]?.doc
      if (!doc) return { links: -1, styleText: '' }
      return {
        links: doc.querySelectorAll('link[rel="stylesheet"]').length,
        styleText: Array.from(doc.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n'),
      }
    })
    expect(inlinedStyle.links).toBe(0)
    expect(inlinedStyle.styleText).toContain('line-height') // 来自 styles.css

    // 5) 翻页：cfi 必须变化（引擎的稳定输出）
    const before = await page.evaluate(() =>
      (document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null)
        ?.lastLocation?.cfi ?? '',
    )
    await page.getByRole('button', { name: /下一页|Next/ }).click()
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
        const now = el?.lastLocation?.cfi ?? ''
        return now !== '' && now !== prev
      },
      before,
      { timeout: 15_000 },
    )

    // 留下视觉证据（人工复核排版用）
    await page.screenshot({ path: 'test-results/reader-sample.png' })

    // 没有 JS 异常
    expect(pageErrors, pageErrors.join('\n')).toEqual([])
    // 控制台错误只允许"资源 404"这一类（浏览器对 404 的固定措辞）
    expect(
      consoleErrors.filter((line) => !line.includes('Failed to load resource')),
      consoleErrors.join('\n'),
    ).toEqual([])
    // 404 只允许进度上报（E2E 环境没有 /v1 后端）；其余 404 都算 bug
    expect([...new Set(notFound)].filter((p) => p !== '/v1/sync/push')).toEqual([])
  })

  test('书库空态与设置页可用', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/书库|Library/)

    await page.goto('/#/settings')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/设置|Settings/)
    await expect(page.getByText(/E-ink/)).toBeVisible()

    // 主题切换会写到 data-theme（主文档侧）
    await page.getByRole('button', { name: 'Dark', exact: true }).first().click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })
})
