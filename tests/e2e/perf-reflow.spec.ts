import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pinReaderBar } from './reader-chrome'

// 顶部状态栏默认收起：测量台用 pin 把它按住（见 tests/e2e/reader-chrome.ts）。
// ⚠️ 这不是可选项：状态栏收起时阅读面高度会多出 48px，分页数与改造前的基线
//    就对不上，测出来的"重排次数"没法与历史证据比较。
test.beforeEach(async ({ page }) => {
  await pinReaderBar(page)
})

/**
 * 重排 / 动画流畅度**测量台**（不是断言型回归测试）。
 *
 * 为什么单独做一个测量台：
 *   「缩放窗口时正文有阻滞感」「动画不跟手」这类问题无法用 `expect(...).toBe(...)` 表达，
 *   必须先拿到**数量级**（每次尺寸变化花了多少主线程时间、一帧预算 16.7ms/8.3ms 够不够用），
 *   否则只能靠感觉改代码 —— 改完还是靠感觉说"好像顺了"。
 *
 * 默认**不跑**（`test.skip`），只有显式 `HPF_PERF=1` 才执行，避免给 CI 增加不稳定项：
 *
 *     $env:HPF_PERF=1; corepack pnpm exec playwright test e2e/perf-reflow.spec.ts
 *
 * 测的量（都是引擎真实开销，不是估算）：
 *   - `roMs`：ResizeObserver 回调里花掉的主线程时间合计 —— 等价于「重排花了多少毫秒」。
 *     paginator 的 `#observer = new ResizeObserver(() => this.render())`（paginator.js:430）
 *     走的就是这条路径，所以这个计时器直接量到 paginator 每次重排的成本。
 *   - `wallMs`：一步「改尺寸 → 主线程落定」的实际墙钟时间。
 *     ★ 判据：120Hz 的每帧预算是 8.3ms，144Hz 是 6.9ms。一步 > 8.3ms 就意味着
 *     **高刷屏上必然掉帧**，而 60Hz（16.7ms）看起来"还行" —— 这正是"高刷不适配"的物理原因。
 *   - 帧间隔 p50/p95/max：拖拽过程中的真实掉帧分布。
 *
 * 结论落盘到 `tests/evidence/client/optimization-reflow.json`，方便前后对比复核。
 */

const REPO_ROOT = path.resolve(process.cwd(), '../../..')
const REAL_BOOK = path.join(REPO_ROOT, 'tests', 'fixtures', 'books', 'frankenstein.epub')
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../../tests/evidence/client')

const ENABLED = process.env['HPF_PERF'] === '1'

/** 在页面里替换 ResizeObserver，给每次回调计时；并常驻一个 rAF 帧间隔记录器。 */
function instrument(): void {
  const w = window as unknown as {
    __RO__: { calls: number; totalMs: number; maxMs: number; samples: number[] }
    __FRAMES__: { deltas: number[] }
    __LONGTASKS__: { durations: number[] }
    __RAF_HOOK__: boolean
  }
  w.__RO__ = { calls: 0, totalMs: 0, maxMs: 0, samples: [] }
  const Native = window.ResizeObserver
  class TimedResizeObserver extends Native {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        const t0 = performance.now()
        try {
          callback(entries, observer)
        } finally {
          const dt = performance.now() - t0
          const box = w.__RO__
          box.calls += 1
          box.totalMs += dt
          if (dt > box.maxMs) box.maxMs = dt
          if (box.samples.length < 5000) box.samples.push(dt)
        }
      })
    }
  }
  window.ResizeObserver = TimedResizeObserver as unknown as typeof ResizeObserver

  w.__FRAMES__ = { deltas: [] }
  let last = performance.now()
  const tick = (t: number): void => {
    if (w.__FRAMES__.deltas.length < 20000) w.__FRAMES__.deltas.push(t - last)
    last = t
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  // ★ longtask：主线程一次连续占用 ≥50ms 的记录。
  //   帧间隔只能告诉你"有没有掉帧"，不能告诉你"主线程到底忙不忙"——
  //   如果优化后主线程仍然被别的活儿占满（比如每帧都在重渲染），
  //   帧间隔会贴在刷新率上限上，看起来"很流畅"，其实已经没有余量了。
  //   longtask 直接给出"主线程有没有被长时间占用"的答案。
  w.__LONGTASKS__ = { durations: [] }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (w.__LONGTASKS__.durations.length < 500) w.__LONGTASKS__.durations.push(entry.duration)
      }
    })
    observer.observe({ type: 'longtask', buffered: true })
  } catch {
    // 某些环境不支持 longtask（老 WebView 的 PerformanceObserver 可能只支持少数类型）
    // 不支持就跳过，不影响其余测量。
  }
}

async function openLongChapter(page: Page): Promise<{ pages: number; cfi: string }> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/#/')
  await page.getByTestId('local-file-input').setInputFiles(REAL_BOOK)
  await expect(page).toHaveURL(/#\/reader\//, { timeout: 15_000 })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
      return Boolean(el?.lastLocation?.cfi)
    },
    undefined,
    { timeout: 30_000 },
  )

  // 固定用同一个长章节：短章节重排成本低，测不出差距（假阴性）。
  const sidebar = page.getByTestId('toc-sidebar')
  if ((await sidebar.count()) === 0) await page.getByTestId('toggle-toc').click()
  const items = page.locator('[data-testid="toc-sidebar"] li')
  const count = await items.count()
  expect(count).toBeGreaterThanOrEqual(20)
  await items.nth(Math.min(10, count - 1)).locator('button').click()
  await page.waitForTimeout(800)

  // 关掉侧栏：测量时让阅读面拿到整幅宽度，避免侧栏占位干扰。
  if ((await page.getByTestId('toc-sidebar').count()) > 0) {
    await page.getByTestId('toggle-toc').click()
    await page.waitForTimeout(400)
  }

  return state(page)
}

async function state(page: Page): Promise<{ pages: number; cfi: string }> {
  return page.evaluate(() => {
    const el = document.querySelector('foliate-view') as unknown as {
      lastLocation?: { cfi?: string }
      renderer?: { pages?: number }
    } | null
    return { pages: el?.renderer?.pages ?? 0, cfi: el?.lastLocation?.cfi ?? '' }
  })
}

interface StepRow {
  width: number
  /** 这一步里 ResizeObserver（= 重排）回调合计花了多少毫秒。 */
  roMs: number
  /** 这一步里重排被触发了多少次。 */
  roCalls: number
  /** 改尺寸 → 主线程落定的墙钟时间。 */
  wallMs: number
}

/**
 * 直接驱动「阅读面」尺寸（而不是窗口尺寸）。
 *
 * 这样做的理由是**它与窗口缩放走的是同一条代码路径**：阅读面变窄 → foliate-view 变窄
 * → paginator 内部 container 触发 ResizeObserver → render() 重新分栏。
 * 好处是可以在页面内用 rAF 精确控制速率，不受 Playwright setViewportSize 往返延迟干扰，
 * 拿到的数字信噪比高得多。
 */
async function dragSurface(
  page: Page,
  options: { from: number; to: number; steps: number; rafPerStep: number },
): Promise<StepRow[]> {
  return page.evaluate(async ({ from, to, steps, rafPerStep }) => {
    const host = document.querySelector('[data-testid="reader-host"]') as HTMLElement
    const box = (window as unknown as { __RO__: { calls: number; totalMs: number } }).__RO__
    const raf = (): Promise<void> => new Promise<void>((r) => requestAnimationFrame(() => r()))

    // 把 flex-1 的阅读面改成固定宽度，让它在不改变窗口的前提下被"拖动"。
    host.style.flex = 'none'
    host.style.height = '100%'
    host.style.width = from + 'px'
    for (let i = 0; i < 8; i++) await raf()

    const rows: StepRow[] = []
    for (let i = 1; i <= steps; i += 1) {
      const width = Math.round(from + ((to - from) * i) / steps)
      const calls0 = box.calls
      const ms0 = box.totalMs
      const wall0 = performance.now()
      host.style.width = width + 'px'
      for (let r = 0; r < rafPerStep; r++) await raf()
      rows.push({
        width,
        roMs: Number((box.totalMs - ms0).toFixed(3)),
        roCalls: box.calls - calls0,
        wallMs: Number((performance.now() - wall0).toFixed(2)),
      })
    }
    return rows
  }, options)
}

function summarize(rows: StepRow[]): Record<string, number> {
  const pick = (values: number[]): number[] => [...values].sort((a, b) => a - b)
  const pct = (sorted: number[], p: number): number =>
    sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number)
  const ro = pick(rows.map((r) => r.roMs))
  const wall = pick(rows.map((r) => r.wallMs))
  const sum = (v: number[]): number => v.reduce((a, b) => a + b, 0)
  return {
    steps: rows.length,
    roCalls: sum(rows.map((r) => r.roCalls)),
    roCallsPerStep: Number((sum(rows.map((r) => r.roCalls)) / rows.length).toFixed(3)),
    roTotalMs: Number(sum(rows.map((r) => r.roMs)).toFixed(2)),
    roMeanMs: Number((sum(rows.map((r) => r.roMs)) / rows.length).toFixed(3)),
    roP50Ms: Number(pct(ro, 0.5).toFixed(3)),
    roP95Ms: Number(pct(ro, 0.95).toFixed(3)),
    roMaxMs: Number(ro[ro.length - 1]?.toFixed(3) ?? 0),
    wallMeanMs: Number((sum(rows.map((r) => r.wallMs)) / rows.length).toFixed(2)),
    wallP95Ms: Number(pct(wall, 0.95).toFixed(2)),
    wallMaxMs: Number(wall[wall.length - 1]?.toFixed(2) ?? 0),
  }
}

/**
 * 把 ResizeObserver 采样按"重量"分开计数。
 *
 * ★ 这一步是必须的：`useReaderReflow` 自己也有一个 ResizeObserver（观察阅读面），
 * 它的回调只是写一个 transform（0.1ms 量级）。如果不区分，
 * "重排次数"会被这些轻量回调淹没，看不出真正的分栏重排到底发生了几次。
 * 判据用 1ms：paginator 的 columnize + 强制布局实测是 3~8ms 量级，
 * 写 transform 是 0.1ms 量级，两者差一个数量级，阈值取中间很稳。
 */
function splitSamples(samples: number[]): { heavy: number[]; light: number[] } {
  const heavy: number[] = []
  const light: number[] = []
  for (const ms of samples) (ms >= 1 ? heavy : light).push(ms)
  return { heavy, light }
}

test.describe('重排流畅度测量台', () => {
  test.skip(!ENABLED, '只在 HPF_PERF=1 时测量（不是回归断言）')
  test.skip(!existsSync(REAL_BOOK), `缺少真实测试书 ${REAL_BOOK}`)

  test('拖动阅读面宽度：逐帧重排成本与帧间隔', async ({ page }) => {
    test.setTimeout(180_000)
    await page.addInitScript(instrument)
    const before = await openLongChapter(page)

    // 清空帧记录与 RO 采样，只留拖拽期间的数据。
    await page.evaluate(() => {
      const w = window as unknown as {
        __FRAMES__: { deltas: number[] }
        __RO__: { calls: number; totalMs: number; maxMs: number; samples: number[] }
      }
      w.__FRAMES__.deltas.length = 0
      w.__RO__.samples.length = 0
    })

    // 120 步、每步等 2 帧：等价于"连续拖 2 秒左右"，覆盖整个宽度区间。
    const rows = await dragSurface(page, { from: 1100, to: 520, steps: 120, rafPerStep: 2 })
    const collected = await page.evaluate(() => {
      const w = window as unknown as {
        __FRAMES__: { deltas: number[] }
        __RO__: { samples: number[] }
        __LONGTASKS__: { durations: number[] }
      }
      return { frames: w.__FRAMES__.deltas, samples: w.__RO__.samples, longtasks: w.__LONGTASKS__.durations }
    })
    const frames = collected.frames
    const longtasks = collected.longtasks

    const after = await state(page)
    const summary = summarize(rows)
    const { heavy, light } = splitSamples(collected.samples)
    const sortedFrames = [...frames].sort((a, b) => a - b)
    const pct = (p: number): number =>
      Number((sortedFrames[Math.min(sortedFrames.length - 1, Math.floor(sortedFrames.length * p))] ?? 0).toFixed(2))

    const report = {
      note: 'HPF-Reader 重排测量台：frankenstein.epub 第 11 个目录项，阅读面 1100px → 520px，120 步 × 2 帧',
      budget: { hz60: 16.67, hz120: 8.33, hz144: 6.94 },
      before,
      after,
      reflow: summary,
      roSplit: {
        note: '≥1ms 视为"真重排（paginator columnize）"，<1ms 视为"写 transform 的轻量回调"',
        heavyCalls: heavy.length,
        lightCalls: light.length,
        heavyTotalMs: Number(heavy.reduce((a, b) => a + b, 0).toFixed(2)),
        heavyMaxMs: Number((heavy.length > 0 ? Math.max(...heavy) : 0).toFixed(2)),
        lightTotalMs: Number(light.reduce((a, b) => a + b, 0).toFixed(2)),
        lightMaxMs: Number((light.length > 0 ? Math.max(...light) : 0).toFixed(2)),
      },
      frames: {
        samples: sortedFrames.length,
        p50Ms: pct(0.5),
        p95Ms: pct(0.95),
        maxMs: Number((sortedFrames[sortedFrames.length - 1] ?? 0).toFixed(2)),
        over16ms: frames.filter((d) => d > 16.7).length,
        over8ms: frames.filter((d) => d > 8.33).length,
      },
      longtasks: {
        samples: longtasks.length,
        maxMs: Number((longtasks.length > 0 ? Math.max(...longtasks) : 0).toFixed(1)),
        totalMs: Number(longtasks.reduce((a, b) => a + b, 0).toFixed(1)),
        note: '主线程连续占用 ≥50ms 的次数：0 次才算"高刷有余量"',
      },
      rows,
    }

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const out = path.join(EVIDENCE_DIR, `optimization-reflow-${process.env['HPF_PERF_TAG'] ?? 'run'}.json`)
    writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
    test.info().annotations.push({ type: 'evidence', description: out })

    // 不做"必须小于 X ms"的硬断言（CI 机器性能不可控），只打印给人看。
    console.log('[perf] reflow summary:', JSON.stringify(summary))
    console.log('[perf] ro split:', JSON.stringify(report.roSplit))
    console.log('[perf] frames:', JSON.stringify(report.frames))
    console.log('[perf] longtasks:', JSON.stringify(report.longtasks))
    console.log('[perf] evidence:', out)
  })

  /**
   * 真实窗口缩放（用户实际会做的操作，不是直接改宿主宽度）。
   *
   * 这条测的是同一套机制的**端到端**成立：
   *   - 拖动过程中 `data-frozen="true"`（说明真的进了"冻结 + 缩放跟随"模式）；
   *   - 拖完 `data-frozen="false"`，且 `data-hpf-columns` / 页数收敛到新几何；
   *   - 全程"重排"只发生个位数次，而不是每一步一次。
   */
  test('真实窗口缩放：进入冻结、落定后只重排一次', async ({ page }) => {
    test.setTimeout(180_000)
    await page.addInitScript(instrument)
    const before = await openLongChapter(page)

    await page.evaluate(() => {
      const w = window as unknown as {
        __RO__: { calls: number; totalMs: number; maxMs: number; samples: number[] }
        __LONGTASKS__: { durations: number[] }
      }
      w.__RO__.samples.length = 0
      w.__LONGTASKS__.durations.length = 0
    })

    const frozenFlags: string[] = []
    // 24 步 × 24px ≈ 576px，模拟"用鼠标拽窗口边缘"。
    // ★ 循环里**不做额外读取**：每次 getAttribute 都是一次 CDP 往返，
    //   会把两步之间的间隔拉长到接近 STREAM_GAP_MS，反而把"连续拖动"拆成"离散点击"。
    for (let i = 1; i <= 24; i += 1) {
      await page.setViewportSize({ width: 1280 - i * 24, height: 800 })
      if (i === 12) frozenFlags.push((await page.getAttribute('[data-testid="reader-view"]', 'data-frozen')) ?? '')
    }
    // 拖完立刻读（此时静置计时器还没到 130ms，应仍处于冻结）
    frozenFlags.push((await page.getAttribute('[data-testid="reader-view"]', 'data-frozen')) ?? '')
    const enteredFreeze = frozenFlags.includes('true')

    // 等落定（130ms 静置 + 一次重排 + 一次位置拉回）
    await page.waitForTimeout(800)
    const frozenAfter = await page.getAttribute('[data-testid="reader-view"]', 'data-frozen').catch(() => null)

    const stateAfter = await state(page)
    const columns = await page.getAttribute('foliate-view', 'data-hpf-columns')
    const samples = await page.evaluate(
      () => (window as unknown as { __RO__: { samples: number[]; maxMs: number } }).__RO__.samples,
    )
    const { heavy, light } = splitSamples(samples)
    const longtasks = await page.evaluate(
      () => (window as unknown as { __LONGTASKS__: { durations: number[] } }).__LONGTASKS__.durations,
    )

    const report = {
      note: '真实窗口缩放 1280→704（24 步）：验证 data-frozen 状态机与"只重排一次"',
      before,
      after: stateAfter,
      columns,
      enteredFreeze,
      frozenFlags,
      frozenAfter,
      roSplit: {
        heavyCalls: heavy.length,
        lightCalls: light.length,
        heavyTotalMs: Number(heavy.reduce((a, b) => a + b, 0).toFixed(2)),
        heavyMaxMs: Number((heavy.length > 0 ? Math.max(...heavy) : 0).toFixed(2)),
      },
      longtasks: {
        samples: longtasks.length,
        maxMs: Number((longtasks.length > 0 ? Math.max(...longtasks) : 0).toFixed(1)),
      },
    }

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const out = path.join(EVIDENCE_DIR, 'optimization-window-resize.json')
    writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')

    // 这三条是**机制断言**（不是性能阈值），必须成立，否则"冻结"根本没生效。
    expect(enteredFreeze, '窗口连续缩放期间应进入排版冻结').toBe(true)
    expect(frozenAfter, '落定后应解除冻结').not.toBe('true')
    expect(heavy.length, '整段缩放的真实重排次数应远小于步数').toBeLessThanOrEqual(4)

    console.log('[perf] window resize report:', JSON.stringify({ enteredFreeze, frozenAfter, columns, roSplit: report.roSplit, pages: stateAfter.pages }))
    console.log('[perf] evidence:', out)
  })
})
