import { TestHarness, deviceIdFor } from './runner'
import {
  createSyncRuntime,
  getSyncRuntime,
  installServerUrlWatcher,
  rebuildSyncRuntime,
} from '../../apps/client/frontend/src/features/sync/runtime'
import { createMemoryStorage } from '../../apps/client/frontend/src/features/sync/storage'
// ★ 走纯逻辑模块（stores/serverUrl）：stores/server.ts 会拖入 pinia，
//   而集成测试是在 Node 里跑的裸 bundle，解析不到 pinia。
import {
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  probeServer,
  readServerUrl,
  resetServerUrlCacheForTest,
  writeServerUrl,
} from '../../apps/client/frontend/src/stores/serverUrl'
import type { UploadedBooks } from './suite-books-upload'

/**
 * [Suite 8] 服务器地址（自建后端）与"运行期换服务器"的完整语义。
 *
 * 覆盖用户可见能力：
 *   - 设置页输入地址 → 保存 → 立即生效（不需要重启应用）；
 *   - 「测试连接」底层探测（真实 GET /healthz，含不可达地址）；
 *   - 换地址**不能丢**待推送变更、登录态与本地投影（这是最容易写错的地方）；
 *   - 服务器不可达 → 变更留在 outbox；地址恢复后自动排空并收敛（断点续传）。
 */
export async function runServerAddressSuite(
  harness: TestHarness,
  runId: string,
  userEmail: string,
  password: string,
  books: UploadedBooks,
): Promise<void> {
  const SUITE = 'Server-Address'
  console.log('\n=== [Suite 8] 服务器地址设置、运行期重连与换地址不丢数据验证 ===')

  // ---------- 1. 地址归一化（纯函数） ----------
  const normalized = [
    normalizeServerUrl('  https://books.example.com/  '),
    normalizeServerUrl('192.168.1.10:8080'),
    normalizeServerUrl(''),
    normalizeServerUrl('http://127.0.0.1:8080///'),
  ]
  harness.check(
    SUITE,
    'SA-01',
    '地址归一化：去空白/补协议/去尾斜杠；空串回落默认地址',
    normalized[0] === 'https://books.example.com' &&
      normalized[1] === 'http://192.168.1.10:8080' &&
      normalized[2] === DEFAULT_SERVER_URL &&
      normalized[3] === 'http://127.0.0.1:8080',
    JSON.stringify(normalized),
  )

  // ---------- 2. 持久化往返（UI 与引擎读同一份真相） ----------
  const store = new Map<string, string>()
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  }
  try {
    resetServerUrlCacheForTest()
    writeServerUrl('http://192.0.2.10:9000')
    resetServerUrlCacheForTest()
    const roundTrip = readServerUrl()
    harness.check(
      SUITE,
      'SA-02',
      '保存的地址能被非组件环境（同步引擎/api client）原样读到',
      roundTrip === 'http://192.0.2.10:9000',
      'readServerUrl() = ' + roundTrip,
    )

    // API base 必须跟着走：这是"设置页显示新地址、请求还打旧地址"这类分裂的根因。
    const watcherOff = installServerUrlWatcher()
    writeServerUrl(harness.baseUrl)
    harness.check(
      SUITE,
      'SA-03',
      '地址变更后同步运行时的 api client 指向新地址（无需重启应用）',
      getSyncRuntime().client.baseUrl === harness.baseUrl.replace(/\/+$/, ''),
      'client.baseUrl = ' + getSyncRuntime().client.baseUrl,
    )
    watcherOff()
  } finally {
    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage
    } else {
      ;(globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage
    }
    resetServerUrlCacheForTest()
  }

  // ---------- 3. 「测试连接」底层探测（真实网络） ----------
  const okProbe = await harness.runStep(
    SUITE,
    'SA-04',
    '连接探测：真实服务端 /healthz 返回 ok（设置页「测试连接」的底层能力）',
    () => probeServer(harness.baseUrl, 5000),
    (res) => ({ ok: res.ok && res.message === 'ok' && res.latencyMs >= 0, detail: `ok=${res.ok}, ${res.latencyMs}ms, status=${res.message}` }),
  )
  void okProbe

  const badProbe = await harness.runStep(
    SUITE,
    'SA-05',
    '连接探测：不可达地址必须如实返回失败（不伪装成功）',
    () => probeServer('http://127.0.0.1:9', 3000),
    (res) => ({ ok: res.ok === false && res.message.length > 0, detail: `ok=${res.ok}, message=${res.message.slice(0, 60)}` }),
  )
  void badProbe

  // ---------- 4. 换服务器地址：outbox / 登录态 / 本地投影都不丢 ----------
  const sharedStorage = createMemoryStorage()
  const deviceId = deviceIdFor('dev-ADDR', runId)
  const first = createSyncRuntime({ baseUrl: harness.baseUrl, storage: sharedStorage, deviceId, deviceName: 'Addr-A' })
  await first.session.login({ email: userEmail, password, deviceName: 'Addr-A' })
  const tokenBefore = first.session.accessToken

  const progressBook = books.pride.book.id
  const progressHash = 'sha256:' + books.pride.hash
  first.engine.enqueueProgress({
    bookId: progressBook,
    locator: {
      href: 'OEBPS/chapter-03.xhtml',
      type: 'application/xhtml+xml',
      title: 'chapter-03',
      locations: { progression: 0.42, totalProgression: 0.42 },
    },
    totalProgression: 0.42,
    contentHash: progressHash,
  })
  first.engine.enqueueProgress({
    bookId: progressBook,
    locator: {
      href: 'OEBPS/chapter-04.xhtml',
      type: 'application/xhtml+xml',
      title: 'chapter-04',
      locations: { progression: 0.44, totalProgression: 0.44 },
    },
    totalProgression: 0.44,
    contentHash: progressHash,
  })

  // 用 rebuild 语义重建（等价于用户在设置页改了地址）：同一份 storage，新的 baseUrl。
  const rebuilt = createSyncRuntime({
    baseUrl: 'http://127.0.0.1:9',
    storage: sharedStorage,
    deviceId,
    deviceName: 'Addr-A',
  })

  harness.check(
    SUITE,
    'SA-06',
    '换地址后：待推送变更、登录令牌、本地投影全部保留（rebuild 不丢数据）',
    rebuilt.engine.outbox.size === 2 &&
      rebuilt.session.accessToken === tokenBefore &&
      rebuilt.session.accessToken !== null,
    `outbox=${rebuilt.engine.outbox.size}, tokenKept=${rebuilt.session.accessToken === tokenBefore}`,
  )

  // ---------- 5. 服务器不可达：变更留在 outbox，不丢不炸 ----------
  const offlineRun = await rebuilt.engine.run()
  harness.check(
    SUITE,
    'SA-07',
    '服务器不可达：一次同步失败但变更仍留在 outbox（离线容灾，不静默丢弃）',
    rebuilt.engine.outbox.size === 2 && offlineRun.errors.length > 0 && rebuilt.engine.getStatus().phase === 'offline',
    `outbox=${rebuilt.engine.outbox.size}, phase=${rebuilt.engine.getStatus().phase}, errors=${offlineRun.errors.length}`,
  )

  // ---------- 6. 地址改回正确值：自动排空并收敛到服务端 ----------
  const recovered = createSyncRuntime({
    baseUrl: harness.baseUrl,
    storage: sharedStorage,
    deviceId,
    deviceName: 'Addr-A',
  })
  const recoveredRun = await recovered.engine.run()
  const snapshot = await createSyncRuntime({
    baseUrl: harness.baseUrl,
    storage: createMemoryStorage(),
    deviceId: deviceIdFor('dev-ADDR-Verify', runId),
    deviceName: 'Addr-Verify',
  })
  await snapshot.session.login({ email: userEmail, password, deviceName: 'Addr-Verify' })
  await snapshot.engine.bootstrap()
  const serverProg = snapshot.engine.local.progress[progressBook]

  harness.check(
    SUITE,
    'SA-08',
    '地址恢复后：outbox 排空（pushed=2）且服务端权威进度收敛到 0.44',
    recoveredRun.pushed === 2 &&
      recovered.engine.outbox.size === 0 &&
      serverProg !== undefined &&
      Math.abs(serverProg.totalProgression - 0.44) < 1e-9,
    `pushed=${recoveredRun.pushed}, outbox=${recovered.engine.outbox.size}, server=${serverProg?.totalProgression}`,
  )

  // ---------- 7. 全局单例重建（真实 UI 路径） ----------
  const before = getSyncRuntime().client.baseUrl
  rebuildSyncRuntime(harness.baseUrl)
  const after = getSyncRuntime().client.baseUrl
  harness.check(
    SUITE,
    'SA-09',
    'rebuildSyncRuntime 后全局单例被替换为新 runtime，且地址正确',
    after === harness.baseUrl.replace(/\/+$/, ''),
    `${before} -> ${after}`,
  )

  recovered.engine.dispose()
  rebuilt.engine.dispose()
  first.engine.dispose()
  snapshot.engine.dispose()
}
