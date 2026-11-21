import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * ★ 单章大书初排 CPU profile 诊断。
 *
 * breakdown 测量已定位：initMs ~505ms 是最大一块，但被 instrument 的同步操作
 * （sanitize / parse / ro / gcs）加起来才 ~216ms，longtasks 却有 ~1158ms。
 * 说明长任务发生在未被 JS instrument 覆盖的代码里。
 *
 * 本台用 CDP CPU Profiler 采样主线程，按函数名聚合 self time，输出热点 Top N，
 * 精确定位长任务的代码位置（是浏览器内部解析/布局，还是应用层某段同步代码）。
 *
 * 只在 `HPF_PERF=1` 时跑。书路径由 `HPF_BOOK` 指定。
 */

const REPO_ROOT = path.resolve(process.cwd(), '../../..')
const REAL_BOOK = process.env['HPF_BOOK']
  ? path.resolve(REPO_ROOT, process.env['HPF_BOOK'])
  : path.join(REPO_ROOT, 'testdata', 'books', 'single-chapter-large.epub')
const EVIDENCE_DIR = path.resolve(process.cwd(), '../evidence')
const ENABLED = process.env['HPF_PERF'] === '1'

test.describe('单章大书初排 CPU profile', () => {
  test.skip(!ENABLED, '只在 HPF_PERF=1 时测量')
  test.skip(!existsSync(REAL_BOOK), `缺少测试书 ${REAL_BOOK}`)

  test('采样初排主线程，输出热点函数 Top 25', async ({ page }) => {
    test.setTimeout(180_000)

    const client = await page.context().newCDPSession(page)
    await client.send('Profiler.enable')
    await client.send('Profiler.setSamplingInterval', { interval: 100 })
    await client.send('Profiler.start')

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

    const { profile } = await client.send('Profiler.stop')
    await client.detach()

    // 按函数名聚合 self time。
    const nodeMap = new Map<number, { name: string; url: string; line: number }>()
    for (const node of profile.nodes) {
      nodeMap.set(node.id, {
        name: node.callFrame.functionName || '(anonymous)',
        url: node.callFrame.url || '',
        line: node.callFrame.lineNumber,
      })
    }
    const selfByName = new Map<string, { selfMs: number; count: number; url: string; line: number }>()
    const samples = profile.samples ?? []
    const deltas = profile.timeDeltas ?? []
    for (let i = 0; i < samples.length; i += 1) {
      const node = nodeMap.get(samples[i])
      const dt = deltas[i] ?? 0
      if (!node) continue
      const key = `${node.name}`
      const entry = selfByName.get(key) ?? { selfMs: 0, count: 0, url: node.url, line: node.line }
      entry.selfMs += dt
      entry.count += 1
      selfByName.set(key, entry)
    }
    const hot = [...selfByName.entries()]
      .map(([name, v]) => ({ name, ...v, selfMs: Number(v.selfMs.toFixed(2)) }))
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 25)

    const totalSampleMs = deltas.reduce((a, b) => a + b, 0)
    const report = {
      note: '单章大书初排 CPU profile：按函数名聚合 self time，定位长任务代码位置',
      openMs,
      totalSampleMs: Number(totalSampleMs.toFixed(2)),
      sampleCount: samples.length,
      hot,
    }

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const out = path.join(EVIDENCE_DIR, `optimization-profile-${process.env['HPF_PERF_TAG'] ?? 'run'}.json`)
    writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')

    console.log('[perf] profile hot:', JSON.stringify(hot.slice(0, 10), null, 2))
    console.log('[perf] evidence:', out)
    expect(hot.length).toBeGreaterThan(0)
  })
})
