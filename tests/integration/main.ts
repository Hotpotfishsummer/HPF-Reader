import { join } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { TestHarness, generateRunId } from './runner'
import { runDockerBackendSuite } from './suite-backend'
import { runAuthSuite } from './suite-auth'
import { runBooksUploadSuite } from './suite-books-upload'
import { runSyncProgressSuite } from './suite-sync-progress'
import { runSyncAnnotationsSuite } from './suite-sync-annotations'
import { runOfflineOutboxSuite } from './suite-offline-outbox'
import { runMultiTenantSuite } from './suite-multi-tenant'
import { runServerAddressSuite } from './suite-server-address'
import { runBookFileSyncSuite } from './suite-book-file-sync'

async function main() {
  const apiBase = process.env['HPF_API_BASE'] ?? 'http://127.0.0.1:8080'
  const caddyBase = process.env['HPF_CADDY_BASE'] ?? 'https://localhost'
  const rootDir = process.env['HPF_ROOT'] ?? process.cwd()
  const booksDir = process.env['HPF_BOOKS_DIR'] ?? join(rootDir, 'testdata', 'books')
  const outDir = process.env['HPF_REPORT_DIR'] ?? join(rootDir, 'tests', 'integration', 'evidence')

  await mkdir(outDir, { recursive: true })

  console.log('======================================================================')
  console.log('          HPF-Reader Server <-> Client 全面集成测试套件              ')
  console.log('======================================================================')
  console.log(`API Base URL   : ${apiBase}`)
  console.log(`Caddy Base URL : ${caddyBase}`)
  console.log(`Books Dir      : ${booksDir}`)
  console.log(`Output Dir     : ${outDir}`)

  const harness = new TestHarness(apiBase)
  const runId = generateRunId()
  const password = 'IntegrationSecurePass2026!'

  try {
    // Suite 1: Docker Backend & Caddy
    await runDockerBackendSuite(harness, caddyBase)

    // Suite 2: Auth & Multi-Device
    const { userEmail, deviceA, deviceB } = await runAuthSuite(harness, runId, password)

    // Suite 3: Real Books Upload & Deduplication & Range
    const books = await runBooksUploadSuite(harness, deviceA, booksDir)

    // Suite 4: Sync Progress & HLC & Rewind & Monotonicity
    await runSyncProgressSuite(harness, deviceA, deviceB, books, runId, userEmail, password)

    // Suite 5: Sync Annotations & Tombstones & Remove-Wins
    await runSyncAnnotationsSuite(harness, deviceA, deviceB, books)

    // Suite 6: Offline Outbox & Crash Recovery & Backoff
    await runOfflineOutboxSuite(harness, books, runId, userEmail, password)

    // Suite 7: Multi-Tenant Strict Isolation
    await runMultiTenantSuite(harness, deviceA, books, runId, password)

    // Suite 8: Server address (self-hosted backend) + runtime reconnect semantics
    await runServerAddressSuite(harness, runId, userEmail, password, books)

    // Suite 9: Cloud book file sync (download + hash verify + cross-device identity)
    await runBookFileSyncSuite(harness, runId, userEmail, password, books)
  } catch (err) {
    console.error('\n[FATAL] 测试运行遇到未捕获异常: ', err)
  }

  const summary = harness.summary()
  console.log('\n======================================================================')
  console.log(` 测试完成! 总计: ${summary.total} 项 | 通过: ${summary.passed} 项 | 失败: ${summary.failed} 项`)
  console.log(` 耗时: ${(summary.totalDurationMs / 1000).toFixed(2)} 秒`)
  console.log('======================================================================')

  // 落盘测试证据 JSON
  const reportPath = join(outDir, 'integration-results.json')
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        runId,
        executedAt: new Date().toISOString(),
        summary,
        checks: harness.checks,
      },
      null,
      2,
    ),
    'utf-8',
  )
  console.log(`详细证据报告已落盘至: ${reportPath}`)

  // ★ 必须**显式**退出：同步引擎在失败路径上会挂 setTimeout 重试定时器
  //   （离线容灾用例 SA-07 就会触发），这些定时器会让 Node 事件循环一直活着，
  //   表现为"报告已经打印完但进程不退出" —— 上层 run-all.mjs 会一直等下去。
  //   这是测试脚手架自身的清理问题，不是被测代码的问题，所以在这里收敛。
  process.exit(summary.failed > 0 ? 1 : 0)
}

await main()
