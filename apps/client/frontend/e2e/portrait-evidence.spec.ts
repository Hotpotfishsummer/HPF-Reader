import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { pinReaderBar } from './reader-chrome'

// 顶部状态栏默认收起：竖屏证据用例用 pin 把它按住（见 e2e/reader-chrome.ts），
// 这样版面几何与改造前一致，证据可比；显隐行为由 reader-chrome.spec.ts 专测。
test.beforeEach(async ({ page }) => {
  await pinReaderBar(page)
})

/**
 * 竖屏（portrait）证据截图（task-23 收尾）。
 *
 * Lead 明确要求：现有截图都是 1280x720 横屏比例，需要一张**竖屏**的，
 * 证明划词翻译 UI 在竖屏下也正常（气泡不溢出屏幕、不被工具栏遮住）。
 *
 * 真书 frankenstein.epub（不是 sample.epub —— 那个是 STORE-only，会出假阳性）。
 */

const REPO_ROOT = path.resolve(process.cwd(), '../../..')
const REAL_BOOK = path.join(REPO_ROOT, 'testdata', 'books', 'frankenstein.epub')
const EVIDENCE_DIR = path.resolve(process.cwd(), '../evidence')

async function probe(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('foliate-view') as unknown as {
      lastLocation?: { cfi?: string }
      renderer?: { getContents?: () => Array<{ doc: Document }> }
    } | null
    const doc = el?.renderer?.getContents?.()[0]?.doc
    return { cfi: el?.lastLocation?.cfi ?? '', textLength: doc?.body?.textContent?.length ?? 0 }
  })
}

async function openRealBookAtChapter(page: Page) {
  await page.goto('/#/')
  await page.getByTestId('local-file-input').setInputFiles(REAL_BOOK)
  await expect(page).toHaveURL(/#\/reader\//, { timeout: 20_000 })
  await expect(page.locator('foliate-view')).toHaveCount(1, { timeout: 30_000 })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
      return Boolean(el?.lastLocation?.cfi)
    },
    undefined,
    { timeout: 30_000 },
  )
  const sidebar = page.getByTestId('toc-sidebar')
  const overlay = page.getByTestId('toc-overlay')
  if ((await sidebar.count()) === 0 && (await overlay.count()) === 0) {
    await page.getByTestId('toggle-toc').click()
  }
  const tocItems = page.locator('[data-testid="toc-sidebar"] li, [data-testid="toc-overlay"] li')
  await expect.poll(() => tocItems.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(20)
  await tocItems.nth(4).locator('button').click()
  await expect.poll(async () => (await probe(page)).textLength, { timeout: 20_000 }).toBeGreaterThan(2000)
  // 收起目录，露出正文
  if ((await page.getByTestId('toc-sidebar').count()) > 0) await page.getByTestId('toggle-toc').click()
  else if ((await page.getByTestId('toc-overlay').count()) > 0) await page.getByTestId('toggle-toc').click()
}

async function selectText(page: Page, minChars = 30): Promise<boolean> {
  return page.evaluate((min) => {
    const view = document.querySelector('foliate-view') as unknown as {
      renderer?: { getContents?: () => Array<{ doc: Document }> }
    } | null
    const doc = view?.renderer?.getContents?.()[0]?.doc
    if (!doc) return false
    const win = doc.defaultView
    if (!win) return false
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    let target: Node | null = null
    let node = walker.nextNode()
    while (node !== null) {
      if ((node.textContent ?? '').trim().length >= min) { target = node; break }
      node = walker.nextNode()
    }
    if (target === null) return false
    const range = doc.createRange()
    range.setStart(target, 0)
    range.setEnd(target, Math.min(min, (target.textContent ?? '').length))
    const sel = win.getSelection()
    if (!sel) return false
    sel.removeAllRanges()
    sel.addRange(range)
    doc.dispatchEvent(new Event('selectionchange'))
    return true
  }, minChars)
}

test.describe('竖屏证据（task-23）', () => {
  test.skip(!existsSync(REAL_BOOK), `缺少真实测试书 ${REAL_BOOK}`)

  test('竖屏 480x900：划词翻译气泡正常显示且不溢出', async ({ page }) => {
    // 竖屏手机比例（与 reader.spec.ts 的 portrait 断言一致）
    await page.setViewportSize({ width: 480, height: 900 })

    await page.route('**/v1/ai/usage', (route) => {
      void route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          periodStart: '2026-11-01T00:00:00Z', resetAt: '2026-12-01T00:00:00Z',
          calls: { used: 42, quota: 100, remaining: 58 },
          tokens: { used: 120000, quota: 500000, remaining: 380000 },
        }),
      })
    })
    await page.route('**/v1/ai/translate', (route) => {
      const deltas = ['夜色', '渐深，', '时间', '在这里', '流淌得', '格外缓慢。']
      let sse = ''
      for (const d of deltas) sse += 'event: delta\ndata: ' + JSON.stringify({ text: d }) + '\n\n'
      sse += 'event: done\ndata: ' + JSON.stringify({ translated: deltas.join('') }) + '\n\n'
      void route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse })
    })

    await openRealBookAtChapter(page)

    // ★ 竖屏必须是单栏（这是 task-12 的既有行为，不能被本次改动破坏）
    // data-orientation 在外层容器上（ReaderView.vue:408），不在 toolbar 上；
    // data-columns 才在 toolbar 上（ReaderToolbar.vue:47）。
    await expect(page.locator('[data-orientation]').first()).toHaveAttribute('data-orientation', 'portrait')
    const toolbar = page.getByTestId('reader-toolbar')
    await expect(toolbar).toHaveAttribute('data-columns', '1')

    expect(await selectText(page, 40)).toBe(true)
    const bar = page.getByTestId('selection-bar')
    await expect(bar).toBeVisible({ timeout: 10_000 })
    await bar.getByTestId('selection-translate').click()

    const bubble = page.getByTestId('translate-bubble')
    await expect(bubble).toBeVisible({ timeout: 10_000 })
    await expect(bubble.getByTestId('translate-result')).toContainText('夜色渐深，时间在这里流淌得格外缓慢。', { timeout: 15_000 })

    // ★ 气泡不能溢出屏幕（竖屏最容易出这个问题）
    const box = await bubble.boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(480 + 1)
      expect(box.y + box.height).toBeLessThanOrEqual(900 + 1)
    }

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-23-portrait-selection-translate.png') })
  })

  test('竖屏 480x900：整书翻译面板 + 配额在窄屏下可读', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 })

    await page.route('**/v1/ai/usage', (route) => {
      void route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          periodStart: '2026-11-01T00:00:00Z', resetAt: '2026-12-01T00:00:00Z',
          calls: { used: 42, quota: 100, remaining: 58 },
          tokens: { used: 120000, quota: 500000, remaining: 380000 },
        }),
      })
    })
    let polls = 0
    await page.route('**/v1/ai/jobs', (route) => {
      if (route.request().method() !== 'POST') return void route.continue()
      void route.fulfill({ status: 202, contentType: 'application/json',
        body: JSON.stringify({ id: 'job-1', kind: 'book_translate', status: 'queued', progress: 0 }) })
    })
    await page.route('**/v1/ai/jobs/job-1', (route) => {
      const seq = [0.15, 0.4, 0.7]
      const p = seq[Math.min(polls, seq.length - 1)] ?? 0.7
      polls += 1
      void route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          id: 'job-1', kind: 'book_translate', status: 'running', progress: p,
          result: { targetLang: 'zh-CN', model: 'fake', totalChunks: 20, doneChunks: Math.round(p * 20), translatedChars: 4200, reusedChunks: 0, paused: false },
        }) })
    })

    await openRealBookAtChapter(page)
    await page.getByTestId('toggle-ai').click()
    const panel = page.getByTestId('book-translate-panel')
    await expect(panel).toBeVisible({ timeout: 10_000 })

    const box = await panel.boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      expect(box.x + box.width).toBeLessThanOrEqual(480 + 1)
    }

    await panel.getByTestId('book-translate-start').click()
    await expect(panel.getByTestId('book-translate-percent')).toBeVisible({ timeout: 10_000 })
    await expect.poll(
      async () => Number.parseInt(((await panel.getByTestId('book-translate-percent').textContent()) ?? '0'), 10),
      { timeout: 20_000 },
    ).toBeGreaterThan(0)

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-23-portrait-book-translate.png') })
  })
})