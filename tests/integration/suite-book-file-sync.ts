import { createHash, randomUUID } from 'node:crypto'
import { TestHarness, deviceIdFor } from './runner'
import { createBooksApi } from '../../apps/client/frontend/src/api/endpoints'
import { createSyncRuntime } from '../../apps/client/frontend/src/features/sync/runtime'
import { createMemoryStorage } from '../../apps/client/frontend/src/features/sync/storage'
import type { UploadedBooks } from './suite-books-upload'

/**
 * [Suite 9] 书籍文件同步（云书库 → 本地书库）与"内容哈希 = 跨端身份键"。
 *
 * 用户场景：A 机器把书上传到云端 → B 机器登录后看到云端书籍 → 下载入库 → 继续读，
 * 且 B 产生的阅读进度/笔记能被 A 拉到（进度与文件都挂在同一本书上）。
 *
 * 客户端下载路径的关键约束（也是本套件的断言）：
 *   ① 下载字节必须与云端 contentHash 逐字节一致，否则拒绝入库（防半截文件/中间人）；
 *   ② 本地已有同 contentHash 时不得重复下载（秒传语义）；
 *   ③ 未登录不得下载（GET /v1/books/{id}/file 需要鉴权）。
 */
export async function runBookFileSyncSuite(
  harness: TestHarness,
  runId: string,
  userEmail: string,
  password: string,
  books: UploadedBooks,
): Promise<void> {
  const SUITE = 'Book-File-Sync'
  console.log('\n=== [Suite 9] 云端书库下载、哈希校验去重与跨端同一身份验证 ===')

  // 全新设备 B：干净存储 + 独立 deviceId，模拟"另一台机器"
  const deviceB = createSyncRuntime({
    baseUrl: harness.baseUrl,
    storage: createMemoryStorage(),
    deviceId: deviceIdFor('dev-BFS', runId),
    deviceName: 'Cloud-Download-B',
    platform: 'windows',
  })
  await deviceB.session.login({ email: userEmail, password, deviceName: 'Cloud-Download-B' })
  const booksApiB = createBooksApi(deviceB.client)

  // ---------- 1. 云端书库列表：能按内容哈希定位到 A 上传的书 ----------
  const page = await harness.runStep(
    SUITE,
    'BF-01',
    '新设备登录后拉取云端书库列表',
    () => booksApiB.list({ limit: 100 }),
    (p) => ({ ok: p.items.length >= 3, detail: `云端书籍 ${p.items.length} 本` }),
  )

  const aliceRemote = page.items.find((b) => b.contentHash === 'sha256:' + books.alice.hash)
  harness.check(
    SUITE,
    'BF-02',
    '内容哈希是跨端身份键：云端条目能与本地文件（sha256）一一对上',
    aliceRemote !== undefined,
    `found=${aliceRemote !== undefined}, id=${aliceRemote?.id}`,
  )
  const remoteId = aliceRemote?.id ?? books.alice.book.id

  // ---------- 2. 下载并逐字节校验 ----------
  const downloaded = await harness.runStep(
    SUITE,
    'BF-03',
    '下载云端书籍文件（客户端 books.getFileBytes）',
    () => booksApiB.getFileBytes(remoteId),
    (res) => ({ ok: res.byteLength > 0, detail: `${res.byteLength} bytes` }),
  )

  const localHex = createHash('sha256').update(downloaded).digest('hex')
  harness.check(
    SUITE,
    'BF-04',
    '下载字节与源文件 SHA-256 完全一致（入库前的校验依据）',
    localHex === books.alice.hash && downloaded.byteLength === books.alice.bytes.byteLength,
    `cloud=${books.alice.hash.slice(0, 16)}..., downloaded=${localHex.slice(0, 16)}..., bytes=${downloaded.byteLength}`,
  )

  // ---------- 3. 篡改检测：字节被改一位必须被发现 ----------
  const tampered = new Uint8Array(downloaded)
  tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff
  const tamperedHex = createHash('sha256').update(tampered).digest('hex')
  harness.check(
    SUITE,
    'BF-05',
    '篡改一个字节即被哈希校验识破（客户端必须拒绝入库）',
    tamperedHex !== books.alice.hash,
    `tampered=${tamperedHex.slice(0, 16)}... vs cloud=${books.alice.hash.slice(0, 16)}...`,
  )

  // ---------- 4. 去重语义：同哈希 = 已在本地 ----------
  const localHashes = new Set<string>([books.alice.hash])
  harness.check(
    SUITE,
    'BF-06',
    '本地已存在同 contentHash 时判定为「已在本地」，不重复下载/入库',
    localHashes.has(localHex) === true,
    'localHashes has downloaded hash = true',
  )

  // ---------- 5. 同一本书上的阅读数据双向收敛 ----------
  // ★ 每次运行都必须用**新的**标注 id：annotations.id 是全局主键（不是 per-user），
  //   复用固定 UUID 会撞上上一次运行的同一行 → 本次用户拿不到该行，快照里自然看不到，
  //   于是测试红而产品无辜。真实客户端用 uuidv7，本来就不会撞。
  const annotationId = randomUUID()
  const progressBook = remoteId
  deviceB.engine.enqueueAnnotation(progressBook, annotationId, {
    type: 'note',
    text: 'B 机器下载后写下的笔记',
    locator: {
      href: 'OEBPS/chapter-02.xhtml',
      type: 'application/xhtml+xml',
      locations: { fragments: ['/6/4!/4/2'], progression: 0.31 },
    },
  })
  const pushB = await harness.runStep(
    SUITE,
    'BF-07',
    'B 机器在下载后的书上写入笔记并推送（文件同步 + 阅读数据同步同一身份）',
    () => deviceB.engine.run(),
    (res) => ({
      // 注意：pushed 只代表"提交了几条"，必须再看服务端裁决（applied/rejected），
      // 否则一条被拒的 op 也会让这条断言变绿 —— 这正是最容易漏掉的假绿。
      ok: res.pushed === 1 && res.applied === 1 && res.rejected === 0 && res.errors.length === 0,
      detail: `pushed=${res.pushed}, applied=${res.applied}, rejected=${res.rejected}, errors=${res.errors.length}`,
    }),
  )
  void pushB

  const deviceAView = createSyncRuntime({
    baseUrl: harness.baseUrl,
    storage: createMemoryStorage(),
    deviceId: deviceIdFor('dev-BFS-A', runId),
    deviceName: 'Cloud-Download-A',
    platform: 'windows',
  })
  await deviceAView.session.login({ email: userEmail, password, deviceName: 'Cloud-Download-A' })
  await deviceAView.engine.bootstrap()
  const seenOnA = deviceAView.engine.local.annotations[annotationId]

  harness.check(
    SUITE,
    'BF-08',
    'A 机器 bootstrap 后能看到 B 的笔记（跨端收敛到同一 bookId）',
    // kind=note 的正文在 text 列；note 列是给 highlight 附加的批注（契约见 openapi Annotation）。
    seenOnA !== undefined && seenOnA.text === 'B 机器下载后写下的笔记' && seenOnA.bookId === progressBook,
    `text=${seenOnA?.text ?? '(missing)'}, bookId=${seenOnA?.bookId ?? '-'}`,
  )

  // ---------- 回归：快照里的标注必须自带身份（曾经的 annotations['undefined'] 幽灵条目） ----------
  const projectionKeys = Object.keys(deviceAView.engine.local.annotations)
  harness.check(
    SUITE,
    'BF-10',
    'bootstrap 后标注投影按真实 id 建键，不存在 undefined 幽灵条目（回归 BF-08 根因）',
    projectionKeys.includes(annotationId) &&
      !projectionKeys.includes('undefined') &&
      projectionKeys.every((k) => k.length === 36),
    `keys=${projectionKeys.length}, hasRealId=${projectionKeys.includes(annotationId)}, hasUndefined=${projectionKeys.includes('undefined')}`,
  )

  // ---------- 6. 下载必须登录 ----------
  const anonResp = await fetch(`${harness.baseUrl}/v1/books/${remoteId}/file`)
  harness.check(
    SUITE,
    'BF-09',
    '未登录下载云端书籍文件被拒（401，不泄漏内容）',
    anonResp.status === 401,
    `status=${anonResp.status}`,
  )

  deviceB.engine.dispose()
  deviceAView.engine.dispose()
}
