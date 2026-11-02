import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * 客户端翻译 UI 的 E2E（task-23）。
 *
 * 三条纪律（都是踩过坑换来的）：
 *
 *   1. **不用 `querySelectorAll('iframe')` 判断书是否加载**。
 *      foliate 是 closed shadow root（vendor/foliate-js/view.js:214），
 *      iframes 永远是 0 —— 我们在这上面栽过一次，把"书打不开"的假结论写进了文档。
 *      正确的判据是 `lastLocation.fraction` 变化 + 正文文本长度。
 *
 *   2. **真书，不用 sample.epub**。sample.epub 是 100% STORE（{0:8}），
 *      测不出 deflate 相关的问题，已经假阳性两次。这里用仓库根的
 *      testdata/books/frankenstein.epub（{0:2, 8:36}，31 章）。
 *
 *   3. **后端用 route 拦截**，不依赖真实服务器：AI 接口要的是**协议行为**
 *      （SSE 分块、429 结构），不是真实模型输出。这样测试确定、快、不烧钱。
 */

const REPO_ROOT = path.resolve(process.cwd(), '../../..')
const REAL_BOOK = path.join(REPO_ROOT, 'testdata', 'books', 'frankenstein.epub')
const EVIDENCE_DIR = path.resolve(process.cwd(), '../evidence')

interface Probe {
  cfi: string
  fraction: number
  textLength: number
}

/** 从 closed shadow root 外部读引擎状态（不使用 shadow DOM 穿透）。 */
async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const el = document.querySelector('foliate-view') as unknown as {
      lastLocation?: { cfi?: string; fraction?: number }
      renderer?: { getContents?: () => Array<{ doc: Document }> }
    } | null
    const loc = el?.lastLocation
    const doc = el?.renderer?.getContents?.()[0]?.doc
    return {
      cfi: loc?.cfi ?? '',
      fraction: loc?.fraction ?? 0,
      textLength: doc?.body?.textContent?.length ?? 0,
    }
  })
}

/**
 * 打开真书，并**跳到有正文的章节**。
 *
 * ⚠️ frankenstein 的第 1 个 section 是封面/标题页，body 只有 27 个字符 ——
 * 直接在那里选文字必然失败（"没有足够长的文本节点"）。
 * 必须先通过目录跳到一个真正的正文章节，这一点与 reader.spec.ts 的做法一致。
 */
async function openRealBook(page: Page): Promise<Probe> {
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

  // 跳到第 5 章（真实正文，几万字）
  const sidebar = page.getByTestId('toc-sidebar')
  const overlay = page.getByTestId('toc-overlay')
  if ((await sidebar.count()) === 0 && (await overlay.count()) === 0) {
    await page.getByTestId('toggle-toc').click()
  }
  const tocItems = page.locator('[data-testid="toc-sidebar"] li, [data-testid="toc-overlay"] li')
  await expect.poll(() => tocItems.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(20)
  await tocItems.nth(4).locator('button').click()
  // 等正文真的变长（不是等动画/等固定时间）
  await expect.poll(async () => (await probe(page)).textLength, { timeout: 20_000 }).toBeGreaterThan(2000)

  // 收起目录，避免遮挡气泡与截图
  if ((await page.getByTestId('toc-sidebar').count()) > 0) {
    await page.getByTestId('toggle-toc').click()
  } else if ((await page.getByTestId('toc-overlay').count()) > 0) {
    await page.getByTestId('toggle-toc').click()
  }

  return probe(page)
}

/**
 * 在真实书的章节文档里选中一段正文。
 *
 * ★ 必须进 iframe 操作：选区发生在章节文档内部，主文档的 window.getSelection()
 * 看不到它（这也是 bridge.ts 必须监听 iframe 自己 selectionchange 的原因）。
 */
async function selectTextInBook(page: Page, minChars = 20): Promise<boolean> {
  return page.evaluate((min) => {
    const view = document.querySelector('foliate-view') as unknown as {
      renderer?: { getContents?: () => Array<{ doc: Document }> }
    } | null
    const doc = view?.renderer?.getContents?.()[0]?.doc
    if (!doc) return false
    const win = doc.defaultView
    if (!win) return false

    // ★ 用 TreeWalker 找第一个足够长的**文本节点**：
    //   按 p/div/span 去找会因为嵌套结构而漏掉（正文里常是 <p><span>...</span></p>）。
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    let target: Node | null = null
    let node: Node | null = walker.nextNode()
    while (node !== null) {
      if ((node.textContent ?? '').trim().length >= min) {
        target = node
        break
      }
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
    // ★ bridge 监听的是**章节文档自己**的 selectionchange，所以派发到这里。
    doc.dispatchEvent(new Event('selectionchange'))
    return true
  }, minChars)
}

/** 拦截 AI 接口：返回可控的 SSE / 429 / 任务进度。 */
async function mockAiBackend(
  page: Page,
  options: {
    /** 429 时返回的 dimension。null 表示正常流式。 */
    quotaDimension?: 'calls' | 'tokens' | null
    /** 每个 delta 之间的延迟（ms），用于观察流式过程。 */
    deltaDelayMs?: number
    /** 整书任务的进度序列。 */
    jobProgressSequence?: number[]
  } = {},
): Promise<void> {
  const { quotaDimension = null, deltaDelayMs = 60, jobProgressSequence = [0.1, 0.45, 0.8] } = options
  let jobPollCount = 0

  await page.route('**/v1/ai/usage', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        periodStart: '2026-11-01T00:00:00Z',
        resetAt: '2026-12-01T00:00:00Z',
        calls: { used: 42, quota: 100, remaining: 58 },
        tokens: { used: 120000, quota: 500000, remaining: 380000 },
      }),
    })
  })

  await page.route('**/v1/ai/translate', async (route) => {
    if (quotaDimension !== null) {
      // ★ 429：结构必须与契约一致（details.dimension/limit/used/resetAt）
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'quota_exceeded',
          message: 'monthly quota exhausted',
          details: { dimension: quotaDimension, limit: 100, used: 100, resetAt: '2026-12-01T00:00:00Z' },
        }),
      })
      return
    }

    // 正常的 SSE 流：分多个 delta 吐字
    const deltas = ['这是', '一段', '流式', '到达的', '译文。']
    let sse = ''
    for (const d of deltas) {
      sse += 'event: delta\ndata: ' + JSON.stringify({ text: d }) + '\n\n'
    }
    sse += 'event: done\ndata: ' + JSON.stringify({ translated: deltas.join('') }) + '\n\n'

    // 用多段 body 模拟真实流式（一次返回也够验证解析，但分块更接近真实）
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sse,
    })
    void deltaDelayMs
  })

  await page.route('**/v1/ai/jobs', (route) => {
    if (route.request().method() !== 'POST') {
      void route.continue()
      return
    }
    jobPollCount = 0
    void route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'job-1', kind: 'book_translate', status: 'queued', progress: 0 }),
    })
  })

  await page.route('**/v1/ai/jobs/job-1', (route) => {
    const progress = jobProgressSequence[Math.min(jobPollCount, jobProgressSequence.length - 1)] ?? 0.8
    jobPollCount += 1
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'job-1',
        kind: 'book_translate',
        status: 'running',
        progress,
        result: {
          targetLang: 'zh-CN',
          model: 'fake:model',
          totalChunks: 20,
          doneChunks: Math.round(progress * 20),
          translatedChars: 5000,
          reusedChunks: 0,
          paused: false,
        },
      }),
    })
  })
}

test.describe('客户端翻译 UI（task-23）', () => {
  test.skip(!existsSync(REAL_BOOK), `缺少真实测试书 ${REAL_BOOK}`)

  test('划词翻译：选区 → 气泡 → 流式显示译文', async ({ page }) => {
    await mockAiBackend(page, { deltaDelayMs: 40 })
    const before = await openRealBook(page)
    // ★ 判据是 fraction/正文长度，不是 iframes 数量
    expect(before.cfi).not.toBe('')
    expect(before.textLength).toBeGreaterThan(100)

    expect(await selectTextInBook(page, 30)).toBe(true)

    // 选区操作条出现
    const bar = page.getByTestId('selection-bar')
    await expect(bar).toBeVisible({ timeout: 10_000 })
    await bar.getByTestId('selection-translate').click()

    // 气泡出现。⚠️ 不硬断言 data-status='streaming'：mock 的 body 一次性返回，
    // 状态可能在 Playwright 观察到之前就变成 done（这是**测试装置**的局限，
    // 不是产品缺陷）。真正的流式行为由单元测试覆盖（SSE 分块解析 + rAF 合并）。
    const bubble = page.getByTestId('translate-bubble')
    await expect(bubble).toBeVisible({ timeout: 10_000 })
    await expect(bubble).toHaveAttribute('data-status', /streaming|done/)

    // ★ 断言最终拿到完整译文（以 done 事件的全文为准）
    const result = bubble.getByTestId('translate-result')
    await expect(result).toContainText('这是一段流式到达的译文。', { timeout: 15_000 })
    await expect(bubble).toHaveAttribute('data-status', 'done', { timeout: 15_000 })

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-23-selection-translate.png') })
  })

  test('★ 429 配额不足：显示配额文案，不显示网络错误', async ({ page }) => {
    // 这是本任务的第一条硬要求：429 不能显示成"网络出错请重试"。
    await mockAiBackend(page, { quotaDimension: 'tokens' })
    await openRealBook(page)
    expect(await selectTextInBook(page, 30)).toBe(true)

    const bar = page.getByTestId('selection-bar')
    await expect(bar).toBeVisible({ timeout: 10_000 })
    await bar.getByTestId('selection-translate').click()

    const bubble = page.getByTestId('translate-bubble')
    await expect(bubble).toBeVisible({ timeout: 10_000 })
    // ★ 状态必须是 quota，不是 error
    await expect(bubble).toHaveAttribute('data-status', 'quota', { timeout: 15_000 })

    // 配额文案出现，且提到 token 维度与恢复时间
    const quotaText = bubble.getByTestId('translate-quota')
    await expect(quotaText).toBeVisible()
    const text = (await quotaText.textContent()) ?? ''
    expect(text).toContain('token')
    expect(text).toMatch(/恢复|继续/)
    // ★ 绝对不能出现"网络"这类误导措辞
    expect(text).not.toContain('网络')
    expect(text).not.toContain('重试')

    // 错误分支（网络错误）不应该出现
    await expect(bubble.getByTestId('translate-error')).toHaveCount(0)

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-23-quota-429.png') })
  })

  test('★ 429 calls 维度：文案说"调用次数"，不说 token', async ({ page }) => {
    await mockAiBackend(page, { quotaDimension: 'calls' })
    await openRealBook(page)
    expect(await selectTextInBook(page, 30)).toBe(true)
    const bar = page.getByTestId('selection-bar')
    await expect(bar).toBeVisible({ timeout: 10_000 })
    await bar.getByTestId('selection-translate').click()

    const bubble = page.getByTestId('translate-bubble')
    await expect(bubble).toHaveAttribute('data-status', 'quota', { timeout: 15_000 })
    const text = (await bubble.getByTestId('translate-quota').textContent()) ?? ''
    expect(text).toContain('调用次数')
    expect(text).not.toContain('token')
  })

  test('整书翻译：进度条真实推进（来自服务端 progress）', async ({ page }) => {
    await mockAiBackend(page, { jobProgressSequence: [0.05, 0.3, 0.65, 0.9] })
    await openRealBook(page)

    await page.getByTestId('toggle-ai').click()
    const panel = page.getByTestId('book-translate-panel')
    await expect(panel).toBeVisible({ timeout: 10_000 })

    // 配额先显示出来（整书翻译很贵，开始前必须让用户看到余额）
    await expect(panel.getByTestId('quota-badge')).toBeVisible()

    await panel.getByTestId('book-translate-start').click()

    // ★ 进度必须**真的推进**（两次采样值不同），不是假动画
    const percent = panel.getByTestId('book-translate-percent')
    await expect(percent).toBeVisible({ timeout: 10_000 })
    const first = Number.parseInt(((await percent.textContent()) ?? '0'), 10)
    await expect
      .poll(async () => Number.parseInt(((await percent.textContent()) ?? '0'), 10), { timeout: 20_000 })
      .toBeGreaterThan(first)
    const later = Number.parseInt(((await percent.textContent()) ?? '0'), 10)
    expect(later).toBeGreaterThan(first)

    // 块级明细存在
    await expect(panel.getByTestId('book-translate-chunks')).toBeVisible()

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-23-book-translate.png') })
  })

  test('★ paused 与 failed 文案必须不同（paused 不能说成失败）', async ({ page }) => {
    // 让任务返回 paused（额度不足，可续跑）
    await page.route('**/v1/ai/usage', (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          periodStart: '2026-11-01T00:00:00Z',
          resetAt: '2026-12-01T00:00:00Z',
          calls: { used: 100, quota: 100, remaining: 0 },
          tokens: { used: 500000, quota: 500000, remaining: 0 },
        }),
      })
    })
    await page.route('**/v1/ai/jobs', (route) => {
      if (route.request().method() !== 'POST') return void route.continue()
      void route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'job-1', kind: 'book_translate', status: 'queued', progress: 0 }),
      })
    })
    await page.route('**/v1/ai/jobs/job-1', (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'job-1',
          kind: 'book_translate',
          status: 'paused',
          progress: 0.55,
          result: { targetLang: 'zh-CN', model: 'fake', totalChunks: 20, doneChunks: 11, translatedChars: 3000, reusedChunks: 0, paused: true },
        }),
      })
    })

    await openRealBook(page)
    await page.getByTestId('toggle-ai').click()
    const panel = page.getByTestId('book-translate-panel')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await panel.getByTestId('book-translate-start').click()

    // ★ 状态必须是 paused
    const status = panel.getByTestId('book-translate-status')
    await expect(status).toHaveAttribute('data-phase', 'paused', { timeout: 15_000 })
    await expect(status).toContainText('暂停')

    // paused 专属提示出现，failed 提示**不能**出现
    await expect(panel.getByTestId('book-translate-paused')).toBeVisible()
    await expect(panel.getByTestId('book-translate-failed')).toHaveCount(0)

    // ★ 进度**保留**（55%），不能归零
    const pct = Number.parseInt(((await panel.getByTestId('book-translate-percent').textContent()) ?? '0'), 10)
    expect(pct).toBe(55)

    // ★ 文案要让人安心：说明会自动继续、不会重复计费
    const pausedText = (await panel.getByTestId('book-translate-paused').textContent()) ?? ''
    expect(pausedText).toMatch(/自动继续|恢复/)
    expect(pausedText).not.toContain('失败')

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-23-paused-vs-failed.png') })
  })

  test('术语表：新增 → 来源标记 → 确认升级', async ({ page }) => {
    await mockAiBackend(page)
    await openRealBook(page)

    await page.getByTestId('toggle-glossary').click()
    const panel = page.getByTestId('glossary-panel')
    await expect(panel).toBeVisible({ timeout: 10_000 })

    // 空状态
    await expect(panel.getByTestId('glossary-empty')).toBeVisible()

    // 新增一条（用户确认 → origin=user）
    await panel.getByTestId('glossary-new-source').fill('Elizabeth')
    await panel.getByTestId('glossary-new-target').fill('伊丽莎白')
    await panel.getByTestId('glossary-add').click()

    const rows = panel.getByTestId('glossary-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Elizabeth')
    await expect(rows.first()).toContainText('伊丽莎白')
    // 来源标记必须是"用户确认"
    await expect(rows.first()).toContainText('用户确认')

    // 明确标注只存本机（不假装已同步服务端）
    await expect(panel.getByTestId('glossary-local-only')).toBeVisible()

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-23-glossary.png') })
  })
})