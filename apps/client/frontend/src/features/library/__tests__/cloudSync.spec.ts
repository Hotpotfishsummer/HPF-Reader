import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setPlatformForTest } from '@/platform'
import { createTestPlatform, type TestPlatform } from '@/platform/test'
import { rememberLocalFile, sha256Hex } from '@/reader/bookSession'
import { getSyncRuntime } from '@/features/sync/runtime'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '../stores/libraryStore'

/**
 * 云书库同步（task-5）单测。
 *
 * 覆盖四条硬性契约：
 *   ① 云端已有同 contentHash → 不重复上传（不再 POST /v1/books）
 *   ② 下载字节哈希与云端 contentHash 不一致 → 拒绝 import（不能把坏数据写进本地书库）
 *   ③ 下载成功 → 以云端 title/author/format 调 platform.library.importBookBytes
 *   ④ 未登录 → 零请求（不发 list / 不发 file）
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    books: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      uploadFile: vi.fn(),
      getFileBytes: vi.fn(),
    },
  },
}))

vi.mock('@/api', () => ({ getApi: () => apiMock }))

/** 一段"像 EPUB"的本地字节（PK 头）。 */
const LOCAL_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x11, 0x22, 0x33, 0x44])
/** 另一段云端字节。 */
const CLOUD_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xaa, 0xbb, 0xcc, 0xdd, 0xee])

function cloudDto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cloud-1',
    title: '云端书名',
    author: '云端作者',
    format: 'epub',
    contentHash: 'sha256:' + 'f'.repeat(64),
    sizeBytes: CLOUD_BYTES.byteLength,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

let platform: TestPlatform

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  platform = createTestPlatform({
    books: [
      {
        id: 'local-1',
        title: '本地书',
        author: '本地作者',
        format: 'epub',
        contentHash: '0'.repeat(64),
        sizeBytes: LOCAL_BYTES.byteLength,
        addedAt: '2026-01-01T00:00:00Z',
      },
    ],
    bytes: { 'local-1': LOCAL_BYTES },
  })
  setPlatformForTest(platform)
})

/**
 * 把全局同步会话设成"已登录/未登录"，再让 auth store 同步一次。
 * auth store 的 token 不是可写导出，唯一合法入口是 session + syncFromSession()。
 */
async function setup(opts: { authenticated: boolean }) {
  const session = getSyncRuntime().session
  if (opts.authenticated) {
    session.adopt({ accessToken: 'a'.repeat(32), refreshToken: 'b'.repeat(32), expiresIn: 3600 })
  } else {
    session.clear()
  }
  const auth = useAuthStore()
  auth.syncFromSession()
  const library = useLibraryStore()
  await library.refresh()
  return { auth, library }
}

describe('云书库同步', () => {
  it('① 云端已有同 contentHash 时复用，不重复上传', async () => {
    const { library } = await setup({ authenticated: true })
    const localHash = await sha256Hex(LOCAL_BYTES)

    apiMock.books.list.mockResolvedValue({
      items: [cloudDto({ id: 'cloud-existing', title: '云端已有', contentHash: 'sha256:' + localHash })],
    })

    const localBook = library.books.find((b) => b.id === 'local-1')
    expect(localBook).toBeTruthy()
    const ok = await library.uploadToCloud(localBook!)

    expect(ok).toBe(true)
    // 云端已有同哈希 → 不新建、不上传。
    expect(apiMock.books.create).not.toHaveBeenCalled()
    expect(apiMock.books.uploadFile).not.toHaveBeenCalled()
    // 云端列表已刷新为服务端快照。
    expect(library.cloudBooks.map((b) => b.id)).toEqual(['cloud-existing'])
  })

  it('② 下载字节与云端 contentHash 不一致 → 拒绝入库', async () => {
    const { library } = await setup({ authenticated: true })
    const importSpy = vi.spyOn(platform.library, 'importBookBytes')

    apiMock.books.getFileBytes.mockResolvedValue(CLOUD_BYTES)
    apiMock.books.list.mockResolvedValue({
      // 云端声明的哈希与实际字节哈希不同（模拟传输损坏 / 服务端串对象）。
      items: [cloudDto({ contentHash: 'sha256:' + 'a'.repeat(64) })],
    })
    await library.refreshCloud()

    const result = await library.downloadCloud('cloud-1')

    expect(result).toBeNull()
    expect(importSpy).not.toHaveBeenCalled()
    expect(library.cloudError?.code).toBe('hash-mismatch')
    // 本地书库没有被污染。
    expect(library.books.map((b) => b.id)).toEqual(['local-1'])
  })

  it('③ 下载成功 → 以云端 title/author 调 importBookBytes', async () => {
    const { library } = await setup({ authenticated: true })
    const importSpy = vi.spyOn(platform.library, 'importBookBytes')
    const cloudHash = await sha256Hex(CLOUD_BYTES)

    apiMock.books.getFileBytes.mockResolvedValue(CLOUD_BYTES)
    apiMock.books.list.mockResolvedValue({
      items: [cloudDto({ id: 'cloud-2', title: '真正的云端书名', author: '云端作者甲', contentHash: 'sha256:' + cloudHash })],
    })
    await library.refreshCloud()

    const record = await library.downloadCloud('cloud-2')

    expect(record).toBeTruthy()
    expect(importSpy).toHaveBeenCalledTimes(1)
    const arg = importSpy.mock.calls[0]![0]
    expect(arg.title).toBe('真正的云端书名')
    expect(arg.author).toBe('云端作者甲')
    expect(arg.format).toBe('epub')
    expect(arg.name).toBe('真正的云端书名.epub')
    expect(Array.from(arg.bytes)).toEqual(Array.from(CLOUD_BYTES))
    // 入库后本地列表已刷新，且 contentHash 与云端一致（连接键）。
    expect(library.books.some((b) => b.title === '真正的云端书名')).toBe(true)
    expect(library.localHasHash(cloudHash)).toBe(true)
    expect(library.cloudError).toBeNull()
  })

  it('④ 未登录 → 零请求', async () => {
    const { library } = await setup({ authenticated: false })

    await library.refreshCloud()
    const download = await library.downloadCloud('cloud-1')

    expect(download).toBeNull()
    expect(apiMock.books.list).not.toHaveBeenCalled()
    expect(apiMock.books.getFileBytes).not.toHaveBeenCalled()
    expect(apiMock.books.get).not.toHaveBeenCalled()
    expect(library.cloudBooks).toEqual([])
    // refreshCloud 不把"未登录"当错误；downloadCloud 显式标记 need-login（UI 显示 cloudNeedLogin）。
    expect(library.cloudError?.code).toBe('need-login')
  })

  it('④b 未登录时 uploadToCloud 同样零请求', async () => {
    const { library } = await setup({ authenticated: false })
    const localBook = library.books.find((b) => b.id === 'local-1')

    const ok = await library.uploadToCloud(localBook!)

    expect(ok).toBe(false)
    expect(apiMock.books.list).not.toHaveBeenCalled()
    expect(apiMock.books.create).not.toHaveBeenCalled()
    expect(apiMock.books.uploadFile).not.toHaveBeenCalled()
    expect(library.cloudError?.code).toBe('need-login')
  })

  it('①b 云端没有同哈希时正常新建并上传', async () => {
    const { library } = await setup({ authenticated: true })
    const localHash = await sha256Hex(LOCAL_BYTES)

    apiMock.books.list.mockResolvedValue({ items: [] })
    apiMock.books.create.mockResolvedValue({ id: 'cloud-new', title: '本地书' })
    apiMock.books.uploadFile.mockResolvedValue({ status: 201, body: { contentHash: localHash, sizeBytes: LOCAL_BYTES.byteLength, deduplicated: false } })

    const localBook = library.books.find((b) => b.id === 'local-1')
    const ok = await library.uploadToCloud(localBook!)

    expect(ok).toBe(true)
    expect(apiMock.books.create).toHaveBeenCalledTimes(1)
    expect(apiMock.books.create.mock.calls[0]![0]).toMatchObject({
      title: '本地书',
      contentHash: 'sha256:' + localHash,
    })
    expect(apiMock.books.uploadFile).toHaveBeenCalledWith('cloud-new', localHash, LOCAL_BYTES, expect.anything())
  })

  it('⑤ 云端同哈希但**没有文件**（上次上传失败的残骸）→ 复用那本书重传，不新建', async () => {
    const { library } = await setup({ authenticated: true })
    const localHash = await sha256Hex(LOCAL_BYTES)

    // 服务端在 POST /v1/books 时就把声明的 contentHash 写进了 books.file_hash，
    // 但文件没传上去时 file_size 仍是 0 ⇒ sizeBytes 为 0。
    apiMock.books.list.mockResolvedValue({
      items: [
        cloudDto({
          id: 'cloud-wedged',
          contentHash: 'sha256:' + localHash,
          sizeBytes: 0,
        }),
      ],
    })
    apiMock.books.uploadFile.mockResolvedValue({
      status: 201,
      body: { contentHash: localHash, sizeBytes: LOCAL_BYTES.byteLength, deduplicated: false },
    })

    const localBook = library.books.find((b) => b.id === 'local-1')
    const ok = await library.uploadToCloud(localBook!)

    expect(ok).toBe(true)
    // ★ 不能再新建：服务端有 books_user_hash_idx 唯一索引，新建会 409。
    expect(apiMock.books.create).not.toHaveBeenCalled()
    expect(apiMock.books.uploadFile).toHaveBeenCalledWith('cloud-wedged', localHash, LOCAL_BYTES, expect.anything())
  })

  it('⑤b 云端同哈希**且已有文件** → 秒传命中，不重复上传', async () => {
    const { library } = await setup({ authenticated: true })
    const localHash = await sha256Hex(LOCAL_BYTES)

    apiMock.books.list.mockResolvedValue({
      items: [
        cloudDto({
          id: 'cloud-done',
          contentHash: 'sha256:' + localHash,
          sizeBytes: LOCAL_BYTES.byteLength,
        }),
      ],
    })

    const localBook = library.books.find((b) => b.id === 'local-1')
    const ok = await library.uploadToCloud(localBook!)

    expect(ok).toBe(true)
    expect(apiMock.books.create).not.toHaveBeenCalled()
    expect(apiMock.books.uploadFile).not.toHaveBeenCalled()
  })

  it('⑥ 云端条目没有文件 → 不发 file 请求，直接报 no-file（下载必然 404）', async () => {
    const { library } = await setup({ authenticated: true })
    const importSpy = vi.spyOn(platform.library, 'importBookBytes')

    apiMock.books.list.mockResolvedValue({
      items: [cloudDto({ id: 'cloud-empty', sizeBytes: 0 })],
    })
    await library.refreshCloud()

    const result = await library.downloadCloud('cloud-empty')

    expect(result).toBeNull()
    expect(apiMock.books.getFileBytes).not.toHaveBeenCalled()
    expect(importSpy).not.toHaveBeenCalled()
    expect(library.cloudError?.code).toBe('no-file')
  })

  it('⑦ 本次会话直接打开、没进本地书库索引的书也能上传（字节来自会话缓存）', async () => {
    const { library } = await setup({ authenticated: true })
    const localHash = await sha256Hex(LOCAL_BYTES)

    // 模拟"文件选择器 / 拖拽打开"：字节只在会话内存里，**不在** platform 书库索引里。
    const payload = rememberLocalFile({
      id: 'session-book-1',
      name: 'session.epub',
      bytes: LOCAL_BYTES,
      sizeBytes: LOCAL_BYTES.byteLength,
    })
    library.registerSessionBook(payload.book)
    expect(library.books.some((b) => b.id === 'session-book-1')).toBe(false)
    expect(library.displayBooks.some((b) => b.id === 'session-book-1')).toBe(true)

    apiMock.books.list.mockResolvedValue({ items: [] })
    apiMock.books.create.mockResolvedValue({ id: 'cloud-session', title: 'session' })
    apiMock.books.uploadFile.mockResolvedValue({
      status: 201,
      body: { contentHash: localHash, sizeBytes: LOCAL_BYTES.byteLength, deduplicated: false },
    })

    const sessionBook = library.displayBooks.find((b) => b.id === 'session-book-1')
    const ok = await library.uploadToCloud(sessionBook!)

    expect(ok).toBe(true)
    expect(apiMock.books.uploadFile).toHaveBeenCalledWith('cloud-session', localHash, LOCAL_BYTES, expect.anything())
  })
})
