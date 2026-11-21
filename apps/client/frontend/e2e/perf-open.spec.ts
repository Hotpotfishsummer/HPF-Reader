import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pinReaderBar } from './reader-chrome'

/**
 * ★ 初排耗时测量台（针对"排版会花十几/数十秒"的回归）。
 *
 * 与 perf-reflow.spec.ts 的区别：那个测**拖动过程中**的逐帧重排，
 * 这个测**打开一本书到排版稳定**这一段（用户截图的 1919×1199 大窗）。
 *
 * 量三件事，都是引擎真实开销：
 *   - `openMs`：从导航到拿到第一个 CFI（排版真正产出）的墙钟时间；
 *   - `roCalls` / `heavyCalls`：初排期间 ResizeObserver 回调次数与"真重排"次数。
 *     ★ 如果 `heavyCalls` 是几百上千而不是个位数，说明重排被**反复触发**（循环），
 *       这才是"十几秒"的根因，而不是单次重排慢。
 *   - `longtasks`：主线程连续占用 ≥50ms 的次数。
 *
 * 只在 `HPF_PERF=1` 时跑（同 perf-reflow.spec.ts 的门控）。
 */

const REPO_ROOT = path.resolve(process.cwd(), '../../..')
// 可用 HPF_BOOK 覆盖书路径（例如测大书时指向 large-book.epub）。
const REAL_BOOK = process.env['HPF_BOOK']
  ? path.resolve(REPO_ROOT, process.env['HPF_BOOK'])
  : path.join(REPO_ROOT, 'testdata', 'books', 'frankenstein.epub')
const EVIDENCE_DIR = path.resolve(process.cwd(), '../evidence')
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

test.describe('初排耗时测量台', () => {
  test.skip(!ENABLED, '只在 HPF_PERF=1 时测量')
  test.skip(!existsSync(REAL_BOOK), `缺少真实测试书 ${REAL_BOOK}`)

  test('打开书到排版稳定：初排的重排次数与耗时', async ({ page }) => {
    test.setTimeout(180_000)
    await page.addInitScript(instrument)
    await pinReaderBar(page)

    // 用户截图的窗口尺寸：1919×1199（大窗，双栏 + 侧栏）。
    await page.setViewportSize({ width: 1919, height: 1199 })
    await page.goto('/#/')
    await page.getByTestId('local-file-input').setInputFiles(REAL_BOOK)

    // 等第一个 CFI（排版真正产出）。用长超时，正是要量这个"要等多久"。
    const t0 = Date.now()
    await page.waitForFunction(
      () => {
        const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
        return Boolean(el?.lastLocation?.cfi)
      },
      undefined,
      { timeout: 120_000 },
    )
    const openMs = Date.now() - t0

    // 再等一小段，让初排的连锁重排都落定。
    await page.waitForTimeout(1500)

    const data = await page.evaluate(() => {
      const w = window as unknown as {
        __RO__: { calls: number; totalMs: number; maxMs: number; samples: number[] }
        __LONGTASKS__: { durations: number[] }
      }
      const el = document.querySelector('foliate-view') as unknown as {
        lastLocation?: { cfi?: string }
        renderer?: { pages?: number }
      } | null
      return {
        ro: { calls: w.__RO__.calls, totalMs: w.__RO__.totalMs, maxMs: w.__RO__.maxMs, samples: w.__RO__.samples },
        longtasks: w.__LONGTASKS__.durations,
        pages: el?.renderer?.pages ?? 0,
        cfi: el?.lastLocation?.cfi ?? '',
      }
    })

    const { heavy, light } = splitSamples(data.ro.samples)
    const report = {
      note: '初排测量台：1919×1199 打开 frankenstein.epub，量打开到第一个 CFI 的墙钟与重排次数',
      viewport: { width: 1919, height: 1199 },
      openMs,
      pages: data.pages,
      cfi: data.cfi,
      ro: {
        calls: data.ro.calls,
        totalMs: Number(data.ro.totalMs.toFixed(2)),
        maxMs: Number(data.ro.maxMs.toFixed(2)),
      },
      roSplit: {
        note: '≥1ms 视为"真重排（paginator columnize）"，<1ms 视为轻量回调',
        heavyCalls: heavy.length,
        lightCalls: light.length,
        heavyTotalMs: Number(heavy.reduce((a, b) => a + b, 0).toFixed(2)),
        heavyMaxMs: Number((heavy.length > 0 ? Math.max(...heavy) : 0).toFixed(2)),
      },
      longtasks: {
        samples: data.longtasks.length,
        maxMs: Number((data.longtasks.length > 0 ? Math.max(...data.longtasks) : 0).toFixed(1)),
        totalMs: Number(data.longtasks.reduce((a, b) => a + b, 0).toFixed(1)),
      },
    }

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const out = path.join(EVIDENCE_DIR, `optimization-open-${process.env['HPF_PERF_TAG'] ?? 'run'}.json`)
    writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')

    console.log('[perf] open summary:', JSON.stringify({ openMs, pages: data.pages, ro: report.ro, roSplit: report.roSplit, longtasks: report.longtasks }))
    console.log('[perf] evidence:', out)
    expect(data.cfi, '应能拿到 CFI').toBeTruthy()
  })
})
