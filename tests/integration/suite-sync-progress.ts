import { TestHarness, deviceIdFor } from './runner'
import { createSyncRuntime } from '../../apps/client/frontend/src/features/sync/runtime'
import { createMemoryStorage } from '../../apps/client/frontend/src/features/sync/storage'
import { createSyncEngine } from '../../apps/client/frontend/src/features/sync/engine'
import { createSyncApi } from '../../apps/client/frontend/src/api/endpoints'
import type { UploadedBooks } from './suite-books-upload'

function locator(chapter: string, progression: number) {
  return {
    href: `OEBPS/${chapter}.xhtml`,
    type: 'application/xhtml+xml',
    title: chapter,
    locations: { progression, totalProgression: progression },
  }
}

export async function runSyncProgressSuite(
  harness: TestHarness,
  deviceA: ReturnType<typeof createSyncRuntime>,
  deviceB: ReturnType<typeof createSyncRuntime>,
  books: UploadedBooks,
  runId: string,
  userEmail: string,
  password: string,
): Promise<void> {
  const SUITE = 'Sync-Progress'
  console.log(`\n=== [Suite 4] 多设备阅读进度同步、因果时钟、回退语义与最远进度保持验证 ===`)

  const bookId = books.alice.book.id
  const contentHash = 'sha256:' + books.alice.hash
  const otherHash = 'sha256:' + 'dd'.repeat(32)

  const engineA = deviceA.engine
  const engineB = deviceB.engine
  const syncApiA = createSyncApi(deviceA.client)

  // 1. 设备 A 推进度到 0.25 (第 3 章)
  engineA.enqueueProgress({
    bookId,
    locator: locator('chapter-03', 0.25),
    totalProgression: 0.25,
    contentHash,
  })
  const runA1 = await harness.runStep(
    SUITE,
    'SP-01',
    '设备 A 推送阅读进度 (0.25)：服务端接纳并分配单调游标',
    () => engineA.run(),
    (res) => ({
      ok: res.pushed === 1 && res.applied === 1 && res.cursor > 0,
      detail: `pushed: ${res.pushed}, cursor: ${res.cursor}`,
    }),
  )

  // 2. 设备 B 首次同步（快照 bootstrap 路径）
  const appliedB = await harness.runStep(
    SUITE,
    'SP-02',
    '设备 B 执行快照同步 (snapshot)：精准拿到设备 A 的最新进度 0.25',
    () => engineB.bootstrap(),
    () => {
      const prog = engineB.local.progress[bookId]
      return {
        ok: prog !== undefined && Math.abs(prog.totalProgression - 0.25) < 1e-9,
        detail: `Local prog: ${prog?.totalProgression}, cursor: ${engineB.local.cursor}`,
      }
    },
  )

  // 3. 设备 A 继续前进到 0.50 (第 6 章)
  engineA.enqueueProgress({
    bookId,
    locator: locator('chapter-06', 0.5),
    totalProgression: 0.5,
    contentHash,
  })
  await engineA.run()

  // 4. 设备 B 执行增量 pull (cursor 增量拉取路径)
  const cursorBeforeB = engineB.local.cursor
  const pullB = await harness.runStep(
    SUITE,
    'SP-03',
    '设备 B 增量 pull：基于 cursor 断点续传捕获 0.50 前进',
    () => engineB.pullOnce(),
    (res) => {
      const prog = engineB.local.progress[bookId]
      return {
        ok: res.changes >= 1 && prog !== undefined && Math.abs(prog.totalProgression - 0.5) < 1e-9,
        detail: `Changes: ${res.changes}, cursor: ${cursorBeforeB} -> ${res.cursor}`,
      }
    },
  )

  // 5. 冲突 1：慢时钟设备/陈旧 HLC 写入测试
  const engineAOld = createSyncEngine(
    { baseUrl: harness.baseUrl, deviceId: engineA.deviceId },
    { client: deviceA.client, storage: createMemoryStorage(), now: () => Date.now() - 3600_000 },
  )
  engineAOld.enqueueProgress({
    bookId,
    locator: locator('chapter-01', 0.1),
    totalProgression: 0.1,
    contentHash,
  })
  const oldPush = await harness.runStep(
    SUITE,
    'SP-04',
    '陈旧 HLC 进度写入：服务端判定 older_hlc，忽略变更且不推进游标',
    () => engineAOld.pushOnce(),
    (res) => ({
      ok: res.reasons.includes('older_hlc'),
      detail: `reasons: ${JSON.stringify(res.reasons)}, cursor: ${res.pushCursor}`,
    }),
  )
  engineAOld.dispose()

  // 6. 跨副本前进：进度推升至 0.85
  engineA.enqueueProgress({
    bookId,
    locator: locator('chapter-11', 0.85),
    totalProgression: 0.85,
    contentHash: otherHash,
  })
  await engineA.run()

  const snapAfterFwd = await syncApiA.snapshot()
  const progFwd = snapAfterFwd.progress.find((p) => p.bookId === bookId)
  harness.check(
    SUITE,
    'SP-05',
    '跨副本前移至 0.85：当前位置与最远进度同步推升至 0.85',
    progFwd !== undefined &&
      Math.abs(progFwd.totalProgression - 0.85) < 1e-9 &&
      Math.abs(progFwd.furthestProgression - 0.85) < 1e-9,
    `Progression: ${progFwd?.totalProgression}, Furthest: ${progFwd?.furthestProgression}`,
  )

  // 7. 隐式回退拦截：未经声明回退至 0.30 必须被拒 (stale_no_rewind)
  engineA.enqueueProgress({
    bookId,
    locator: locator('chapter-04', 0.3),
    totalProgression: 0.3,
    contentHash,
  })
  const stalePush = await harness.runStep(
    SUITE,
    'SP-06',
    '未声明 explicitRewind 的倒退被服务端拒收 (stale_no_rewind)',
    () => engineA.pushOnce(),
    (res) => ({
      ok: res.reasons.includes('stale_no_rewind'),
      detail: `Reasons: ${JSON.stringify(res.reasons)}`,
    }),
  )

  // 8. 显式回滚 (explicitRewind: true)：用户手动翻回第 2 章 0.15
  const rewindOp = engineA.enqueueProgress({
    bookId,
    locator: locator('chapter-02', 0.15),
    totalProgression: 0.15,
    contentHash,
    explicitRewind: true,
  })
  await engineA.run()

  const snapAfterRewind = await syncApiA.snapshot()
  const progRewind = snapAfterRewind.progress.find((p) => p.bookId === bookId)
  harness.check(
    SUITE,
    'SP-07',
    '显式回滚生效：当前位置退回 0.15，但最远进度基线牢固保持 0.85（只增不减）',
    progRewind !== undefined &&
      Math.abs(progRewind.totalProgression - 0.15) < 1e-9 &&
      Math.abs(progRewind.furthestProgression - 0.85) < 1e-9 &&
      progRewind.explicitRewind === true,
    `Current: ${progRewind?.totalProgression}, Furthest: ${progRewind?.furthestProgression}`,
  )

  // 9. 幂等性：同 opId 重放不重复推进游标
  const cursorBeforeReplay = engineA.local.cursor
  const replayRes = await harness.runStep(
    SUITE,
    'SP-08',
    '重复提交相同 opId 操作：服务端返回 applied + reason: duplicate，游标不递增',
    () => syncApiA.push({ deviceId: engineA.deviceId, ops: [rewindOp] }),
    (res) => {
      const item = res.results[0]
      return {
        ok: item?.status === 'applied' && item?.reason === 'duplicate' && res.cursor === cursorBeforeReplay,
        detail: `status: ${item?.status}, reason: ${item?.reason}, cursor: ${res.cursor}`,
      }
    },
  )

  // 10. 设备 C（Web 端）全新接入验证全网最终一致性
  const deviceC = createSyncRuntime({
    baseUrl: harness.baseUrl,
    storage: createMemoryStorage(),
    deviceId: deviceIdFor('dev-C', runId),
    deviceName: 'Web-Client-C',
    platform: 'web',
  })
  await deviceC.session.login({ email: userEmail, password, deviceName: 'Web-Client-C' })
  await deviceC.engine.bootstrap()
  const progC = deviceC.engine.local.progress[bookId]

  harness.check(
    SUITE,
    'SP-09',
    '新设备 C (Web) 登录并完成快照聚合：精准收敛到当前 0.15 / 最远 0.85',
    progC !== undefined &&
      Math.abs(progC.totalProgression - 0.15) < 1e-9 &&
      Math.abs(progC.furthestProgression - 0.85) < 1e-9,
    `Device C sees current: ${progC?.totalProgression}, furthest: ${progC?.furthestProgression}`,
  )
}
