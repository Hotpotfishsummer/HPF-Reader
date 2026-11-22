import { expect, test, type Page, type Route } from '@playwright/test'
import path from 'node:path'
import { pinReaderBar } from './reader-chrome'

// 顶部状态栏默认收起：功能用例用 pin 把它按住（见 tests/e2e/reader-chrome.ts）。
// 显隐行为本身由 reader-chrome.spec.ts 专测。
test.beforeEach(async ({ page }) => {
  await pinReaderBar(page)
})

/**
 * task-24 验收要求：**竖屏 + 横屏各一张**术语表截图。
 *
 * 用内置 sample 书（可按路由重开，刷新后能恢复），术语表走 mock 服务端。
 */

const EVIDENCE_DIR = path.resolve(process.cwd(), '../../../tests/evidence/client')

interface Term {
  key: string
  display: string
  target: string
  source: 'user_confirmed' | 'llm_extracted' | 'deterministic'
  aliases?: string[]
}

async function mockGlossary(page: Page, seed: Term[]) {
  const state = { version: 1, terms: [...seed] }
  await page.route('**/v1/books/*/glossary*', async (route: Route) => {
    const req = route.request()
    if (req.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ bookId: 'b1', targetLang: 'zh', version: state.version, terms: state.terms }),
      })
      return
    }
    const body = JSON.parse(req.postData() as string) as {
      terms?: Term[]
      removeKeys?: string[]
    }
    for (const t of body.terms ?? []) {
      const key = t.display.replace(/^(Mr|Mrs|Ms|Dr)\.?\s+/i, '').trim().toLowerCase()
      const i = state.terms.findIndex((x) => x.key === key)
      if (i >= 0) state.terms[i] = { ...t, key }
      else state.terms = [...state.terms, { ...t, key }]
    }
    for (const k of body.removeKeys ?? []) {
      const i = state.terms.findIndex((x) => x.key === k)
      if (i >= 0) state.terms.splice(i, 1)
    }
    state.version += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ bookId: 'b1', targetLang: 'zh', version: state.version, terms: state.terms }),
    })
  })
}

async function openGlossaryWith(page: Page) {
  await page.goto('/#/reader/sample')
  await expect(page.locator('foliate-view')).toHaveCount(1, { timeout: 30_000 })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
      return Boolean(el?.lastLocation?.cfi)
    },
    undefined,
    { timeout: 30_000 },
  )
  await page.getByTestId('toggle-glossary').click()
  await expect(page.getByTestId('glossary-panel')).toBeVisible()
}

/** 一组有代表性的术语：用户确认 / LLM 抽取 / 自动规则 / 归化译名。 */
const SEED: Term[] = [
  { key: 'darcy', display: 'Mr. Darcy', target: '达西先生', source: 'user_confirmed', aliases: ['Darcy'] },
  { key: 'elizabeth', display: 'Elizabeth', target: '伊丽莎白', source: 'llm_extracted' },
  { key: 'scarlett', display: 'Scarlett', target: '斯嘉丽', source: 'user_confirmed' },
  { key: '斯嘉丽', display: '斯嘉丽', target: '斯嘉丽', source: 'deterministic' },
]

test.describe('术语表竖屏/横屏证据（task-24）', () => {
  test('横屏 1280x720：术语表面板完整可读', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await mockGlossary(page, SEED)
    await openGlossaryWith(page)
    await expect(page.getByTestId('glossary-row')).toHaveCount(4)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-24-landscape.png') })
  })

  test('竖屏 480x900：术语表面板不溢出、可读', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 })
    await mockGlossary(page, SEED)
    await openGlossaryWith(page)
    await expect(page.getByTestId('glossary-row')).toHaveCount(4)

    // ★ 面板必须整个落在屏幕内（不横向溢出）。
    const box = await page.getByTestId('glossary-panel').boundingBox()
    expect(box).not.toBeNull()
    const b = box as { x: number; y: number; width: number; height: number }
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(480 + 1)

    // 方向标记确实是 portrait（不是靠宽度猜的）。
    // ⚠️ data-orientation 在 ReaderView 的容器 div 上（ReaderView.vue:408），
    //    不在 documentElement 上 —— 我第一版查 documentElement 拿到 ""。
    await expect(page.locator('[data-orientation]').first()).toHaveAttribute('data-orientation', 'portrait')

    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-24-portrait.png') })
  })

  test('竖屏 merge 模式：合并入口可用且不溢出', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 })
    await mockGlossary(page, SEED)
    await openGlossaryWith(page)
    await page.getByTestId('glossary-merge-mode').click()
    await expect(page.getByTestId('glossary-merge-checkbox')).toHaveCount(4)

    const box = await page.getByTestId('glossary-panel').boundingBox()
    const b = box as { x: number; y: number; width: number; height: number }
    expect(b.x + b.width).toBeLessThanOrEqual(480 + 1)

    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-24-portrait-merge.png') })
  })
})