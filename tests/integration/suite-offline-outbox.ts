import { TestHarness, deviceIdFor } from './runner'
import { createSyncEngine } from '../../apps/client/frontend/src/features/sync/engine'
import { createMemoryStorage } from '../../apps/client/frontend/src/features/sync/storage'
import { Outbox } from '../../apps/client/frontend/src/features/sync/outbox'
import { createSyncRuntime } from '../../apps/client/frontend/src/features/sync/runtime'
import { uuidv7 } from '../../apps/client/frontend/src/features/sync/uuid'
import type { UploadedBooks } from './suite-books-upload'

export async function runOfflineOutboxSuite(
  harness: TestHarness,
  books: UploadedBooks,
  runId: string,
  userEmail: string,
  password: string,
): Promise<void> {
  const SUITE = 'Offline-Outbox'
  console.log(`\n=== [Suite 6] 离线出站队列、进程重启持久化与重连批量清空验证 ===`)

  const bookId = books.frankenstein.book.id
  const contentHash = 'sha256:' + books.frankenstein.hash

  let networkOnline = false
  const storage = createMemoryStorage()
  const deviceId = deviceIdFor('offline-dev', runId)

  // 1. 初始化一个处于离线状态的客户端
  const runtime = createSyncRuntime({
    baseUrl: harness.baseUrl,
    storage,
    deviceId,
    deviceName: 'Offline-Device-Tester',
  })
  await runtime.session.login({ email: userEmail, password, deviceName: 'Offline-Device-Tester' })

  const engine = createSyncEngine(
    { baseUrl: harness.baseUrl, deviceId, baseBackoffMs: 1000, maxBackoffMs: 30000 },
    { client: runtime.client, storage, isOnline: () => networkOnline },
  )

  // 2. 离线入队多项变更
  engine.enqueueProgress({
    bookId,
    locator: { href: 'OEBPS/chapter-01.xhtml', type: 'application/xhtml+xml', locations: { progression: 0.05, totalProgression: 0.05 } } as never,
    totalProgression: 0.05,
    contentHash,
  })
  engine.enqueueProgress({
    bookId,
    locator: { href: 'OEBPS/chapter-02.xhtml', type: 'application/xhtml+xml', locations: { progression: 0.12, totalProgression: 0.12 } } as never,
    totalProgression: 0.12,
    contentHash,
  })
  const offlineAnnId = uuidv7()
  engine.enqueueAnnotation(bookId, offlineAnnId, {
    locator: { href: 'OEBPS/chapter-02.xhtml', type: 'application/xhtml+xml' } as never,
    type: 'highlight',
    color: '#00ff88',
    text: 'Offline highlight',
  })

  harness.check(
    SUITE,
    'OF-01',
    '网络断开时，所有变更全部保存在本地 Outbox 出站队列中',
    engine.outbox.size === 3,
    `Outbox size: ${engine.outbox.size}`,
  )

  // 3. 模拟应用进程退出与重启：Storage 重载 Outbox
  const reloadedBox = Outbox.load(storage)
  harness.check(
    SUITE,
    'OF-02',
    '进程重启持久化验证：从本地存储重新恢复 Outbox 队列条目无损',
    reloadedBox.size === 3 && reloadedBox.list().some((entry) => entry.op.entityId === offlineAnnId),
    `Reloaded items: ${reloadedBox.size}`,
  )

  // 4. 指数退避阶梯断言
  const backoffTiers = [1, 2, 3, 4, 5, 6, 7].map((n) => engine.computeBackoffMs(n))
  harness.check(
    SUITE,
    'OF-03',
    '网络故障重试呈指数退避分布 (1s, 2s, 4s, 8s, 16s, 30s, 30s)',
    JSON.stringify(backoffTiers) === JSON.stringify([1000, 2000, 4000, 8000, 16000, 30000, 30000]),
    `Backoff ladder: ${JSON.stringify(backoffTiers)}`,
  )

  // 5. 恢复网络连接并执行同步
  networkOnline = true
  const drainRes = await harness.runStep(
    SUITE,
    'OF-04',
    '恢复网络连接后触发同步：批量出栈并成功提交至服务端',
    () => engine.run(),
    (res) => ({
      ok: res.pushed === 3 && res.applied === 3 && engine.outbox.size === 0,
      detail: `pushed: ${res.pushed}, applied: ${res.applied}, remaining outbox: ${engine.outbox.size}`,
    }),
  )

  engine.dispose()
}
