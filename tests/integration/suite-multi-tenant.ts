import { TestHarness, deviceIdFor } from './runner'
import { createSyncRuntime } from '../../apps/client/frontend/src/features/sync/runtime'
import { createMemoryStorage } from '../../apps/client/frontend/src/features/sync/storage'
import { createBooksApi, createSyncApi } from '../../apps/client/frontend/src/api/endpoints'
import type { UploadedBooks } from './suite-books-upload'

export async function runMultiTenantSuite(
  harness: TestHarness,
  deviceAlice: ReturnType<typeof createSyncRuntime>,
  books: UploadedBooks,
  runId: string,
  password: string,
): Promise<void> {
  const SUITE = 'Multi-Tenant'
  console.log(`\n=== [Suite 7] 多租户数据强隔离与跨租户越权防范验证 ===`)

  const bobEmail = `tenant-bob-${runId}@example.com`
  const bobDevice = createSyncRuntime({
    baseUrl: harness.baseUrl,
    storage: createMemoryStorage(),
    deviceId: deviceIdFor('bob-dev', runId),
    deviceName: 'Bob-Terminal',
  })

  await bobDevice.session.register({
    email: bobEmail,
    password,
    displayName: 'Bob Tenant',
    deviceName: 'Bob-Terminal',
  })

  const aliceBookId = books.alice.book.id
  const bobBooksApi = createBooksApi(bobDevice.client)
  const bobSyncApi = createSyncApi(bobDevice.client)

  // 1. Bob 查阅自己书库：空书库，看不到 Alice 的任何书籍
  const bobList = await harness.runStep(
    SUITE,
    'MT-01',
    '租户 Bob 访问个人书库：列表为空，看不到租户 Alice 的任何书籍',
    () => bobBooksApi.list(),
    (res) => ({ ok: res.items.length === 0, detail: `Items: ${res.items.length}` }),
  )

  // 2. Bob 越权读取 Alice 书目详情：返回 404
  const crossBookErr = await harness.expectApiError(
    'Bob 越权读取 Alice 书籍',
    () => bobBooksApi.get(aliceBookId),
    404,
  )
  harness.check(
    SUITE,
    'MT-02',
    '跨租户读取书籍元数据被拒绝并隐蔽返回 404 not_found',
    crossBookErr.ok,
    crossBookErr.detail,
  )

  // 3. Bob 越权下载 Alice 书籍文件：返回 404
  const bobToken = bobDevice.session.accessToken ?? ''
  const crossFileResp = await fetch(`${harness.baseUrl}/v1/books/${aliceBookId}/file`, {
    headers: { Authorization: `Bearer ${bobToken}` },
  })
  harness.check(
    SUITE,
    'MT-03',
    '跨租户直接下载书籍文件被拒绝并返回 404 not_found',
    crossFileResp.status === 404,
    `Actual HTTP Status: ${crossFileResp.status}`,
  )

  // 4. Bob 获取同步快照：全为空
  const bobSnapshot = await harness.runStep(
    SUITE,
    'MT-04',
    '租户 Bob 拉取同步快照：无书籍、无进度、无批注',
    () => bobSyncApi.snapshot(),
    (res) => ({
      ok: res.books.length === 0 && res.progress.length === 0 && res.annotations.length === 0,
      detail: `books=${res.books.length}, progress=${res.progress.length}, ann=${res.annotations.length}`,
    }),
  )

  // 5. Bob 从 cursor=0 拉取变更日志：变更集为空，完全无法监听 Alice 的操作流
  const bobPull = await harness.runStep(
    SUITE,
    'MT-05',
    '租户 Bob 从游标 0 全局拉取：结果为空，无法监听租户 Alice 的 change_log 序列',
    () => bobSyncApi.pull(0, 500),
    (res) => ({ ok: res.changes.length === 0, detail: `Changes: ${res.changes.length}` }),
  )

  // 6. Bob 恶意向 Alice 的 bookId 提交进度：不能污染 Alice 的状态
  const aliceSnapBefore = await createSyncApi(deviceAlice.client).snapshot()
  const aliceProgBefore = aliceSnapBefore.progress.find((p) => p.bookId === aliceBookId)?.totalProgression

  bobDevice.engine.enqueueProgress({
    bookId: aliceBookId,
    locator: { href: 'c1.xhtml', type: 'application/xhtml+xml', locations: { progression: 0.01, totalProgression: 0.01 } } as never,
    totalProgression: 0.01,
  })
  await bobDevice.engine.run()

  const aliceSnapAfter = await createSyncApi(deviceAlice.client).snapshot()
  const aliceProgAfter = aliceSnapAfter.progress.find((p) => p.bookId === aliceBookId)?.totalProgression

  harness.check(
    SUITE,
    'MT-06',
    '租户 Bob 写入相同 bookId 的进度仅进入 Bob 自己的租户分区，Alice 进度绝对隔离不被篡改',
    aliceProgBefore !== undefined && aliceProgAfter !== undefined && Math.abs(aliceProgAfter - aliceProgBefore) < 1e-9,
    `Alice progression before: ${aliceProgBefore}, after: ${aliceProgAfter}`,
  )
}
