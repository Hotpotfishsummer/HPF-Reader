import { expect, test, type Page } from '@playwright/test'
import { revealReaderBar } from './reader-chrome'

/**
 * 顶部状态栏 / 目录的**显隐行为**专项 E2E。
 *
 * ⚠️ 其它 spec（reader / ai / glossary / portrait / perf）都在 `beforeEach` 里
 *    用 `pinReaderBar` 把状态栏钉成常驻，因为它们验的不是显隐 —— 那样版面几何
 *    与改造前完全一致，历史证据仍然可比。**这个文件故意不 pin**：这里要验的正是
 *    "默认收起 / 靠近展开 / 双击切换 / pin 持久化 / 提示自动消失"。
 *
 * 断言全走稳定信号：`data-bar` / `data-bar-pinned` 属性、元素的**存在与否**、
 * 以及阅读面的实际几何（收起时正文要真的吃到那 48px，不能只是变透明）。
 */

/** 进度在 localStorage 里的 key（与 src/reader/progressStore.ts 的契约）。 */
const PROGRESS_KEY = 'hpf.reader.progress.v1'

/** 等引擎给出第一个定位（返回 cfi，便于后面比较"翻页了没有"）。 */
async function waitForEngine(page: Page): Promise<string> {
  await expect(page.locator('foliate-view')).toHaveCount(1, { timeout: 30_000 })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('foliate-view') as unknown as {
        lastLocation?: { cfi?: string }
      } | null
      return Boolean(el?.lastLocation?.cfi)
    },
    undefined,
    { timeout: 30_000 },
  )
  return page.evaluate(() => {
    const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
    return el?.lastLocation?.cfi ?? ''
  })
}

/** 当前引擎的 cfi（用来等"确实翻页了"）。 */
async function currentCfi(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
    return el?.lastLocation?.cfi ?? ''
  })
}

test.describe('顶部状态栏显隐', () => {
  test('默认收起：正文吃满高度；光标靠近顶部展开，离开后折叠', async ({ page }) => {
    await page.goto('/#/reader/sample')
    await waitForEngine(page)

    const view = page.getByTestId('reader-view')
    const bar = page.getByTestId('reader-toolbar')
    const host = page.getByTestId('reader-host')

    // ① 默认不在 DOM 里（不是"透明了"）
    await expect(view).toHaveAttribute('data-bar', 'hidden')
    await expect(bar).toHaveCount(0)

    // ② 收起时阅读面顶边就是根盒顶边：工具栏那 48px 真的还给正文了
    const viewBox = (await view.boundingBox())!
    const foldedHost = (await host.boundingBox())!
    expect(foldedHost.y - viewBox.y).toBeLessThanOrEqual(1)

    // ③ 光标靠近顶部（NEAR_TOP_PX = 64）→ 展开
    await revealReaderBar(page)
    await expect(view).toHaveAttribute('data-bar', 'visible')
    const shownHost = (await host.boundingBox())!
    expect(shownHost.y - viewBox.y).toBeGreaterThanOrEqual(40)

    // ④ 光标移到正文下方 → HIDE_DELAY_MS(420) 之后自己折叠
    await page.mouse.move(viewBox.x + viewBox.width / 2, viewBox.y + viewBox.height - 40)
    await expect(bar).toHaveCount(0, { timeout: 5_000 })
    await expect(view).toHaveAttribute('data-bar', 'hidden')
    const refolded = (await host.boundingBox())!
    expect(refolded.y - viewBox.y).toBeLessThanOrEqual(1)
  })

  test('pin 开关：常驻后光标离开也不收，且跨重载保持', async ({ page }) => {
    await page.goto('/#/reader/sample')
    await waitForEngine(page)
    await revealReaderBar(page)

    const view = page.getByTestId('reader-view')
    const bar = page.getByTestId('reader-toolbar')
    const pin = page.getByTestId('toggle-pin')

    await expect(pin).toHaveAttribute('aria-pressed', 'false')
    await pin.click()
    await expect(pin).toHaveAttribute('aria-pressed', 'true')
    await expect(view).toHaveAttribute('data-bar-pinned', 'true')

    // 光标离开顶部：常驻就是不许收
    const viewBox = (await view.boundingBox())!
    await page.mouse.move(viewBox.x + viewBox.width / 2, viewBox.y + viewBox.height - 40)
    // 等超过 HIDE_DELAY_MS(420)，确认真的不是"还没来得及收"
    await page.waitForTimeout(900)
    await expect(bar).toBeVisible()

    // 持久化：pin 写进 hpf.settings.v1，整页重载后依然是常驻
    await page.reload()
    await waitForEngine(page)
    await expect(view).toHaveAttribute('data-bar-pinned', 'true')
    await expect(bar).toBeVisible()
  })

  test('续读提示：到点自动消失，且不拦截正文点击', async ({ page }) => {
    await page.goto('/#/reader/sample')
    await waitForEngine(page)

    // 先用键盘翻一页，把进度写进本地存储（不依赖工具栏，避免和本用例主题纠缠）
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(
        async () =>
          page.evaluate((key) => {
            const raw = localStorage.getItem(key)
            if (!raw) return false
            const table = JSON.parse(raw) as Record<string, { locator?: string }>
            return Boolean(table['sample']?.locator)
          }, PROGRESS_KEY),
        { timeout: 15_000 },
      )
      .toBe(true)

    await page.reload()
    await waitForEngine(page)

    const hint = page.getByTestId('reader-resumed')
    await expect(hint).toBeVisible()
    // ★ 它压在正文左下角：必须 pointer-events:none，否则会吃掉那里的翻页点击
    await expect(hint).toHaveCSS('pointer-events', 'none')
    // ★ 到点自己消失（RESUME_HINT_MS = 4000），不再常驻遮挡小屏
    await expect(hint).toHaveCount(0, { timeout: 12_000 })
  })
})

/**
 * 移动端：双击正文切换状态栏，单击正文仍然是翻页。
 *
 * ★ 这里必须开 `hasTouch`：双击切状态栏只在 touch / pen 上生效（桌面端双击没有语义，
 *   鼠标单击要保持即时翻页）。开着 hasTouch 才能让 bridge 把 pointerType 报成 'touch'。
 */
test.describe('移动端双击', () => {
  test.use({ hasTouch: true, viewport: { width: 480, height: 900 } })

  test('双击切换状态栏；单击仍翻页且不再单击弹出状态栏', async ({ page }) => {
    await page.goto('/#/reader/sample')
    const first = await waitForEngine(page)

    const view = page.getByTestId('reader-view')
    const bar = page.getByTestId('reader-toolbar')
    await expect(bar).toHaveCount(0)

    const host = (await page.getByTestId('reader-host').boundingBox())!
    // 正中间：既不在左右 28% 的翻页热区里，也不在顶部 64px 的展开热区里
    const cx = host.x + host.width / 2
    const cy = host.y + host.height / 2

    // 双击 → 展开
    await page.touchscreen.tap(cx, cy)
    await page.touchscreen.tap(cx, cy)
    await expect(bar).toBeVisible({ timeout: 5_000 })
    await expect(view).toHaveAttribute('data-bar', 'visible')

    // 再双击 → 收起（第一次点击的"收浮层"必须被双击取消，否则会切了个寂寞）
    await page.touchscreen.tap(cx, cy)
    await page.touchscreen.tap(cx, cy)
    await expect(bar).toHaveCount(0, { timeout: 5_000 })
    await expect(view).toHaveAttribute('data-bar', 'hidden')

    // 单击右边缘 → 延迟窗口过后翻页，且**不会**顺带弹出状态栏
    const rightX = host.x + host.width * 0.88
    await page.touchscreen.tap(rightX, cy)
    await expect
      .poll(async () => currentCfi(page), { timeout: 15_000 })
      .not.toBe(first)
    await expect(bar).toHaveCount(0)
    await expect(view).toHaveAttribute('data-bar', 'hidden')
  })
})
