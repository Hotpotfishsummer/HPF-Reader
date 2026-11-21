import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * ★ 单章大书初排耗时分解测量台。
 *
 * perf-open.spec.ts 已证明：单章元素数（段落 + 图片）是初排耗时的放大因子——
 * 小书 251ms，单章 4000 段 + 400 图 1583ms 且出现 529ms 长任务。
 *
 * 本台做**细粒度分解**，定位耗时大头：
 *   - `parseMs`：DOMParser 解析章节 XHTML 的耗时；
 *   - `gcsMs` / `gcsCalls`：`getComputedStyle` 累计耗时与次数（setImageSize 逐图调用）；
 *   - `roHeavyMs`：paginator 真重排（columnize + expand）耗时；
 *   - `longtasks`：主线程长任务分布。
 *
 * 判定：若 `gcsMs` 占大头 → setImageSize 的逐图 getComputedStyle 是瓶颈；
 *       若 `parseMs` 占大头 → DOMParser 解析大文档是瓶颈；
 *       若 `roHeavyMs` 占大头 → columnize 布局大文档是瓶颈。
 *
 * 只在 `HPF_PERF=1` 时跑。书路径由 `HPF_BOOK` 指定（默认单章大书）。
 */

const REPO_ROOT = path.resolve(process.cwd(), '../../..')
const REAL_BOOK = process.env['HPF_BOOK']
  ? path.resolve(REPO_ROOT, process.env['HPF_BOOK'])
  : path.join(REPO_ROOT, 'testdata', 'books', 'single-chapter-large.epub')
const EVIDENCE_DIR = path.resolve(process.cwd(), '../evidence')
const ENABLED = process.env['HPF_PERF'] === '1'

function instrument(): void {
  const w = window as unknown as {
    __RO__: { calls: number; totalMs: number; maxMs: number; samples: number[] }
    __LONGTASKS__: { durations: number[] }
    __GCS__: { calls: number; totalMs: number }
    __PARSE__: { calls: number; totalMs: number }
    __GETALL__: { calls: number; totalMs: number }
    __T0__: number
  }
  w.__RO__ = { calls: 0, totalMs: 0, maxMs: 0, samples: [] }
  w.__GCS__ = { calls: 0, totalMs: 0 }
  w.__PARSE__ = { calls: 0, totalMs: 0 }
  w.__GETALL__ = { calls: 0, totalMs: 0 }

  const NativeRO = window.ResizeObserver
  class TimedResizeObserver extends NativeRO {
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

  // getComputedStyle：setImageSize 对每个 img/svg/video 调用。
  const nativeGCS = window.getComputedStyle.bind(window)
  window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
    const t0 = performance.now()
    const style = nativeGCS(el, pseudo)
    w.__GCS__.calls += 1
    w.__GCS__.totalMs += performance.now() - t0
    return style
  }) as typeof window.getComputedStyle

  // DOMParser.parseFromString：解析章节 XHTML。
  const nativeParse = DOMParser.prototype.parseFromString
  DOMParser.prototype.parseFromString = function (this: DOMParser, ...args: unknown[]): Document {
    const t0 = performance.now()
    const doc = (nativeParse as (...a: unknown[]) => Document).apply(this, args)
    w.__PARSE__.calls += 1
    w.__PARSE__.totalMs += performance.now() - t0
    return doc
  }

  // getElementsByTagName('*')：sanitizeDocument 的单次遍历入口。
  const nativeGetAll = Document.prototype.getElementsByTagName
  Document.prototype.getElementsByTagName = function (this: Document, ...args: unknown[]): NodeList {
    const t0 = performance.now()
    const nodes = (nativeGetAll as (...a: unknown[]) => NodeList).apply(this, args)
    w.__GETALL__.calls += 1
    w.__GETALL__.totalMs += performance.now() - t0
    return nodes
  }

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

test.describe('单章大书初排耗时分解', () => {
  test.skip(!ENABLED, '只在 HPF_PERF=1 时测量')
  test.skip(!existsSync(REAL_BOOK), `缺少测试书 ${REAL_BOOK}`)

  test('分解单章大书初排：解析 / getComputedStyle / 重排 / 长任务', async ({ page }) => {
    test.setTimeout(180_000)
    await page.addInitScript(instrument)

    await page.setViewportSize({ width: 1919, height: 1199 })
    await page.goto('/#/')
    await page.getByTestId('local-file-input').setInputFiles(REAL_BOOK)

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
    await page.waitForTimeout(1500)

    const browser = await page.evaluate(() => {
      const w = window as unknown as {
        __RO__: { calls: number; totalMs: number; maxMs: number; samples: number[] }
        __LONGTASKS__: { durations: number[] }
        __GCS__: { calls: number; totalMs: number }
        __PARSE__: { calls: number; totalMs: number }
        __GETALL__: { calls: number; totalMs: number }
      }
      const el = document.querySelector('foliate-view') as unknown as {
        lastLocation?: { cfi?: string }
        renderer?: { pages?: number }
      } | null
      const roSamples = w.__RO__.samples
      const heavy = roSamples.filter((ms) => ms >= 1)
      return {
        pages: el?.renderer?.pages ?? 0,
        parse: { calls: w.__PARSE__.calls, totalMs: Number(w.__PARSE__.totalMs.toFixed(2)) },
        gcs: { calls: w.__GCS__.calls, totalMs: Number(w.__GCS__.totalMs.toFixed(2)) },
        getAll: { calls: w.__GETALL__.calls, totalMs: Number(w.__GETALL__.totalMs.toFixed(2)) },
        ro: {
          calls: w.__RO__.calls,
          totalMs: Number(w.__RO__.totalMs.toFixed(2)),
          maxMs: Number(w.__RO__.maxMs.toFixed(2)),
          heavyCalls: heavy.length,
          heavyTotalMs: Number(heavy.reduce((a, b) => a + b, 0).toFixed(2)),
          heavyMaxMs: Number((heavy.length > 0 ? Math.max(...heavy) : 0).toFixed(2)),
        },
        longtasks: {
          samples: w.__LONGTASKS__.durations.length,
          maxMs: Number((w.__LONGTASKS__.durations.length > 0 ? Math.max(...w.__LONGTASKS__.durations) : 0).toFixed(1)),
          totalMs: Number(w.__LONGTASKS__.durations.reduce((a, b) => a + b, 0).toFixed(1)),
        },
      }
    })

    const data = { openMs, ...browser }

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const out = path.join(EVIDENCE_DIR, `optimization-breakdown-${process.env['HPF_PERF_TAG'] ?? 'run'}.json`)
    writeFileSync(out, JSON.stringify(data, null, 2), 'utf8')

    console.log('[perf] breakdown:', JSON.stringify(data))
    console.log('[perf] evidence:', out)
    expect(data.pages).toBeGreaterThan(0)
  })
})
