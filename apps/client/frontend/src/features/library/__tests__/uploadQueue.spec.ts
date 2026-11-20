import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setPlatformForTest } from '@/platform'
import { createTestPlatform, type TestPlatform } from '@/platform/test'
import { sha256Hex } from '@/reader/bookSession'
import { getSyncRuntime } from '@/features/sync/runtime'
import { useAuthStore } from '@/stores/auth'
import { useLibraryStore } from '../stores/libraryStore'

/**
 * 上传队列（进度 / 取消 / 重试 / 失败隔离）单测。
 *
 * 守住的用户体验契约：
 *   ① 上传过程中能看到**字节级进度**（不是只有一个转圈的按钮）；
 *   ② 失败原因落在**任务**上（面板顶部就能看到，不用滚到页面底部）；
 *   ③ 用户能**取消**正在传的书，取消后状态是 canceled（不是含糊的 failed）；
 *   ④ 批量上传**一本书失败不影响后面**，且云端列表只查一次（不做 N+1）。
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

const LOCAL_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x11, 0x22, 0x33, 0x44])
const OTHER_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x99, 0xaa, 0xbb, 0xcc])

let platform: TestPlatform

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  platform = createTestPlatform({
    books: [
      {
        id: 'local-1',
        title: '本地书一',
        author: '作者一',
        format: 'epub',
        contentHash: '0'.repeat(64),
        sizeBytes: LOCAL_BYTES.byteLength,
        addedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'local-2',
        title: '本地书二',
        author: '作者二',
        format: 'epub',
        contentHash: '1'.repeat(64),
        sizeBytes: OTHER_BYTES.byteLength,
        addedAt: '2026-01-02T00:00:00Z',
      },
    ],
    bytes: { 'local-1': LOCAL_BYTES, 'local-2': OTHER_BYTES },
  })
  setPlatformForTest(platform)
  apiMock.books.list.mockResolvedValue({ items: [] })
  apiMock.books.create.mockImplementation(async (input: { title: string }) => ({
    id: 'remote-' + input.title,
    title: input.title,
    author: '',
    format: 'epub',
    contentHash: 'sha256:' + 'e'.repeat(64),
    sizeBytes: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }))
  apiMock.books.uploadFile.mockResolvedValue({ status: 201, body: { contentHash: 'x', sizeBytes: 8 } })
})

async function setup() {
  const session = getSyncRuntime().session
  session.adopt({ accessToken: 'a'.repeat(32), refreshToken: 'b'.repeat(32), expiresIn: 3600 })
  const auth = useAuthStore()
  auth.syncFromSession()
  const library = useLibraryStore()
  await library.refresh()
  return { auth, library }
}

describe('上传队列', () => {
  it('① 上传过程中记录字节级进度（面板能画出进度条）', async () => {
    const { library } = await setup()
    const localHash = await sha256Hex(LOCAL_BYTES)
    apiMock.books.list.mockResolvedValue({ items: [] })
    apiMock.books.uploadFile.mockImplementation(
      async (_id: string, _hash: string, _bytes: Uint8Array, options?: { onProgress?: (p: { loaded: number; total: number | null }) => void }) => {
        options?.onProgress?.({ loaded: 3, total: 8 })
        options?.onProgress?.({ loaded: 8, total: 8 })
        return { status: 201, body: { contentHash: localHash, sizeBytes: 8 } }
      },
    )

    const book = library.books.find((b) => b.id === 'local-1')!
    const ok = await library.uploadToCloud(book)

    expect(ok).toBe(true)
    const task = library.uploadTasks.find((t) => t.bookId === 'local-1')
    expect(task?.state).toBe('done')
    expect(task?.loaded).toBe(8)
    expect(task?.total).toBe(8)
    expect(task?.bytesPerSecond).toBeGreaterThanOrEqual(0)
  })

  it('② 上传失败：任务变 failed 且带上原因（面板顶部可见）', async () => {
    const { library } = await setup()
    apiMock.books.list.mockResolvedValue({ items: [] })
    apiMock.books.uploadFile.mockRejectedValue(new Error('storage quota exceeded'))

    const book = library.books.find((b) => b.id === 'local-1')!
    const ok = await library.uploadToCloud(book)

    expect(ok).toBe(false)
    const task = library.uploadTasks.find((t) => t.bookId === 'local-1')
    expect(task?.state).toBe('failed')
    expect(task?.error).toContain('storage quota exceeded')
    expect(library.cloudError?.code).toBe('failed')
  })

  it('③ 用户取消 ⇒ 任务状态 canceled，AbortSignal 真的被触发', async () => {
    const { library } = await setup()
    apiMock.books.list.mockResolvedValue({ items: [] })
    let aborted = false
    apiMock.books.uploadFile.mockImplementation(
      async (_id: string, _hash: string, _bytes: Uint8Array, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )

    const book = library.books.find((b) => b.id === 'local-1')!
    const promise = library.uploadToCloud(book)
    // 等到真的进了上传阶段再取消。
    await vi.waitFor(() => expect(apiMock.books.uploadFile).toHaveBeenCalled())
    library.cancelUpload()
    const ok = await promise

    expect(ok).toBe(false)
    expect(aborted).toBe(true)
    const task = library.uploadTasks.find((t) => t.bookId === 'local-1')
    expect(task?.state).toBe('canceled')
  })

  it('④ 批量上传：云端列表只查一次（不再每本一次）', async () => {
    const { library } = await setup()
    apiMock.books.list.mockResolvedValue({ items: [] })

    const result = await library.uploadAllToCloud()

    expect(result).toEqual({ uploaded: 2, failed: 0 })
    // 1 次预取 + 1 次收尾刷新 = 2 次（原来每本都 list 一遍）。
    expect(apiMock.books.list.mock.calls.length).toBeLessThanOrEqual(2)
    expect(library.uploadTasks.map((t) => t.state)).toEqual(['done', 'done'])
  })

  it('⑤ 批量上传：一本失败不影响后面的，失败原因留在任务上', async () => {
    const { library } = await setup()
    apiMock.books.list.mockResolvedValue({ items: [] })
    apiMock.books.uploadFile.mockImplementation(async (id: string) => {
      if (id.includes('本地书一')) throw new Error('network error')
      return { status: 201, body: { contentHash: 'x', sizeBytes: 8 } }
    })

    const result = await library.uploadAllToCloud()

    expect(result.failed).toBe(1)
    expect(result.uploaded).toBe(1)
    const failed = library.uploadTasks.find((t) => t.state === 'failed')
    expect(failed?.error).toContain('network error')
    expect(library.uploadSummary.failed).toBe(1)
  })

  it('⑥ 秒传命中（云端已有同一份字节）⇒ 任务 skipped，不发上传请求', async () => {
    const { library } = await setup()
    const localHash = await sha256Hex(LOCAL_BYTES)
    apiMock.books.list.mockResolvedValue({
      items: [
        {
          id: 'cloud-existing',
          title: '云端已有',
          author: '',
          format: 'epub',
          contentHash: 'sha256:' + localHash,
          sizeBytes: 8,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    })

    const book = library.books.find((b) => b.id === 'local-1')!
    const ok = await library.uploadToCloud(book)

    expect(ok).toBe(true)
    expect(apiMock.books.uploadFile).not.toHaveBeenCalled()
    expect(library.uploadTasks.find((t) => t.bookId === 'local-1')?.state).toBe('skipped')
  })

  it('⑦ 重试：失败的书可以再传一次并转成 done', async () => {
    const { library } = await setup()
    apiMock.books.list.mockResolvedValue({ items: [] })
    apiMock.books.uploadFile.mockRejectedValueOnce(new Error('boom'))

    const book = library.books.find((b) => b.id === 'local-1')!
    await library.uploadToCloud(book)
    expect(library.uploadTasks.find((t) => t.bookId === 'local-1')?.state).toBe('failed')

    apiMock.books.uploadFile.mockResolvedValue({ status: 201, body: { contentHash: 'x', sizeBytes: 8 } })
    const ok = await library.retryUpload('local-1')

    expect(ok).toBe(true)
    expect(library.uploadTasks.find((t) => t.bookId === 'local-1')?.state).toBe('done')
  })

  it('⑧ 清掉已结束的任务（面板的"知道了"）', async () => {
    const { library } = await setup()
    apiMock.books.list.mockResolvedValue({ items: [] })
    const book = library.books.find((b) => b.id === 'local-1')!
    await library.uploadToCloud(book)
    expect(library.uploadTasks.length).toBe(1)

    library.clearFinishedUploads()
    expect(library.uploadTasks.length).toBe(0)
  })

  it('⑨ 下载大书也能取消（下载同样可能卡住）', async () => {
    const { library } = await setup()
    apiMock.books.list.mockResolvedValue({
      items: [
        {
          id: 'cloud-1',
          title: '云端书',
          author: '',
          format: 'epub',
          contentHash: 'sha256:' + 'f'.repeat(64),
          sizeBytes: 8,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    })
    await library.refreshCloud()
    let aborted = false
    apiMock.books.getFileBytes.mockImplementation(
      async (_id: string, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )

    const promise = library.downloadCloud('cloud-1')
    await vi.waitFor(() => expect(apiMock.books.getFileBytes).toHaveBeenCalled())
    library.cancelDownload()
    const record = await promise

    expect(record).toBeNull()
    expect(aborted).toBe(true)
  })
})
