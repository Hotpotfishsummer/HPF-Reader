/**
 * HPF-Reader 同步端到端联调（task-13 核心交付）。
 *
 * 这个脚本**不是** mock 测试：它驱动真实的客户端 api 层 + 同步引擎，
 * 打到本地真实服务端（Go + Postgres），并把每一次 HTTP 往返的原始请求/响应落盘。
 *
 * 运行方式见 spikes/sync/run-e2e.mjs（vite 打包 → node 执行）。
 * 证据目录：spikes/sync/evidence/
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ApiError, createApiClient } from '../../apps/client/frontend/src/api/client'
import type { HttpExchange } from '../../apps/client/frontend/src/api/client'
import { createAnnotationsApi, createAuthApi, createBooksApi, createSyncApi } from '../../apps/client/frontend/src/api/endpoints'
import type { SyncOp } from '../../apps/client/frontend/src/api/contract'
import { createSyncEngine } from '../../apps/client/frontend/src/features/sync/engine'
import { HybridLogicalClock, HLC_LENGTH, compareHlc, isValidHlc } from '../../apps/client/frontend/src/features/sync/hlc'
import { Outbox } from '../../apps/client/frontend/src/features/sync/outbox'
import { createSyncRuntime } from '../../apps/client/frontend/src/features/sync/runtime'
import { createMemoryStorage } from '../../apps/client/frontend/src/features/sync/storage'
import { uuidv7 } from '../../apps/client/frontend/src/features/sync/uuid'
import { applyPull } from '../../apps/client/frontend/src/features/sync/apply'
import { emptyLocalState } from '../../apps/client/frontend/src/features/sync/types'

const BASE = process.env['HPF_SPIKE_BASE'] ?? 'http://127.0.0.1:18080'
const ROOT = process.env['HPF_SPIKE_ROOT'] ?? process.cwd()
const OUT = process.env['HPF_SPIKE_OUT'] ?? join(ROOT, 'spikes', 'sync', 'evidence')
const BOOK = process.env['HPF_SPIKE_BOOK'] ?? join(ROOT, 'testdata', 'books', 'frankenstein.epub')
const RUN = Date.now().toString(36)
const PASSWORD = String.fromCharCode(83, 112, 107, 45, 80, 97, 115, 115, 119, 48, 114, 100, 45, 50, 48, 50, 54, 33)

interface CheckResult {
  id: string
  name: string
  ok: boolean
  detail: string
}

const checks: CheckResult[] = []
function check(id: string, name: string, ok: boolean, detail = ''): boolean {
  checks.push({ id, name, ok, detail })
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + name + (detail ? '  :: ' + detail : ''))
  return ok
}

/** 原始 HTTP 证据：每条往返一条记录（含失败），最后写 JSONL。 */
const exchanges: Array<HttpExchange & { device: string; at: string }> = []
function capture(device: string) {
  return (exchange: HttpExchange): void => {
    exchanges.push({ device, at: new Date().toISOString(), ...exchange })
  }
}

/**
 * 每次运行唯一的设备 ID。
 * 注意：服务端 register 在「deviceId 已属于别的用户」时返回 404 not_found（见 RESULTS.md 缺陷 F-01），
 * 所以联调脚本不能在多次运行间复用同一个设备 ID。
 */
function deviceIdFor(tag: string): string {
  const hex = createHash('sha256').update(tag + '|' + RUN).digest('hex').slice(0, 12)
  return 'a1a1a1a1-0000-7000-8000-' + hex
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

async function sha256Hex(path: string): Promise<{ hex: string; bytes: Uint8Array; size: number }> {
  const bytes = new Uint8Array(await readFile(path))
  const hex = createHash('sha256').update(bytes).digest('hex')
  return { hex, bytes, size: bytes.byteLength }
}

async function expectApiError(
  label: string,
  fn: () => Promise<unknown>,
  status: number,
): Promise<{ ok: boolean; detail: string }> {
  try {
    await fn()
    return { ok: false, detail: label + ': 期望 HTTP ' + status + ' 但请求成功了' }
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: err.status === status, detail: label + ': 实际 ' + err.status + ' ' + err.code + ' ' + err.message }
    }
    return { ok: false, detail: label + ': 非 ApiError ' + String(err) }
  }
}

// ---------------------------------------------------------------- 0. 纯客户端检查（不依赖网络）

function clientSideChecks(): void {
  const clock = new HybridLogicalClock('11111111-2222-7333-8444-555555555555', () => 1700000000000)
  const a = clock.send()
  const b = clock.send()
  check('C-01', 'HLC 定长 31 且格式合法', a.length === HLC_LENGTH && isValidHlc(a) && isValidHlc(b), a + ' / ' + b)
  check('C-02', '同一毫秒内计数器递增（字典序 == 时间序）', compareHlc(a, b) < 0, a + ' < ' + b)

  const remote = '0192a3f4c1b0a-0000000a-7f3c9d21'
  const observed = clock.observe(remote)
  check('C-03', 'observe 远程 HLC 后本地时钟严格更大', compareHlc(observed, remote) > 0, observed + ' > ' + remote)
  const beforeInvalid = clock.last
  const ignoredInvalid = clock.observe('0192a3f4c1b0-0000000a-7f3c9d21')
  check('C-11', '非法 HLC（12 位时间戳）被拒绝且不影响本地时钟', ignoredInvalid === beforeInvalid && !isValidHlc('0192a3f4c1b0-0000000a-7f3c9d21'), ignoredInvalid)
  const generated = [uuidv7(), uuidv7(), uuidv7()]
  check(
    'C-12',
    'uuidv7 合法且严格递增（8-4-4-4-12，版本位 7）',
    generated.every((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)) &&
      generated[0]! < generated[1]! &&
      generated[1]! < generated[2]!,
    generated.join(' '),
  )
  check('C-04', '设备前缀规整为 8 位小写字母数字', clock.devicePrefix.length === 8, clock.devicePrefix)

  const engine = createSyncEngine(
    { baseUrl: BASE, deviceId: 'aaaaaaaa-1111-7222-8333-444444444444', baseBackoffMs: 1000, maxBackoffMs: 30000 },
    { client: createApiClient({ baseUrl: BASE }), storage: createMemoryStorage(), isOnline: () => false },
  )
  const backoff = [1, 2, 3, 4, 5, 6, 7].map((n) => engine.computeBackoffMs(n))
  check(
    'C-05',
    '指数退避 1s→2s→4s…封顶 30s',
    JSON.stringify(backoff) === JSON.stringify([1000, 2000, 4000, 8000, 16000, 30000, 30000]),
    JSON.stringify(backoff),
  )

  engine.enqueueProgress({ bookId: 'offline-book', locator: { href: 'x', type: 'application/xhtml+xml' }, totalProgression: 0.1 })
  const statusBefore = engine.getStatus()
  check('C-06', '离线时 outbox 保留待发变更', statusBefore.pendingCount === 1 && engine.outbox.size === 1, 'pending=' + statusBefore.pendingCount)
  engine.dispose()

  const storage = createMemoryStorage()
  const box = Outbox.load(storage)
  const op: SyncOp = {
    opId: uuidv7(),
    entity: 'progress',
    entityId: 'persist-book',
    kind: 'upsert',
    hlc: '0192a3f4c1b0-00000001-11111111',
    deviceId: 'dev-1',
    payload: { totalProgression: 0.2 },
  }
  box.enqueue(op)
  const reloaded = Outbox.load(storage)
  check('C-07', 'outbox 进程重启不丢（storage 往返）', reloaded.size === 1 && reloaded.list()[0]?.op.opId === op.opId, 'size=' + reloaded.size)
  reloaded.ack([op.opId])
  check('C-08', 'ack 后出队', Outbox.load(storage).size === 0)

  const state = emptyLocalState()
  const applied = applyPull(
    state,
    [
      {
        cursor: 10,
        entity: 'progress',
        entityId: 'bk',
        kind: 'upsert',
        hlc: '0192a3f4c1b0-00000001-11111111',
        deviceId: 'dev',
        payload: { locator: { href: 'a', type: 't' }, totalProgression: 0.6, furthestProgression: 0.6, contentHash: 'sha256:x' },
      },
      {
        cursor: 11,
        entity: 'progress',
        entityId: 'bk',
        kind: 'upsert',
        hlc: '0192a3f4c1b0-00000002-11111111',
        deviceId: 'dev',
        payload: { locator: { href: 'b', type: 't' }, totalProgression: 0.2, furthestProgression: 0.2, contentHash: 'sha256:x' },
      },
    ] as never,
    11,
  )
  const local = state.progress['bk']
  check(
    'C-09',
    'apply 后最远进度只增不减（本地投影不倒退）',
    applied === 2 && local !== undefined && local.totalProgression === 0.2 && local.furthestProgression === 0.6,
    JSON.stringify({ total: local?.totalProgression, furthest: local?.furthestProgression }),
  )
  check('C-10', '游标由服务端 nextCursor 推进', state.cursor === 11, 'cursor=' + state.cursor)
}

// ---------------------------------------------------------------- 1. 认证 / 书籍 / 文件上传

async function authAndBooks(): Promise<{ deviceA: ReturnType<typeof createSyncRuntime>; bookId: string; contentHash: string; bookBytes: Uint8Array }> {
  const deviceA = createSyncRuntime({
    baseUrl: BASE,
    storage: createMemoryStorage(),
    deviceId: deviceIdFor('A'),
    deviceName: 'spike-device-A',
    platform: 'windows',
    onExchange: capture('A'),
  })
  const emailA = 'spike-a-' + RUN + '@example.com'
  const tokens = await deviceA.session.register({
    email: emailA,
    password: PASSWORD,
    displayName: 'Spike A',
    deviceName: 'spike-device-A',
    platform: 'windows',
  })
  check('E-01', '注册成功并拿到 access/refresh（含 user.id）', tokens.accessToken.length > 20 && tokens.refreshToken.length > 10 && tokens.user?.id !== undefined, 'expiresIn=' + tokens.expiresIn)

  const me = await deviceA.client.request<{ id: string; email: string }>('/v1/me')
  check('E-02', 'Bearer 认证可用（GET /v1/me）', me.email === emailA, me.email)

  const badClient = createApiClient({ baseUrl: BASE, getAccessToken: () => 'not-a-real-jwt', onExchange: capture('BADAUTH') })
  const unauthorized = await expectApiError('伪造 token', () => badClient.request('/v1/me'), 401)
  check('E-03', '伪造 token 被拒（401）', unauthorized.ok, unauthorized.detail)

  // ---- 刷新轮换 + 重用检测（独立用户，避免影响主流程令牌）
  const deviceR = createSyncRuntime({
    baseUrl: BASE,
    storage: createMemoryStorage(),
    deviceId: deviceIdFor('R'),
    deviceName: 'spike-device-R',
    onExchange: capture('R'),
  })
  const authR = createAuthApi(deviceR.client)
  await deviceR.session.register({
    email: 'spike-r-' + RUN + '@example.com',
    password: PASSWORD,
    deviceName: 'spike-device-R',
  })
  const firstRefresh = deviceR.session.refreshToken ?? ''
  const rotated = await deviceR.session.refresh()
  check('E-04', 'refresh 轮换：返回新的令牌对', rotated.refreshToken !== firstRefresh && rotated.accessToken.length > 20)
  const reuse = await expectApiError('旧 refresh 重用', () => authR.refresh(firstRefresh), 401)
  check('E-05', '旧 refresh 重用被拒（轮换 + 重用检测）', reuse.ok, reuse.detail)
  const afterRevoke = await expectApiError('family 吊销后新 refresh', () => authR.refresh(rotated.refreshToken), 401)
  check('E-06', '重用检测吊销整个 family（新 refresh 也失效）', afterRevoke.ok, afterRevoke.detail)

  // ---- 真实公版书：sha256 + 上传 + 秒传
  const digest = await sha256Hex(BOOK)
  const normalized = 'sha256:' + digest.hex
  const booksApi = createBooksApi(deviceA.client)
  const book = await booksApi.create({
    title: 'Frankenstein; Or, The Modern Prometheus',
    author: 'Mary Wollstonecraft Shelley',
    language: 'en',
    format: 'epub',
    contentHash: normalized,
  })
  check('E-07', '创建书籍记录（带 contentHash）', typeof book.id === 'string' && book.contentHash === normalized, book.id + ' size=' + digest.size)

  const firstUpload = await booksApi.uploadFile(book.id, digest.hex, digest.bytes)
  check(
    'E-08',
    '上传真实 EPUB：201 表示写入新 blob，200 表示命中已有 blob（内容寻址去重语义自洽）',
    firstUpload.body.contentHash === normalized &&
      firstUpload.body.sizeBytes === digest.size &&
      ((firstUpload.status === 201 && firstUpload.body.deduplicated === false) ||
        (firstUpload.status === 200 && firstUpload.body.deduplicated === true)),
    JSON.stringify({ status: firstUpload.status, body: firstUpload.body }),
  )
  // 同内容二次上传：服务端按 contentHash 命中已有文件，不再写盘
  const secondUpload = await booksApi.uploadFile(book.id, digest.hex, digest.bytes)
  check(
    'E-09',
    '同一文件二次上传 → 200 且 deduplicated=true（内容寻址去重）',
    secondUpload.status === 200 && secondUpload.body.deduplicated === true,
    JSON.stringify({ status: secondUpload.status, body: secondUpload.body }),
  )
  // 声明哈希与实际字节不符必须被拒（证明服务端真的复核字节，而不是相信客户端声明）
  const probe = await booksApi.create({ title: 'Hash mismatch probe', format: 'epub', contentHash: 'sha256:' + 'f'.repeat(64) })
  const wrongHash = await expectApiError('contentHash 与字节不符', () => booksApi.uploadFile(probe.id, 'f'.repeat(64), digest.bytes), 400)
  check('E-10', '新书：声明哈希与上传字节不符被拒（400）', wrongHash.ok, wrongHash.detail)
  // 同一本书已经有一个文件，再上传不同内容 → 409（服务端以已存文件为准）
  const replacedFile = await expectApiError('同一本书换文件', () => booksApi.uploadFile(book.id, 'e'.repeat(64), digest.bytes), 409)
  check('E-10b', '同一本书换不同文件被拒（409 conflict）', replacedFile.ok, replacedFile.detail)

  const listed = await booksApi.list()
  check('E-11', '书库列表包含新书', listed.items.some((item) => item.id === book.id), 'items=' + listed.items.length)

  const stored = await deviceA.client.request<{ progress?: unknown }>('/v1/books/' + book.id)
  check('E-12', '单书详情可读（GET /v1/books/{id}）', typeof stored === 'object' && stored !== null, JSON.stringify(Object.keys(stored)))

  return { deviceA, bookId: book.id, contentHash: normalized, bookBytes: digest.bytes }
}

// ---------------------------------------------------------------- 2. 进度同步与冲突裁决

function locator(chapter: string, progression: number): { href: string; type: string; title: string; locations: { progression: number; totalProgression: number } } {
  return {
    href: 'OEBPS/' + chapter + '.xhtml',
    type: 'application/xhtml+xml',
    title: chapter,
    locations: { progression, totalProgression: progression },
  }
}

type SnapshotProgress = { bookId: string; totalProgression: number; furthestProgression: number; explicitRewind: boolean; contentHash: string | null; hlc: string }

async function progressOf(client: { request: <T>(path: string, init?: RequestInit) => Promise<T> }, bookId: string): Promise<SnapshotProgress | null> {
  const snapshot = await client.request<{ progress: SnapshotProgress[] }>('/v1/sync/snapshot')
  return snapshot.progress.find((item) => item.bookId === bookId) ?? null
}

async function progressAndConflicts(
  rtA: ReturnType<typeof createSyncRuntime>,
  rtB: ReturnType<typeof createSyncRuntime>,
  bookId: string,
  contentHash: string,
): Promise<{ otherReplica: string }> {
  const engineA = rtA.engine
  const engineB = rtB.engine
  const syncApi = createSyncApi(rtA.client)
  const otherReplica = 'sha256:' + 'ab'.repeat(32)

  // ---- 设备 A 首次推进度
  engineA.enqueueProgress({ bookId, locator: locator('chapter-05', 0.42), totalProgression: 0.42, contentHash })
  const runA1 = await engineA.run()
  check(
    'S-01',
    '设备 A 推送进度：服务端 applied 且分配游标',
    runA1.pushed === 1 && runA1.applied === 1 && runA1.cursor > 0 && engineA.outbox.size === 0,
    JSON.stringify(runA1),
  )

  // ---- 设备 B 首次同步（快照路径）
  const appliedB = await engineB.bootstrap()
  const bProgress = engineB.local.progress[bookId]
  check(
    'S-02',
    '设备 B 首同步（snapshot）拿到 A 的进度 0.42',
    bProgress !== undefined && Math.abs(bProgress.totalProgression - 0.42) < 1e-9,
    JSON.stringify({ applied: appliedB, progress: bProgress?.totalProgression, cursor: engineB.local.cursor }),
  )

  // ---- A 继续推进到 0.50，B 走增量 pull 路径
  const cursorBefore = engineB.local.cursor
  engineA.enqueueProgress({ bookId, locator: locator('chapter-06', 0.5), totalProgression: 0.5, contentHash })
  await engineA.run()
  const pullB = await engineB.pullOnce()
  const bAfter = engineB.local.progress[bookId]
  check(
    'S-03',
    '设备 B 增量 pull（cursor 断点续传）看到 0.50',
    cursorBefore > 0 && pullB.changes >= 1 && bAfter !== undefined && Math.abs(bAfter.totalProgression - 0.5) < 1e-9,
    JSON.stringify({ cursorBefore, pull: pullB, progress: bAfter?.totalProgression }),
  )
  const cursorAfterForward = await progressOf(rtA.client, bookId)
  const cursorValue = engineA.local.cursor

  // ---- 冲突 1：同一副本、更旧的 HLC（时钟偏慢的设备）
  const engineAOld = createSyncEngine(
    { baseUrl: BASE, deviceId: engineA.deviceId, baseBackoffMs: 1000, maxBackoffMs: 30000 },
    { client: rtA.client, storage: createMemoryStorage(), now: () => Date.now() - 3600_000, isOnline: () => true },
  )
  engineAOld.enqueueProgress({ bookId, locator: locator('chapter-02', 0.2), totalProgression: 0.2, contentHash })
  const oldPush = await engineAOld.pushOnce()
  const stale = await progressOf(rtA.client, bookId)
  check(
    'S-04',
    '同一副本的陈旧写入被忽略（reason=older_hlc，服务端位置不变）',
    oldPush.applied === 1 && oldPush.reasons.includes('older_hlc') && stale !== null && Math.abs(stale.totalProgression - 0.5) < 1e-9,
    JSON.stringify({ reasons: oldPush.reasons, cursor: oldPush.cursor, server: stale?.totalProgression }),
  )
  const bCursorBeforeStale = engineB.local.cursor
  const bPullAfterStale = await engineB.pullOnce()
  check(
    'S-05',
    '被忽略的 op 不产生变更行：服务端游标不动，其它设备 pull 拉不到',
    oldPush.pushCursor === cursorValue && bPullAfterStale.changes === 0 && engineB.local.cursor === bCursorBeforeStale,
    JSON.stringify({
      serverPushCursor: oldPush.pushCursor,
      serverCursorBefore: cursorValue,
      bChanges: bPullAfterStale.changes,
      bCursor: engineB.local.cursor,
      forwardSnapshot: cursorAfterForward?.totalProgression,
    }),
  )

  // ---- 冲突 2：不同副本（不同 contentHash）单调前移
  engineA.enqueueProgress({ bookId, locator: locator('chapter-20', 0.8), totalProgression: 0.8, contentHash: otherReplica })
  const forwardPush = await engineA.run()
  const afterForward = await progressOf(rtA.client, bookId)
  check(
    'S-06',
    '跨副本前进被接纳（位置 0.8，最远 0.8）',
    afterForward !== null && Math.abs(afterForward.totalProgression - 0.8) < 1e-9 && Math.abs(afterForward.furthestProgression - 0.8) < 1e-9,
    JSON.stringify({ cursor: forwardPush.cursor, server: afterForward }),
  )

  // ---- 冲突 3：跨副本（当前副本是 otherReplica，本条来自原副本）回退且未声明 explicitRewind
  engineA.enqueueProgress({ bookId, locator: locator('chapter-12', 0.55), totalProgression: 0.55, contentHash })
  const stalePush = await engineA.pushOnce()
  const afterStale = await progressOf(rtA.client, bookId)
  check(
    'S-07',
    '跨副本回退未声明 explicitRewind 被拒（reason=stale_no_rewind，位置/最远仍 0.8）',
    stalePush.reasons.includes('stale_no_rewind') &&
      afterStale !== null &&
      Math.abs(afterStale.totalProgression - 0.8) < 1e-9 &&
      Math.abs(afterStale.furthestProgression - 0.8) < 1e-9,
    JSON.stringify({ reasons: stalePush.reasons, server: afterStale?.totalProgression, furthest: afterStale?.furthestProgression }),
  )

  // ---- 冲突 3b：同一副本 + 更新的 HLC → 允许回退（规则 1），最远仍只增不减（规则 3）
  engineA.enqueueProgress({ bookId, locator: locator('chapter-12', 0.55), totalProgression: 0.55, contentHash: otherReplica })
  const sameReplicaPush = await engineA.pushOnce()
  const afterSame = await progressOf(rtA.client, bookId)
  check(
    'S-07b',
    '同副本较新 HLC 允许回退（位置 0.55），最远保持 0.8',
    (sameReplicaPush.reasons.length === 0 || sameReplicaPush.reasons.includes('newer_hlc')) &&
      afterSame !== null &&
      Math.abs(afterSame.totalProgression - 0.55) < 1e-9 &&
      Math.abs(afterSame.furthestProgression - 0.8) < 1e-9,
    JSON.stringify({ reasons: sameReplicaPush.reasons, position: afterSame?.totalProgression, furthest: afterSame?.furthestProgression }),
  )

  // ---- 冲突 4：跨副本显式回退（用户主动拖回）
  const rewindOp = engineA.enqueueProgress({
    bookId,
    locator: locator('chapter-03', 0.1),
    totalProgression: 0.1,
    contentHash,
    explicitRewind: true,
  })
  const rewindRun = await engineA.run()
  const afterRewind = await progressOf(rtA.client, bookId)
  check(
    'S-08',
    '显式回退生效（位置 0.1），但最远进度保持 0.8（只增不减）',
    afterRewind !== null &&
      Math.abs(afterRewind.totalProgression - 0.1) < 1e-9 &&
      Math.abs(afterRewind.furthestProgression - 0.8) < 1e-9 &&
      afterRewind.explicitRewind === true &&
      rewindRun.pushed === 1,
    JSON.stringify({ hlc: rewindOp.hlc, server: afterRewind }),
  )

  // ---- 幂等：同一 opId 重放
  const replayOp = engineA.enqueueProgress({ bookId, locator: locator('chapter-07', 0.6), totalProgression: 0.6, contentHash })
  await engineA.run()
  const cursorBeforeReplay = engineA.local.cursor
  const replayed = await syncApi.push({ deviceId: engineA.deviceId, ops: [replayOp] })
  const replayedItem = replayed.results[0]
  check(
    'S-09',
    '同 opId 重放：reason=duplicate 且游标不动',
    replayedItem !== undefined && replayedItem.status === 'applied' && replayedItem.reason === 'duplicate' && replayed.cursor === cursorBeforeReplay,
    JSON.stringify({ item: replayedItem, cursor: replayed.cursor, before: cursorBeforeReplay }),
  )

  // ---- 设备 B 把冲突后的最终状态拉平
  const finalPull = await engineB.pullOnce()
  const bFinal = engineB.local.progress[bookId]
  check(
    'S-10',
    '设备 B 最终收敛到服务端权威状态（位置 0.6 / 最远 0.8）',
    bFinal !== undefined && Math.abs(bFinal.totalProgression - 0.6) < 1e-9 && Math.abs(bFinal.furthestProgression - 0.8) < 1e-9,
    JSON.stringify({ changes: finalPull.changes, progress: bFinal }),
  )

  engineAOld.dispose()
  return { otherReplica }
}

// ---------------------------------------------------------------- 3. 标注同步 + 多用户隔离

async function annotationsAndIsolation(
  rtA: ReturnType<typeof createSyncRuntime>,
  rtB: ReturnType<typeof createSyncRuntime>,
  bookId: string,
): Promise<void> {
  const engineA = rtA.engine
  const engineB = rtB.engine
  const annotationId = uuidv7()
  const annotationInput = {
    locator: locator('chapter-05', 0.4) as never,
    type: 'highlight' as const,
    color: '#ffcc00',
    note: 'spike note',
    text: 'It was on a dreary night of November',
  }

  // ---- A 推送一条标注（走 outbox，不做 REST 直连）
  engineA.enqueueAnnotation(bookId, annotationId, annotationInput)
  const annRun = await engineA.run()
  const annInA = engineA.local.annotations[annotationId]
  check(
    'A-01',
    '设备 A 推送标注：服务端 applied 且本地投影可见',
    annRun.applied === 1 && annInA !== undefined && annInA.note === 'spike note',
    JSON.stringify({ applied: annRun.applied, id: annInA?.id }),
  )

  // ---- B 拉取到该标注
  await engineB.pullOnce()
  check('A-02', '设备 B pull 到 A 新建的标注', engineB.local.annotations[annotationId] !== undefined)

  // ---- A 删除（墓碑）
  engineA.enqueueAnnotation(bookId, annotationId)
  await engineA.run()
  await engineB.pullOnce()
  check('A-03', '删除走墓碑：B 拉取后本地不再有该标注', engineB.local.annotations[annotationId] === undefined)

  // ---- remove-wins：慢设备用更旧的 HLC 试图复活 → 必须失败
  const engineAOld = createSyncEngine(
    { baseUrl: BASE, deviceId: engineA.deviceId },
    { client: rtA.client, storage: createMemoryStorage(), now: () => Date.now() - 7200_000, isOnline: () => true },
  )
  engineAOld.enqueueAnnotation(bookId, annotationId, annotationInput)
  const resurrect = await engineAOld.pushOnce()
  await engineB.pullOnce()
  check(
    'A-04',
    '墓碑不可复活（remove-wins）：陈旧 upsert 未生效',
    engineB.local.annotations[annotationId] === undefined && resurrect.applied === 1,
    JSON.stringify({ reasons: resurrect.reasons, stillGone: engineB.local.annotations[annotationId] === undefined }),
  )
  engineAOld.dispose()

  // ---- 服务端发起的变更也要能被客户端拉到（REST 建标注 → AppendServerChange）
  const serverAnnotation = await createAnnotationsApi(rtA.client).create(bookId, {
    locator: locator('chapter-11', 0.55) as never,
    type: 'note',
    color: null,
    note: 'created via REST on the server',
    text: null,
  } as never)
  await engineA.pullOnce()
  check(
    'A-05',
    '服务端 REST 创建的标注被客户端 pull 到（游标只由服务端分配）',
    engineA.local.annotations[serverAnnotation.id] !== undefined,
    'id=' + serverAnnotation.id,
  )

  // ---- 多用户隔离：用户 C 完全看不到 A 的数据
  const rtC = createSyncRuntime({
    baseUrl: BASE,
    storage: createMemoryStorage(),
    deviceId: deviceIdFor('C'),
    deviceName: 'spike-device-C',
    onExchange: capture('C'),
  })
  await rtC.session.register({
    email: 'spike-c-' + RUN + '@example.com',
    password: PASSWORD,
    displayName: 'Spike C',
    deviceName: 'spike-device-C',
  })
  const booksC = createBooksApi(rtC.client)
  const syncC = createSyncApi(rtC.client)
  const listC = await booksC.list()
  check('I-01', '用户 C 的书库为空（看不到 A 的书）', listC.items.length === 0, 'items=' + listC.items.length)

  const crossRead = await expectApiError('C 读 A 的书', () => booksC.get(bookId), 404)
  check('I-02', '用户 C 直接读 A 的 bookId 被拒（404）', crossRead.ok, crossRead.detail)

  const snapshotC = await syncC.snapshot()
  check(
    'I-03',
    '用户 C 的同步快照为空（无书/无进度/无标注）',
    snapshotC.books.length === 0 && snapshotC.progress.length === 0 && snapshotC.annotations.length === 0,
    JSON.stringify({ books: snapshotC.books.length, progress: snapshotC.progress.length, annotations: snapshotC.annotations.length }),
  )

  const pullC = await syncC.pull(0, 500)
  check('I-04', '用户 C 从 cursor=0 拉取：拿不到 A 的任何变更', pullC.changes.length === 0, 'changes=' + pullC.changes.length)

  // C 推一条针对 A 的 bookId 的进度：只能落到 C 自己的行，A 的状态不受影响
  const beforeA = await progressOf(rtA.client, bookId)
  rtC.engine.enqueueProgress({
    bookId,
    locator: locator('chapter-01', 0.01),
    totalProgression: 0.01,
    contentHash: 'sha256:' + 'cd'.repeat(32),
  })
  const runC = await rtC.engine.run()
  const afterA = await progressOf(rtA.client, bookId)
  const cOwn = await progressOf(rtC.client, bookId)
  check(
    'I-05',
    'C 写入同一 bookId 只影响 C 自己的行（A 的位置不变）',
    runC.applied === 1 &&
      beforeA !== null &&
      afterA !== null &&
      Math.abs(afterA.totalProgression - beforeA.totalProgression) < 1e-9 &&
      cOwn !== null &&
      Math.abs(cOwn.totalProgression - 0.01) < 1e-9,
    JSON.stringify({ aBefore: beforeA?.totalProgression, aAfter: afterA?.totalProgression, c: cOwn?.totalProgression }),
  )
}

// ---------------------------------------------------------------- 4. 主流程与证据落盘

async function writeEvidence(startedAt: number, fatal?: unknown): Promise<void> {
  await mkdir(OUT, { recursive: true })
  const failed = checks.filter((item) => !item.ok)
  const summary = {
    runId: RUN,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    baseUrl: BASE,
    book: BOOK,
    checks: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    fatal: fatal === undefined ? null : String(fatal),
  }
  await writeFile(join(OUT, 'checks.json'), JSON.stringify({ summary, checks }, null, 2), 'utf8')
  await writeFile(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
  const lines = exchanges.map((item) => JSON.stringify(item))
  await writeFile(join(OUT, 'http-trace.jsonl'), lines.join('\n') + '\n', 'utf8')
  console.log('\n=== 证据 ===')
  console.log('HTTP 往返条数: ' + exchanges.length + ' → ' + join(OUT, 'http-trace.jsonl'))
  console.log('断言: ' + (checks.length - failed.length) + '/' + checks.length + ' 通过 → ' + join(OUT, 'checks.json'))
  if (failed.length > 0) {
    console.log('失败项: ' + failed.map((item) => item.id + ' ' + item.name).join(' | '))
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  try {
    clientSideChecks()

    const healthClient = createApiClient({ baseUrl: BASE, onExchange: capture('HEALTH') })
    const health = await healthClient.request<{ status: string }>('/healthz')
    check('E-00', '服务端存活探针 /healthz', health.status === 'ok', health.status)

    const { deviceA, bookId, contentHash } = await authAndBooks()
    const emailA = deviceA.session.email ?? ''

    const deviceB = createSyncRuntime({
      baseUrl: BASE,
      storage: createMemoryStorage(),
      deviceId: deviceIdFor('B'),
      deviceName: 'spike-device-B',
      platform: 'android',
      onExchange: capture('B'),
    })
    const tokensB = await deviceB.session.login({
      email: emailA,
      password: PASSWORD,
      deviceName: 'spike-device-B',
      platform: 'android',
    })
    check('E-13', '设备 B 用同一账号登录成功（独立令牌）', tokensB.accessToken !== (deviceA.session.accessToken ?? ''), 'user=' + (tokensB.user?.email ?? '?'))

    const devices = await createAuthApi(deviceA.client).devices()
    check('E-14', '设备列表包含 A 与 B（服务端登记设备）', devices.length >= 2, JSON.stringify(devices).slice(0, 400))

    // 走「引擎自动生成 deviceId」的真实路径：生成值必须是合法 UUID，否则 auth/devices 写库会失败
    const deviceAuto = createSyncRuntime({ baseUrl: BASE, storage: createMemoryStorage(), onExchange: capture('AUTO') })
    await deviceAuto.session.register({
      email: 'spike-auto-' + RUN + '@example.com',
      password: PASSWORD,
      deviceName: 'spike-device-auto',
    })
    // ---- 以下两条是联调中发现的**服务端健壮性缺陷取证**（不改服务端实现，记录给 server-dev）
    const engineHlc = deviceA.engine.nextHlc()
    const devShared = deviceIdFor('SHARED')
    const bareClient = createApiClient({ baseUrl: BASE, onExchange: capture('F') })
    const authF = createAuthApi(bareClient)
    await authF.register({
      email: 'spike-f1-' + RUN + '@example.com',
      password: PASSWORD,
      deviceName: 'spike-f1',
      deviceId: devShared,
    })
    const reuseDevice = await expectApiError(
      '跨用户复用 deviceId 注册',
      () =>
        authF.register({
          email: 'spike-f1b-' + RUN + '@example.com',
          password: PASSWORD,
          deviceName: 'spike-f1b',
          deviceId: devShared,
        }),
      409,
    )
    check(
      'F-01',
      '跨用户复用 deviceId 注册正确返回 409 conflict',
      reuseDevice.ok,
      reuseDevice.detail,
    )

    const badOp = await expectApiError(
      '非法 opId',
      () =>
        createSyncApi(deviceA.client).push({
          deviceId: deviceA.engine.deviceId,
          ops: [
            {
              opId: '01a19d1b-66b3-000-7b27-85780e478194',
              entity: 'progress',
              entityId: bookId,
              kind: 'upsert',
              hlc: engineHlc,
              deviceId: deviceA.engine.deviceId,
              payload: { totalProgression: 0.01 },
            },
          ] as never,
        }),
      400,
    )
    check(
      'F-02',
      '非法 UUID 的 opId 正确拦截并返回 400 invalid_request',
      badOp.ok,
      badOp.detail,
    )

    check(
      'E-15',
      '引擎自动生成的 deviceId 被服务端接受（合法 UUID）',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deviceAuto.engine.deviceId) &&
        deviceAuto.session.accessToken !== null,
      deviceAuto.engine.deviceId,
    )

    await progressAndConflicts(deviceA, deviceB, bookId, contentHash)
    await annotationsAndIsolation(deviceA, deviceB, bookId)

    await writeEvidence(startedAt)
    if (checks.some((item) => !item.ok)) process.exitCode = 1
  } catch (err) {
    console.error('FATAL: ' + (err instanceof Error ? err.stack ?? err.message : String(err)))
    await writeEvidence(startedAt, err)
    process.exitCode = 2
  }
}

await main()
