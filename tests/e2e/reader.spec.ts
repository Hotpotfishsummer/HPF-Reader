import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pinReaderBar } from './reader-chrome'

// 顶部状态栏现在**默认收起**：功能用例用 pin 把它按住（等价于用户点了 pin，
// 见 tests/e2e/reader-chrome.ts）。"默认收起 / 靠近展开 / 双击切换 / pin 持久化"
// 这类显隐行为由 reader-chrome.spec.ts 专测，不在这些用例里重复。
test.beforeEach(async ({ page }) => {
  await pinReaderBar(page)
})

/**
 * 阅读闭环 E2E（task-12）。
 *
 * 原则：断言**引擎的稳定输出**（lastLocation.cfi / paginator.pages / localStorage），
 * 而不是像素或截图。截图只作为人工复核的视觉证据落到 tests/evidence/client/。
 */

/**
 * 阅读进度在 localStorage 里的 key。
 * 与 `src/reader/progressStore.ts` 的 PROGRESS_STORAGE_KEY 必须一致 ——
 * 这是跨模块的契约，所以在这里**故意**再写一遍：改了源文件而忘了改测试，测试就会红。
 */
const PROGRESS_KEY = 'hpf.reader.progress.v1'

/** 真实公版书（仓库根 tests/fixtures/books/）。 */
const REPO_ROOT = path.resolve(process.cwd(), '../../..')
const REAL_BOOK = path.join(REPO_ROOT, 'tests', 'fixtures', 'books', 'frankenstein.epub')
// 证据统一落到仓库根 tests/evidence/client（按 spec 自身位置解析，不受启动目录影响）。
// 任务要求的落盘位置是 tests/evidence/client/，因此是上一级。
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../../tests/evidence/client')

interface Probe {
  cfi: string
  index: number
  fraction: number
  pages: number
  textLength: number
  textStart: string
  /**
   * paginator 写进章节文档 `html` 的 `column-width`（paginator.js:316）。
   * ⚠️ 只当作**原始值**看：不能拿 `章节滚动宽度 / column-width` 去推"屏幕上有几栏" ——
   * 章节文档是整章排完再滚动的，那个比值算出来是"整章一共几栏"（实测 21），
   * 不是视口里显示几栏。视口栏数由我们设置的 `max-column-count` 决定，
   * 断言走 `data-columns` 属性 + 页数变化。
   */
  columnWidthPx: number
  /** 章节文档里正文背景的实际颜色（验证主题真的写进了 iframe，而不是只改了外层容器）。 */
  bodyBackground: string
  bodyColor: string
}

/** 从 closed shadow root 的外部读引擎状态：不使用任何 shadow DOM 穿透。 */
async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const el = document.querySelector('foliate-view') as unknown as {
      lastLocation?: { cfi?: string; index?: number; fraction?: number }
      renderer?: { getContents?: () => Array<{ doc: Document }>; pages?: number }
    } | null
    const loc = el?.lastLocation
    const doc = el?.renderer?.getContents?.()[0]?.doc
    const text = doc?.body?.textContent ?? ''
    const html = doc?.documentElement
    const view = doc?.defaultView
    const columnWidthPx = html && view ? Number.parseFloat(view.getComputedStyle(html).columnWidth) || 0 : 0
    const htmlStyle = html && view ? view.getComputedStyle(html) : null
    return {
      cfi: loc?.cfi ?? '',
      index: loc?.index ?? -1,
      fraction: loc?.fraction ?? 0,
      pages: el?.renderer?.pages ?? 0,
      textLength: text.length,
      textStart: text.slice(0, 60),
      columnWidthPx,
      bodyBackground: htmlStyle?.backgroundColor ?? '',
      bodyColor: htmlStyle?.color ?? '',
    }
  })
}

async function waitForEngine(page: Page): Promise<Probe> {
  await expect(page.locator('foliate-view')).toHaveCount(1, { timeout: 30_000 })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
      return Boolean(el?.lastLocation?.cfi)
    },
    undefined,
    { timeout: 30_000 },
  )
  return probe(page)
}

/**
 * 确保目录是**展开**状态。
 *
 * ⚠️ 目录现在**默认收起**（改造要求：不要一调窗口就自己弹出来），所以要显式点 ☰。
 * 这里先探测两种形态（宽屏侧栏 / 窄屏浮层）在不在，在就说明已经开着，
 * 不能再点一次 —— 否则会把它关掉，于是测到 0 个条目（踩过两次）。
 */
async function openToc(page: Page): Promise<void> {
  const sidebar = page.getByTestId('toc-sidebar')
  const overlay = page.getByTestId('toc-overlay')
  if ((await sidebar.count()) === 0 && (await overlay.count()) === 0) {
    await page.getByTestId('toggle-toc').click()
  }
}

/** 通过"打开本地文件"入口把真实 EPUB 交给阅读器（不经过任何后端）。 */
async function openLocalBook(page: Page, file: string): Promise<Probe> {
  await page.goto('/#/')
  await page.getByTestId('local-file-input').setInputFiles(file)
  await expect(page).toHaveURL(/#\/reader\//, { timeout: 15_000 })
  return waitForEngine(page)
}

test.describe('阅读闭环（本地优先）', () => {
  test('打开示例书 → 翻页 → 进度写入本地存储 → 重开续读', async ({ page }) => {
    await page.goto('/#/reader/sample')

    // 打开的就是示例书本身（不是"上次打开的那本"）
    expect(page.url()).toContain('/#/reader/sample')
    const first = await waitForEngine(page)
    expect(first.cfi).not.toBe('')
    expect(first.textLength).toBeGreaterThan(0)
    expect(first.textStart).toContain('HPF Reader')

    // 翻页：cfi 必须变化（引擎的稳定输出，而不是动画结束了没有）
    await page.getByTestId('next-page').click()
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
        const now = el?.lastLocation?.cfi ?? ''
        return now !== '' && now !== prev
      },
      first.cfi,
      { timeout: 15_000 },
    )

    /**
     * ★ 这个断言经过返工，根因是**产品行为的时序**，不是写法问题，记录在这里：
     *
     * 点一次 next-page，引擎的 lastLocation.cfi 会经过多个中间态：
     *   first  = epubcfi(/6/2!/4,/2,/8/1:49)   带文本偏移的精确位置
     *   瞬态   = epubcfi(/6/2!/4)              分页重排过程中的粗粒度值
     *   稳定   = epubcfi(/6/4!/4,/2,/8/1:84)   分页收敛后真正写进进度的值
     *
     * 原来"点完立刻读一次 localStorage 再比 cfi"，比的是瞬态 vs 稳定，
     * 竞态下读到的是**上一页**的值 —— 实测全量跑约 1/3 概率红，
     * 而单独跑 reader.spec.ts 却 9/9 全绿（机器没那么忙，恰好撞对时机）。
     *
     * 正确的不变量是：**最终，引擎当前位置与 localStorage 记录一致**。
     * 所以轮询到两者收敛，而不是猜某个中间态。
     */
    const readState = () =>
      page.evaluate(() => {
        const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
        const raw = localStorage.getItem('hpf.reader.progress.v1')
        const table = raw ? (JSON.parse(raw) as Record<string, { locator?: string }>) : null
        return { cfi: el?.lastLocation?.cfi ?? '', stored: table?.['sample']?.locator ?? '' }
      })

    // ★ 等引擎位置**收敛**，而不是只等「某一次读到的 cfi 恰好等于 localStorage」。
    //
    // 这里有一个很容易漏掉的二次竞态（上一版就漏了）：
    //   上一版单独 poll 了 "cfi === stored"，然后**又分两次**读
    //     settled = readState()        ← T1 读引擎 + 读 localStorage
    //     stored  = localStorage.getItem ← T2 再读一次 localStorage
    //   最后断言 stored(T2) === settled.cfi(T1)。
    // 引擎在 T1/T2 之间只要前进一次（分页收敛、图片加载后重排），这两个值就必然不等。
    // 所以「poll 通过」不等于「状态稳定」。
    //
    // 正确做法：要求连续两次采样（间隔 250ms）读到**同一个** cfi，且该值等于 localStorage，
    // 才认定收敛。这样拿到的快照可以作为后续所有断言的唯一基准。
    let settled = { cfi: '', stored: '' }
    await expect
      .poll(
        async () => {
          const a = await readState()
          if (a.cfi === '' || a.cfi !== a.stored) return false
          await page.waitForTimeout(250)
          const b = await readState()
          settled = b
          // 稳定 = 两次采样一致，且末次仍与 localStorage 一致
          return b.cfi !== '' && b.cfi === a.cfi && b.cfi === b.stored
        },
        { timeout: 15_000, message: '引擎位置应收敛且已写入 localStorage（进度落盘）' },
      )
      .toBe(true)

    const turned = { cfi: settled.cfi, index: (await probe(page)).index }
    expect(turned.cfi).not.toBe(first.cfi)

    // ★ 进度必须已经写进 localStorage —— 没有任何后端参与
    // 断言用的是**同一个收敛快照**，不再二次读 localStorage（那是新的竞态窗口）。
    expect(settled.stored, 'localStorage 里应该有进度记录').toBe(turned.cfi)
    const stored = await page.evaluate((key) => {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as Record<string, { locator?: string; fraction?: number }>) : null
    }, PROGRESS_KEY)
    expect(stored, 'localStorage 里应该有进度表').not.toBeNull()

    // ★ 重开（整页重载 = 冷启动）必须回到同一位置，而不是第一页
    //
    // 这里比较的是「reload 前一刻 localStorage 里的值」与「reload 后恢复的位置」，
    // 而**不是**与更早的 turned.cfi 比 —— 后者又是一个竞态窗口：
    // 若引擎在 settled 快照之后、reload 之前又前进了一次，
    // 那么存进 localStorage 的是新值，恢复出来自然是新值，与旧快照不相等。
    //
    // 这个测试要证明的是「进度落盘 → 重开能续读」这条链路，
    // 而不是「引擎在某个瞬间停住不动」，所以基准就该取 reload 前的那一读。
    const beforeReload = await page.evaluate((key) => {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as Record<string, { locator?: string }>) : null
    }, PROGRESS_KEY)
    const anchor = beforeReload?.['sample']?.locator ?? ''
    expect(anchor, 'reload 前 localStorage 必须有 locator').not.toBe('')

    await page.reload()
    const resumed = await waitForEngine(page)
    expect(resumed.cfi).toBe(anchor)

    await expect(page.getByTestId('reader-resumed')).toBeVisible()
    const percent = Number((await page.getByTestId('progress').textContent())?.replace('%', '') ?? '0')
    expect(percent).toBeGreaterThanOrEqual(0)
  })

  test('真实公版书：本地文件直开、真实目录、真实分页', async ({ page }) => {
    test.skip(!existsSync(REAL_BOOK), `缺少真实测试书 ${REAL_BOOK}`)

    // 先落盘书籍身份：只有这样"用的是真书"才是可复核的证据，而不是口头声明。
    const bookBytes = readFileSync(REAL_BOOK)
    const sha256 = createHash('sha256').update(bookBytes).digest('hex')

    const opened = await openLocalBook(page, REAL_BOOK)
    // ⚠️ frankenstein 的第 1 个 section 是封面/标题页，只有几十个字符 —— 用"首屏字数"
    //    来证明"这是真书"会得到假阴性（这里确实踩过一次）。真书的证据看目录与正文章节。
    expect(opened.cfi, '引擎给出了定位 CFI').not.toBe('')
    expect(opened.textLength).toBeGreaterThan(0)

    // 真实目录：frankenstein 有 31 章
    await openToc(page)
    const tocItems = page.locator('[data-testid="toc-sidebar"] li, [data-testid="toc-overlay"] li')
    // 目录是书加载完之后异步填的，要等它出来
    await expect.poll(() => tocItems.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(20)
    const tocCount = await tocItems.count()

    // 点目录第 5 章 → 引擎真的跳过去了，而且那一章有真正的正文
    await tocItems.nth(4).locator('button').click()
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
        return (el?.lastLocation?.cfi ?? '') !== prev
      },
      opened.cfi,
      { timeout: 15_000 },
    )
    await expect
      .poll(async () => (await probe(page)).textLength, { timeout: 15_000 })
      .toBeGreaterThan(2000)

    const jumped = await probe(page)
    expect(jumped.cfi).not.toBe(opened.cfi)
    // 真・正文章节：几万字，且横屏（默认 1280x720）下必然多页
    expect(jumped.textLength, '真实章节应该有大量正文').toBeGreaterThan(2000)
    expect(jumped.pages, '真实章节应该分多页').toBeGreaterThan(1)

    // 翻页
    await page.getByTestId('next-page').click()
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
        return (el?.lastLocation?.cfi ?? '') !== prev
      },
      jumped.cfi,
      { timeout: 15_000 },
    )
    const turned = await probe(page)
    expect(turned.cfi).not.toBe(jumped.cfi)

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(
      path.join(EVIDENCE_DIR, 'real-book-open.json'),
      JSON.stringify(
        {
          file: path.relative(REPO_ROOT, REAL_BOOK),
          bytes: bookBytes.length,
          sha256,
          tocCount,
          opened,
          jumped,
          turned,
        },
        null,
        2,
      ),
      'utf8',
    )
  })

  test('横竖屏自适应：竖屏单栏 / 横屏双栏侧栏，旋转后重排且不丢位置', async ({ page }) => {
    test.skip(!existsSync(REAL_BOOK), `缺少真实测试书 ${REAL_BOOK}`)

    // —— 横屏（宽）——
    await page.setViewportSize({ width: 1280, height: 800 })
    await openLocalBook(page, REAL_BOOK)
    const toolbar = page.getByTestId('reader-toolbar')
    await expect(toolbar).toHaveAttribute('data-columns', '2')
    await expect(toolbar).toHaveAttribute('data-compact', 'false')
    // ★ 目录**默认收起**（改造要求：不要一调整窗口就自己弹出来）。
    //   宽屏横屏只表示"允许做成侧栏"，不等于"要自动展开" —— 先把默认态钉住，
    //   再显式点 ☰ 打开（openToc 自己处理"已经开着就别再点"）。
    await expect(page.getByTestId('toc-sidebar')).toHaveCount(0)
    await openToc(page)
    await expect(page.getByTestId('toc-sidebar')).toBeVisible()

    // 挑一个**长**章节再测页数：短章节（如 frankenstein 的开篇书信）
    // 在两种方向下都可能只有 1 页，用它测"重排"会得到假阴性。
    const tocItems = page.locator('[data-testid="toc-sidebar"] li')
    const chapterCount = await tocItems.count()
    expect(chapterCount).toBeGreaterThanOrEqual(20)
    await tocItems.nth(Math.min(10, chapterCount - 1)).locator('button').click()
    await page.waitForTimeout(600)

    const wide = await probe(page)
    // 长章节 + 横屏双栏：页数必须明显 >1，否则"旋转重排"根本测不出来
    expect(wide.pages, '长章节在横屏下应该有多页').toBeGreaterThan(4)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'e2e-landscape-wide.png') })

    // —— 旋转到竖屏（窄）——
    await page.setViewportSize({ width: 480, height: 900 })
    await expect(toolbar).toHaveAttribute('data-columns', '1')
    await expect(toolbar).toHaveAttribute('data-compact', 'true')
    // 窄屏下目录必须自动收起，不能盖住正文
    await expect(page.getByTestId('toc-sidebar')).toHaveCount(0)
    await expect(page.getByTestId('toc-overlay')).toHaveCount(0)

    // 旋转后阅读面尺寸变化 → 重排调度器在静置 130ms 后落定一次（见 useReaderReflow）。
    // 等到引擎真的重新分页。
    // ★ 竖屏单栏 = 每屏字数变少 → 同一章节的**页数必须变多**；
    //   这是"引擎按新宽度重排了"最直接的证据（比比对像素稳，且不依赖 Chrome 对
    //   getComputedStyle(columnWidth) 的实现细节）。
    await expect
      .poll(async () => (await probe(page)).pages, { timeout: 15_000 })
      .toBeGreaterThan(wide.pages)

    const narrow = await probe(page)
    expect(narrow.pages).toBeGreaterThan(wide.pages)
    // ★ 旋转不丢位置：仍然停在原来那一章
    expect(narrow.index === wide.index || narrow.index === -1).toBe(true)
    expect(narrow.cfi.slice(0, 20)).toBe(wide.cfi.slice(0, 20))
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'e2e-portrait-narrow.png') })

    // ★ task-17：@container 缺失对我们**没有影响** —— 这里留下可复核的取证。
    //   paginator 在竖屏靠 @container(orientation:portrait) 把
    //   --_max-column-count-spread 切成 portrait 值；该查询在 Chrome 105+ 才生效。
    //   但我们已按方向设了 max-column-count 属性，而 spread 默认就是
    //   var(--_max-column-count) —— 因此"@container 生效"与"不生效"最终 spread
    //   **值相同**。下面断言竖屏下我们设的列数确实是 1（= portrait 期望值）。
    // 注意：setLayout 走重排调度器的静置落定（130ms，见 useReaderReflow），
    // 工具栏的 data-columns 是即时的，
    // 引擎属性要等重排落定，所以这里必须 poll 而不是立刻断言。
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const view = document.querySelector('foliate-view')
            return view?.getAttribute('data-hpf-columns') ?? ''
          }),
        { timeout: 15_000 },
      )
      .toBe('1')
    // 竖屏下目录走覆盖层
    await page.getByTestId('toggle-toc').click()
    await expect(page.getByTestId('toc-overlay')).toBeVisible()

    // —— 转回横屏：双栏恢复，页数回落到横屏水平，位置仍在同一章 ——
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(toolbar).toHaveAttribute('data-columns', '2')
    await expect
      .poll(async () => (await probe(page)).pages, { timeout: 15_000 })
      .toBeLessThanOrEqual(wide.pages)
    await page.getByTestId('toggle-toc').click() // 收起覆盖层
    const back = await probe(page)
    expect(back.cfi.slice(0, 20)).toBe(wide.cfi.slice(0, 20))

    // 原始测量数据落盘，方便人工复核（不是断言，是证据）
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(
      path.join(EVIDENCE_DIR, 'reader-layout-measurements.json'),
      JSON.stringify(
        {
          note: 'frankenstein.epub 第 11 个目录项（长章节）；同一阅读位置在 1280x800 横屏 / 480x900 竖屏 / 1440x900 横屏下的引擎测量值',
          viewportLandscape: '1280x800 (data-columns=2)',
          viewportPortrait: '480x900 (data-columns=1)',
          wide,
          narrow,
          back,
        },
        null,
        2,
      ),
      'utf8',
    )
  })

  test('操作动线：正文点击热区 / Esc 分层关闭 / 点正文收浮层', async ({ page }) => {
    test.skip(!existsSync(REAL_BOOK), `缺少真实测试书 ${REAL_BOOK}`)

    await page.setViewportSize({ width: 1280, height: 800 })
    await openLocalBook(page, REAL_BOOK)
    const toolbar = page.getByTestId('reader-toolbar')
    await expect(toolbar).toHaveAttribute('data-columns', '2')
    await openToc(page)
    // 长章节（短章节只有 1 页，翻页后 cfi 不变，会得到假阴性）
    const tocItems = page.locator('[data-testid="toc-sidebar"] li')
    await tocItems.nth(Math.min(10, (await tocItems.count()) - 1)).locator('button').click()
    await page.waitForTimeout(600)
    const host = page.getByTestId('reader-host')

    /** 等 cfi 真正变化（翻页是异步的）。 */
    const waitCfiChange = async (from: string, label: string): Promise<Probe> => {
      await expect.poll(async () => (await probe(page)).cfi, { timeout: 10_000, message: label }).not.toBe(from)
      return probe(page)
    }

    const hostBox = await host.boundingBox()
    expect(hostBox, '阅读面应该有尺寸').not.toBeNull()

    // —— ① 先点阅读面**右侧**：前进一页 ——
    // ★ 点的是"阅读面上的右 1%"。分栏排版下 iframe 的视口宽度是**整章展开宽**
    //   （实测 9523px，而阅读面只有 1024px）—— 拿 iframe 宽度当分母，这个点会被
    //   算成"最左侧"，翻页方向整个反过来。这条断言就是那个错位的回归锁。
    // 先前进再回退：TOC 跳转落点在一章的开头，直接点左侧是空操作，测不出方向。
    const wideFirst = await probe(page)
    await host.click({ position: { x: (hostBox?.width ?? 0) - 12, y: 400 } })
    const afterRightTap = await waitCfiChange(wideFirst.cfi, '点右侧应前进一页')
    expect(afterRightTap.fraction, '点右侧应前进一页').toBeGreaterThan(wideFirst.fraction)
    // foliate-js 用 `#locked` 串行化翻页（paginator.js:1060-1071），一次翻页后约 100ms 内
    // 的下一次翻页会被直接丢弃。等它解锁再点左侧，否则第二次点击是空操作（测出假阴性）。
    await page.waitForTimeout(300)

    // —— ② 再点阅读面**左侧**：回到上一页 ——
    await host.click({ position: { x: 12, y: 400 } })
    const afterLeftTap = await waitCfiChange(afterRightTap.cfi, '点左侧应回到上一页')
    expect(afterLeftTap.fraction, '点左侧应回到上一页').toBeLessThan(afterRightTap.fraction)

    // —— ③ Esc 分层：有浮层时先关浮层，不会一把退出阅读器 ——
    // ★ 宽屏下目录是**侧栏**（点 toggle 只是开关侧栏，不是浮层），
    //   要测"覆盖层先关"必须切到窄屏走 overlay 分支。
    await page.setViewportSize({ width: 480, height: 900 })
    await expect(page.getByTestId('toc-sidebar')).toHaveCount(0)
    await page.getByTestId('toggle-toc').click()
    await expect(page.getByTestId('toc-overlay')).toBeVisible()
    await page.keyboard.press('Escape')
    // 覆盖层先被关掉，且仍然留在阅读界面
    await expect(page.getByTestId('toc-overlay')).toHaveCount(0, { timeout: 5_000 })
    expect(page.url(), '第一下 Esc 只应该关覆盖层').toContain('/reader/')
    await page.keyboard.press('Escape')
    await expect(page, '第二下 Esc 才退出阅读器').toHaveURL(/#\/$/, { timeout: 5_000 })

    // —— ④ 点正文先收浮层，再翻页：中间区域不翻页，只收面板 ——
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/#/reader/sample')
    await waitForEngine(page)
    const sampleBox = await host.boundingBox()
    await page.getByTestId('toggle-ai').click()
    await expect(page.getByTestId('book-translate-panel')).toBeVisible()
    await host.click({ position: { x: (sampleBox?.width ?? 600) * 0.5, y: 400 } })
    await expect(page.getByTestId('book-translate-panel')).toHaveCount(0, { timeout: 5_000 })
    expect(page.url(), '点中间收浮层，不该翻页或退出').toContain('/reader/')
  })

  test('夜间模式：正文主题切换真的写进章节文档', async ({ page }) => {
    // 主文档与 iframe 是两套边界：只改一边 = UI 变了但正文没变（踩过的坑）
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/#/reader/sample')
    await waitForEngine(page)

    const before = await probe(page)
    // 正文背景必须是**真实颜色**（不是 transparent）——否则说明 var() 没有跨文档生效
    expect(before.bodyBackground, '章节文档的 html 应该有实际背景色').not.toBe('rgba(0, 0, 0, 0)')

    // 循环到"夜间"（light → sepia → dark）
    for (let i = 0; i < 2; i += 1) await page.getByTestId('cycle-theme').click()
    await expect(page.locator('html')).toHaveAttribute('data-reader-theme', 'dark')

    await expect
      .poll(async () => (await probe(page)).bodyBackground, { timeout: 10_000 })
      .not.toBe(before.bodyBackground)

    const after = await probe(page)
    // 夜间主题的纸色是 #14161a
    expect(after.bodyBackground).toBe('rgb(20, 22, 26)')
    expect(after.bodyColor).not.toBe(before.bodyColor)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'e2e-night-mode.png') })
  })
})

test.describe('老旧 WebView 兼容性（task-14）', () => {
  /**
   * 复现 Android 实测的真实故障：WebView = Chromium 91，
   * 而 foliate-js / vue-router / pinia 用了更高版本才有的运行时内置对象。
   *
   * 做法：在**任何应用脚本执行之前**把这些 API 删掉（addInitScript 先于所有页面脚本），
   * 然后断言应用仍然能打开书并分页。如果没有 polyfill，这条测试会以
   * "Object.groupBy is not a function" 失败 —— 与模拟器上的报错一致。
   */
  /**
   * ★ 第二个阻塞点（Android 真机 logcat 实证）：
   *   Failed to construct 'DecompressionStream': Unsupported compression format: 'deflate-raw'
   *
   * WebView 91 支持 gzip/deflate，**不支持 deflate-raw**（Chrome 103+ 才有）。
   * 而 ZIP 压缩方法 8 存的就是裸 deflate —— 所以**真实 EPUB 全部打不开**，
   * 只有 100% STORE 的示例书能开（这就是假阳性的来源）。
   *
   * 这条测试把 Chrome 91 的**真实行为**复刻出来：让 'deflate-raw' 构造抛
   * Unsupported compression format（gzip/deflate 照常可用），然后打开
   * frankenstein.epub（{0:2, 8:36}，36 个 deflate 条目）。
   */
  test('模拟 Chromium 91 缺 deflate-raw：真实 deflate 压缩的 EPUB 仍能打开', async ({ page }) => {
    test.skip(!existsSync(REAL_BOOK), `缺少真实测试书 ${REAL_BOOK}`)

    await page.addInitScript(() => {
      const Native = (globalThis as unknown as Record<string, unknown>)['DecompressionStream']
      const Chrome91 = function (this: unknown, format: string, options?: unknown) {
        if (format === 'deflate-raw' || format === 'deflate64-raw') {
          throw new TypeError(`Unsupported compression format: '${format}'`)
        }
        return new (Native as new (f: string, o?: unknown) => unknown)(format, options)
      }
      Chrome91.prototype = (Native as { prototype: unknown }).prototype
      ;(globalThis as unknown as Record<string, unknown>)['DecompressionStream'] = Chrome91
    })

    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))

    // polyfill 必须在应用脚本跑之前就装好 —— main.ts 第一行 import 保证了这个顺序
    await page.goto('/#/')
    const installed = await page.evaluate(
      () =>
        ((window as unknown as Record<string, unknown>)['__HPF_CAPABILITIES__'] as
          | { ok: boolean; problems: Array<{ code: string }> }
          | undefined)?.ok,
    )
    // 兜底生效 → 能力探测应该报告"没问题"
    expect(installed, 'deflate-raw 兜底应让能力探测通过').toBe(true)

    const opened = await openLocalBook(page, REAL_BOOK)
    expect(opened.cfi, '真实书给出了定位 CFI').not.toBe('')
    expect(opened.pages, '真实书真的分了页').toBeGreaterThan(1)

    // 真实目录 + 真实正文：只有解压成功才可能拿到这些
    await openToc(page)
    const tocItems = page.locator('[data-testid="toc-sidebar"] li, [data-testid="toc-overlay"] li')
    await expect.poll(() => tocItems.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(20)

    await tocItems.nth(4).locator('button').click()
    await expect.poll(async () => (await probe(page)).textLength, { timeout: 20_000 }).toBeGreaterThan(2000)

    const chapter = await probe(page)
    expect(chapter.textStart, '正文是真实英文原文').toContain('Letter')

    // 翻页依然可用
    await page.getByTestId('next-page').click()
    await expect.poll(async () => (await probe(page)).cfi, { timeout: 20_000 }).not.toBe(chapter.cfi)

    expect(pageErrors, pageErrors.join('\n')).toEqual([])
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'e2e-legacy-deflate-raw.png') })
  })

  /**
   * ★ 第三个阻塞点（mobile-dev 在 WebView 91 上一手实测）：
   *
   *   Tailwind v4 把所有样式包在 `@layer theme/base/components/utilities` 里，
   *   而 `@layer` 是 **Chrome 99+** 才有。WebView 91 把整个 `@layer` 块
   *   **静默丢弃** —— 不报错、不抛异常、console 干净。
   *
   *   后果：`.absolute{position:absolute}` 算出 static、`.flex` 算出 block、
   *   `.h-full` 算出 auto → 阅读器根容器塌掉 → foliate-view 撑到 1482px
   *   （视口只有 843px）→ paginator 容器尺寸错 → **真书渲染不出正文**
   *   （iframes=0、0%、eventCount=0）。
   *
   *   这个 bug 与 builtin、与 deflate 都无关，是**纯 CSS 能力缺失**。
   *   修法：构建期用官方 @csstools/postcss-cascade-layers 扁平化（vite.config.ts 的 css.postcss）。
   *
   * 这条测试复刻 91 的行为：addInitScript 在**任何样式表解析之前**把
   * CSSLayerBlockRule / CSSLayerStatementRule 置为 undefined —— 这是
   * Chromium 判定"不支持 @layer"的真实探测方式，浏览器随即丢弃 layer 块。
   */
  test('模拟 Chromium 91 不支持 @layer：真实 EPUB 仍能正常排版', async ({ page }) => {
    test.skip(!existsSync(REAL_BOOK), `缺少真实测试书 ${REAL_BOOK}`)

    await page.addInitScript(() => {
      // Chromium 用这两个构造器是否存在来判断 CSS @layer 支持。
      // 抹掉它们 = 让浏览器认为"我不支持 @layer" → layer 块被丢弃。
      const g = globalThis as unknown as Record<string, unknown>
      g['CSSLayerBlockRule'] = undefined
      g['CSSLayerStatementRule'] = undefined
      // 双保险：把 CSS.supports 也骗过去（部分版本走这条路径）
      const originalSupports = (CSS as unknown as { supports?: (...args: unknown[]) => boolean }).supports
      if (typeof originalSupports === 'function') {
        ;(CSS as unknown as Record<string, unknown>)['supports'] = (...args: unknown[]) => {
          const first = String(args[0] ?? '')
          if (first.includes('@layer') || first === 'layer') return false
          return originalSupports.apply(CSS, args)
        }
      }
    })

    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))

    await page.goto('/#/')

    // 先断言"@layer 确实被丢弃了" —— 否则这条测试是空跑
    const layerSupport = await page.evaluate(() => ({
      blockRule: typeof (globalThis as unknown as Record<string, unknown>)['CSSLayerBlockRule'],
      // 关键：展平后样式表里不应再有 layer 块
      layerRules: (() => {
        let count = 0
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from((sheet as CSSStyleSheet).cssRules)) {
              const name = (rule as unknown as { constructor: { name?: string } }).constructor?.name ?? ''
              if (name === 'CSSLayerBlockRule' || name === 'CSSLayerStatementRule') count += 1
            }
          } catch {
            // 跨域样式表读不到，忽略
          }
        }
        return count
      })(),
    }))
    expect(layerSupport.blockRule, '已抹掉 CSSLayerBlockRule 以复刻 91').toBe('undefined')
    expect(layerSupport.layerRules, '构建产物里不应再有任何 @layer 块').toBe(0)

    // 先打开真书，再断言"布局类真的生效了"（reader-host 只在阅读页存在）
    const opened = await openLocalBook(page, REAL_BOOK)
    expect(opened.cfi).not.toBe('')
    expect(opened.pages, '真实书真的分了页').toBeGreaterThan(1)

    const layout = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="reader-host"]') as HTMLElement | null
      // 阅读器根容器是 <div class="relative flex h-full w-full overflow-hidden" data-orientation=...>
      const root = host?.closest('div[data-orientation]') as HTMLElement | null
      const style = (el: HTMLElement | null) => (el ? getComputedStyle(el) : null)
      return {
        rootDisplay: style(root)?.display ?? '',
        hostPosition: style(host)?.position ?? '',
        hostHeight: host?.getBoundingClientRect().height ?? 0,
        innerHeight: window.innerHeight,
      }
    })
    // 展平生效后 .flex 应是 flex（丢弃时会退化成 block）
    expect(layout.rootDisplay, 'flex 工具类应生效（@layer 被丢弃时会变成 block）').toBe('flex')
    expect(layout.hostPosition, 'relative 工具类应生效').toBe('relative')
    // 宿主不应超过视口高度 —— 丢弃 @layer 时会撑到 1482px
    expect(layout.hostHeight, '正文宿主高度不应超过视口').toBeLessThanOrEqual(layout.innerHeight + 40)

    await openToc(page)
    const tocItems = page.locator('[data-testid="toc-sidebar"] li, [data-testid="toc-overlay"] li')
    await expect.poll(() => tocItems.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(20)
    await tocItems.nth(4).locator('button').click()
    await expect.poll(async () => (await probe(page)).textLength, { timeout: 20_000 }).toBeGreaterThan(2000)

    expect(pageErrors, pageErrors.join('\n')).toEqual([])
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'e2e-legacy-css-layer.png') })
  })

  test('模拟 Chromium 91：删掉 ES2022+ 内置对象后仍能打开并阅读', async ({ page }) => {
    await page.addInitScript(() => {
      // 这些是审计（scripts/audit-builtins.mjs）在源码+产物里扫出来的真实依赖
      const targets: Array<[object, string]> = [
        [Object, 'groupBy'],
        [Object, 'hasOwn'],
        [Map, 'groupBy'],
        [Array.prototype, 'at'],
        [String.prototype, 'at'],
        [Array.prototype, 'findLast'],
        [Array.prototype, 'findLastIndex'],
        [Array.prototype, 'toSorted'],
        [Array.prototype, 'toReversed'],
        [Array.prototype, 'toSpliced'],
        [Array.prototype, 'with'],
        [Promise, 'withResolvers'],
        [Promise, 'try'],
        [globalThis, 'structuredClone'],
        [globalThis.crypto, 'randomUUID'],
        [AbortSignal, 'timeout'],
      ]
      for (const [target, key] of targets) {
        try {
          delete (target as Record<string, unknown>)[key]
        } catch {
          // 某些属性不可配置：记下来即可，测试后面的断言才是关键
        }
      }
    })

    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))

    await page.goto('/#/reader/sample')
    const state = await waitForEngine(page)

    // 书真的打开了：有正文、有分页位置
    expect(state.textLength).toBeGreaterThan(0)
    expect(state.cfi).not.toBe('')
    expect(state.textStart).toContain('HPF Reader')

    // polyfill 装上了（启动日志也有一份，这里直接查运行时）
    const installed = await page.evaluate(() => ({
      groupBy: typeof (Object as unknown as Record<string, unknown>)['groupBy'],
      hasOwn: typeof (Object as unknown as Record<string, unknown>)['hasOwn'],
      findLastIndex: typeof (Array.prototype as unknown as Record<string, unknown>)['findLastIndex'],
      withResolvers: typeof (Promise as unknown as Record<string, unknown>)['withResolvers'],
      structuredClone: typeof (globalThis as unknown as Record<string, unknown>)['structuredClone'],
    }))
    expect(installed).toEqual({
      groupBy: 'function',
      hasOwn: 'function',
      findLastIndex: 'function',
      withResolvers: 'function',
      structuredClone: 'function',
    })

    // 翻页依然可用
    await page.getByTestId('next-page').click()
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
        const now = el?.lastLocation?.cfi ?? ''
        return now !== '' && now !== prev
      },
      state.cfi,
      { timeout: 15_000 },
    )

    expect(pageErrors, pageErrors.join('\n')).toEqual([])
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'e2e-legacy-webview-sim.png') })
  })
})

test.describe('L2 隔离与冒烟', () => {
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
    await waitForEngine(page)

    // 章节文档里必须存在我们注入的 meta CSP（L2 的硬指标）
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
    expect(csp?.text ?? '').toContain('HPF Reader')

    // 外链样式表被内联为 <style>（既保排版又不放宽 CSP）
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

    // 留下视觉证据（人工复核排版用）
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'e2e-sample-reader.png') })

    expect(pageErrors, pageErrors.join('\n')).toEqual([])
    expect(
      consoleErrors.filter((line) => !line.includes('Failed to load resource')),
      consoleErrors.join('\n'),
    ).toEqual([])
    // 404 只允许进度上报（E2E 环境没有 /v1 后端）；其余 404 都算 bug
    expect([...new Set(notFound)].filter((p) => p !== '/v1/sync/push')).toEqual([])
  })

  test('书库空态与设置页可用（无后端也不白屏）', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/书库|Library/)
    // 无后端时的诚实降级：空态照常显示（不是错误页），另有提示说明处于本地模式
    await expect(page.getByTestId('library-empty')).toBeVisible()
    await expect(page.getByTestId('library-local-mode')).toBeVisible()
    // 打开本地文件的入口必须在
    await expect(page.getByTestId('open-local')).toBeVisible()

    await page.goto('/#/settings')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/设置|Settings/)
    await expect(page.getByText(/E-ink/)).toBeVisible()

    await page.getByRole('button', { name: 'Dark', exact: true }).first().click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })
})