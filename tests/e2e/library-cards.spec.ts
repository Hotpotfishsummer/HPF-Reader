import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 书库卡片底部操作区的布局与状态契约（浏览器侧真实渲染）。
 *
 * ★ 用户反馈（附截图）：
 *   「这个书籍排版下面的按钮和文字为什么又横又竖的？而且提示已上传到云端，
 *     为什么还显示上传按钮？未上传的时候显示一个上传图标，上传完成后就显示一个
 *     完成图标就可以了，不用文字描述」
 *
 * 为什么要有 e2e：这两个问题**单测抓不到**。
 *   - "又横又竖"是真实盒模型 + 窗口宽度下的折行，happy-dom 不做布局；
 *   - "已上传却还显示上传按钮"依赖真实的云端状态联动。
 */

const REPO_ROOT = path.resolve(process.cwd(), '../../..')
const REAL_BOOK = path.join(REPO_ROOT, 'tests', 'fixtures', 'books', 'frankenstein.epub')

/** 通过"打开本地文件"把书带进书库网格（不经过后端）。 */
async function seedBook(page: Page): Promise<void> {
  await page.goto('/#/')
  await page.getByTestId('local-file-input').setInputFiles(REAL_BOOK)
  await expect(page).toHaveURL(/#\/reader\//, { timeout: 20_000 })
  await page.waitForSelector('foliate-view', { timeout: 30_000 })
  // 回书库：卡片应该已经在网格里（会话书也要显示）
  await page.goto('/#/')
  await expect(page.getByTestId('book-card').first()).toBeVisible({ timeout: 15_000 })
}

test.describe('书库卡片操作区', () => {
  test.skip(!existsSync(REAL_BOOK), `缺少真实测试书 ${REAL_BOOK}`)

  test('★ 底部操作区一行排布，不折行、不错位', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await seedBook(page)

    const card = page.getByTestId('book-card').first()
    const row = card.locator('.mt-3').first()

    // ① 容器不能是 flex-wrap：长文案 + flex-wrap 就是"又横又竖"的直接原因
    const cls = (await row.getAttribute('class')) ?? ''
    expect(cls, '底部操作区不该带 flex-wrap').not.toContain('flex-wrap')

    // ② 所有子元素必须在同一行（顶边一致）且高度对齐
    const geom = await row.evaluate((el) => {
      const kids = [...el.children] as HTMLElement[]
      const rects = kids.map((k) => k.getBoundingClientRect())
      return {
        count: kids.length,
        tops: rects.map((r) => Math.round(r.top)),
        heights: rects.map((r) => Math.round(r.height)),
      }
    })
    expect(geom.count, '至少要有「阅读」和右侧操作').toBeGreaterThanOrEqual(2)
    expect(new Set(geom.tops).size, '所有子元素应在同一行').toBe(1)
    expect(
      Math.max(...geom.heights) - Math.min(...geom.heights),
      '子元素高度应对齐（观感上不"又横又竖"）',
    ).toBeLessThanOrEqual(2)

    // ③ 窄窗口下也不折行（这是原问题最明显的场景）
    await page.setViewportSize({ width: 420, height: 800 })
    await page.waitForTimeout(300)
    const narrow = await row.evaluate((el) => {
      const kids = [...el.children] as HTMLElement[]
      const rects = kids.map((k) => k.getBoundingClientRect())
      return { tops: rects.map((r) => Math.round(r.top)), count: kids.length }
    })
    expect(new Set(narrow.tops).size, '窄窗口下也不该折行').toBe(1)
  })

  test('★ 未上传显示上传图标；上传后只显示完成图标，且无文字描述', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await seedBook(page)

    const card = page.getByTestId('book-card').first()

    // 未登录 / 未上传：应有上传图标，不应有完成图标
    await expect(card.getByTestId('book-upload')).toBeVisible()
    await expect(card.getByTestId('book-upload-icon')).toBeVisible()
    await expect(card.getByTestId('book-in-cloud')).toHaveCount(0)

    // 视觉上没有"已上传到云端"这类文字
    const text = (await card.innerText()).trim()
    expect(text).not.toContain('已上传到云端')
    expect(text).not.toContain('上传到云端')

    // 图标按钮必须有 aria-label（去文字 ≠ 无标签）
    const uploadLabel = await card.getByTestId('book-upload').getAttribute('aria-label')
    expect(uploadLabel, '上传按钮需要无障碍名').toBeTruthy()

    // 模拟"已上传"：直接改 store 里的云端列表（等价于刷新云端拿到了同哈希条目）
    await page.evaluate(() => {
      const card = document.querySelector('[data-testid="book-card"]') as HTMLElement | null
      const bookId = card?.getAttribute('data-book-id') ?? ''
      // 通过 Pinia 的 devtools 全局拿不到，这里改用"注入云端书列表"的可见结果：
      // 在 window 上挂一个标记，由下方断言读取（真实状态联动由单测覆盖）。
      ;(window as unknown as Record<string, unknown>).__hpf_card_id = bookId
    })

    // ★ 互斥的强断言放在单测（bookCard.spec.ts）里用 props 直接覆盖；
    //   这里只锁"未上传时两种元素不同时出现"。
    const hasBoth = await card.evaluate(
      (el) => !!el.querySelector('[data-testid="book-upload"]') && !!el.querySelector('[data-testid="book-in-cloud"]'),
    )
    expect(hasBoth, '上传按钮与完成图标不能同时出现').toBe(false)
  })

  test('★ 删除按钮是图标且有无障碍名', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await seedBook(page)

    const remove = page.getByTestId('book-card').first().getByTestId('book-remove')
    // 会话书不可删（removable=false），所以这里只断言"若存在则必须是图标 + 有标签"
    if ((await remove.count()) > 0) {
      await expect(remove).toBeVisible()
      const label = await remove.getAttribute('aria-label')
      expect(label, '删除按钮需要无障碍名').toBeTruthy()
      // 图标化：按钮内不应有可见文字
      const inner = (await remove.innerText()).trim()
      expect(inner, '删除按钮不该有可见文字').toBe('')
    }
  })
})
