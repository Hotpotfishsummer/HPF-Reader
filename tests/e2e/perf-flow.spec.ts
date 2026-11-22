import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * ★ 完整动线排版测量台（针对"排版会花十几/数十秒"的回归）。
 *
 * perf-open.spec.ts 只测了**初排**（打开书到第一个 CFI），结果 251ms / 4 次 RO —— 初排不慢。
 * 本台覆盖用户真实动线，逐段测量墙钟与重排次数：
 *   ① 开书（1919×1199，不 pin 状态栏，还原用户默认场景）
 *   ② 光标靠近顶部 → 状态栏展开（pt-0 → pt-12，阅读面高度 -48px）
 *   ③ 光标离开 → 状态栏收起（pt-12 → pt-0，阅读面高度 +48px）
 *   ④ 再靠近 → 再展开
 *   ⑤ 窗口缩放 1919×1199 → 1280×800
 *
 * ★ 判定：如果某段的 `wallMs` 是秒级且 `heavyCalls` 很高，说明该段触发了
 *   反复重排（循环）—— 这才是"十几秒"的根因。如果 `wallMs` 都是毫秒级，
 *   说明排版本身不慢，问题在别处（书加载 / 库页 / 其他）。
 *
 * 只在 `HPF_PERF=1` 时跑。
 */

const REPO_ROOT = path.resolve(process.cwd(), '../../..')
const REAL_BOOK = path.join(REPO_ROOT, 'tests', 'fixtures', 'books', 'frankenstein.epub')
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../../tests/evidence/client')
const ENABLED = process.env['HPF_PERF'] === '1'

function instrument(): void {
  const w = window as unknown as {
    __RO__: { calls: number; totalMs: number; maxMs: number; samples: number[] }
    __LONGTASKS__: { durations: number[] }
    __T0__: number
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
          if (box.samples.length < 20000) box.samples.push(dt)
        }
      })
    }
  }
  window.ResizeObserver = TimedResizeObserver as unknown as typeof ResizeObserver

  w.__LONGTASKS__ = { durations: [] }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (w.__LONGTASKS__.durations.length < 500) w.__LONGTASKS__.durations.push(entry.duration)
      }
    })
    observer.observe({ type: 'longtask', buffered: true })
  } catch {
    // 不支持就跳过。
  }
  w.__T0__ = performance.now()
}

function splitSamples(samples: number[]): { heavy: number[]; light: number[] } {
  const heavy: number[] = []
  const light: number[] = []
  for (const ms of samples) (ms >= 1 ? heavy : light).push(ms)
  return { heavy, light }
}

/** 读取当前累计的 RO / longtask 统计。 */
function readStats(page: import('@playwright/test').Page): Promise<{
  ro: { calls: number; totalMs: number; maxMs: number; samples: number[] }
  longtasks: number[]
}> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __RO__: { calls: number; totalMs: number; maxMs: number; samples: number[] }
      __LONGTASKS__: { durations: number[] }
    }
    return { ro: w.__RO__, longtasks: w.__LONGTASKS__.durations }
  })
}

test.describe('完整动线排版测量台', () => {
  test.skip(!ENABLED, '只在 HPF_PERF=1 时测量')
  test.skip(!existsSync(REAL_BOOK), `缺少真实测试书 ${REAL_BOOK}`)

  test('开书→光标靠近→离开→再靠近→缩放：逐段排版耗时与重排次数', async ({ page }) => {
    test.setTimeout(300_000)
    await page.addInitScript(instrument)

    // 用户截图的窗口尺寸：1919×1199（大窗，双栏 + 侧栏）。不 pin 状态栏，还原默认场景。
    await page.setViewportSize({ width: 1919, height: 1199 })
    await page.goto('/#/')
    await page.getByTestId('local-file-input').setInputFiles(REAL_BOOK)

    // 等第一个 CFI（排版真正产出）。用长超时，正是要量这个"要等多久"。
    const openT0 = Date.now()
    await page.waitForFunction(
      () => {
        const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
        return Boolean(el?.lastLocation?.cfi)
      },
      undefined,
      { timeout: 120_000 },
    )
    const openMs = Date.now() - openT0
    // 让初排的连锁重排落定。
    await page.waitForTimeout(1000)

    const segments: Array<{ name: string; wallMs: number; roCalls: number; heavyCalls: number; roMaxMs: number; longtasks: number }> = []

    // 记录初排后的基线。
    const base = await readStats(page)
    const baseCalls = base.ro.calls
    const baseHeavy = splitSamples(base.ro.samples).heavy.length

    // ---- ② 光标靠近顶部 → 状态栏展开 ----
    let t0 = Date.now()
    // 把光标移到阅读面顶部（viewTop 附近），触发 barShown → pt-12。
    const host = page.getByTestId('reader-host')
    const box = await host.boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + 10)
    await page.waitForTimeout(2000)
    let s = await readStats(page)
    let { heavy, light } = splitSamples(s.ro.samples.slice(base.ro.samples.length))
    segments.push({
      name: 'bar-show',
      wallMs: Date.now() - t0,
      roCalls: s.ro.calls - baseCalls,
      heavyCalls: heavy.length,
      roMaxMs: Number(s.ro.maxMs.toFixed(2)),
      longtasks: s.longtasks.length - base.longtasks.length,
    })

    // ---- ③ 光标离开 → 状态栏收起 ----
    t0 = Date.now()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
    await page.waitForTimeout(2000)
    const base2 = await readStats(page)
    s = await readStats(page)
    // 重新计算：以 bar-show 后的状态为基线。
    const prevCalls = segments[0].roCalls > 0 ? baseCalls + segments[0].roCalls : baseCalls
    ;({ heavy, light } = splitSamples(s.ro.samples.slice(base.ro.samples.length + segments[0].roCalls)))
    segments.push({
      name: 'bar-hide',
      wallMs: Date.now() - t0,
      roCalls: s.ro.calls - prevCalls,
      heavyCalls: heavy.length,
      roMaxMs: Number(s.ro.maxMs.toFixed(2)),
      longtasks: s.longtasks.length - base2.longtasks.length,
    })

    // ---- ④ 再靠近 → 再展开 ----
    t0 = Date.now()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + 10)
    await page.waitForTimeout(2000)
    const base3 = await readStats(page)
    s = await readStats(page)
    const prevCalls2 = prevCalls + segments[1].roCalls
    ;({ heavy, light } = splitSamples(s.ro.samples.slice(base.ro.samples.length + segments[0].roCalls + segments[1].roCalls)))
    segments.push({
      name: 'bar-show-2',
      wallMs: Date.now() - t0,
      roCalls: s.ro.calls - prevCalls2,
      heavyCalls: heavy.length,
      roMaxMs: Number(s.ro.maxMs.toFixed(2)),
      longtasks: s.longtasks.length - base3.longtasks.length,
    })

    // ---- ⑤ 窗口缩放 ----
    t0 = Date.now()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(2000)
    const base4 = await readStats(page)
    s = await readStats(page)
    const prevCalls3 = prevCalls2 + segments[2].roCalls
    ;({ heavy, light } = splitSamples(s.ro.samples.slice(base.ro.samples.length + segments[0].roCalls + segments[1].roCalls + segments[2].roCalls)))
    segments.push({
      name: 'window-resize',
      wallMs: Date.now() - t0,
      roCalls: s.ro.calls - prevCalls3,
      heavyCalls: heavy.length,
      roMaxMs: Number(s.ro.maxMs.toFixed(2)),
      longtasks: s.longtasks.length - base4.longtasks.length,
    })

    const totalCalls = s.ro.calls
    const totalHeavy = splitSamples(s.ro.samples).heavy.length
    const report = {
      note: '完整动线排版测量台：1919×1199 开书→光标靠近→离开→再靠近→缩放，逐段墙钟与重排次数',
      viewport: { width: 1919, height: 1199 },
      openMs,
      initialLayout: { roCalls: baseCalls, heavyCalls: baseHeavy },
      segments,
      totals: {
        roCalls: totalCalls,
        heavyCalls: totalHeavy,
        longtasks: s.longtasks.length,
        longtaskMaxMs: Number((s.longtasks.length > 0 ? Math.max(...s.longtasks) : 0).toFixed(1)),
      },
    }

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const out = path.join(EVIDENCE_DIR, `optimization-flow-${process.env['HPF_PERF_TAG'] ?? 'run'}.json`)
    writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')

    console.log('[perf] flow summary:', JSON.stringify({ openMs, initialLayout: report.initialLayout, segments, totals: report.totals }))
    console.log('[perf] evidence:', out)
    // 不设硬断言：这是测量台，目的是看数字。只要没抛异常就算通过。
    expect(totalCalls).toBeGreaterThanOrEqual(0)
  })
})
