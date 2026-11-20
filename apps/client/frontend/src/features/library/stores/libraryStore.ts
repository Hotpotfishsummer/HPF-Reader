import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { usePlatform, type BookRecord } from '@/platform'
import { getApi } from '@/api'
import { ApiError } from '@/api/client'
import type { BookCreate, BookDto } from '@/api/contract'
import { getRememberedBook, sha256Hex } from '@/reader/bookSession'
import { useAuthStore } from '@/stores/auth'

/**
 * 书库 UI 状态。
 *
 * 状态分层（docs/research/50-vue3-reader-stack.md §3.1）：
 *   - 服务端权威数据（远端书库列表）→ TanStack Query；
 *   - **本地**书库条目（Wails 桌面把书存在本机）→ 这里（Pinia，因为它是本地真相）；
 *   - 阅读进度 → 不进 Pinia（是同步实体）。
 *
 * 注意：BookRecord 是纯值对象，可以安全放进响应式系统。
 *
 * 云书库（task-5）：
 *   - 本地书 id = sha256(字节) 前 16 位；服务端书 id 是 UUID。
 *   - 两边唯一可靠的连接键是 **contentHash**（服务端写成 `sha256:<hex>`，
 *     本地只存裸 hex），因此随手统一成裸 hex（normalizeContentHash）。
 */

/** 服务端 contentHash 形如 `sha256:<hex>`；本地只存裸 hex。 */
export const HASH_PREFIX = 'sha256:'

/** 归一化内容哈希：去前缀、转小写、去空白。空值返回空串（调用方自行判空）。 */
export function normalizeContentHash(hash: string | null | undefined): string {
  const value = (hash ?? '').trim().toLowerCase()
  return value.startsWith(HASH_PREFIX) ? value.slice(HASH_PREFIX.length) : value
}

/** 云端书库错误用结构化 code 表示，翻译交给视图层（store 不 import i18n）。 */
export type CloudErrorCode = 'need-login' | 'hash-mismatch' | 'unsupported' | 'failed' | 'no-file'

export interface CloudError {
  code: CloudErrorCode
  /** 仅 code === 'failed' 时有意义（原始错误信息）。 */
  message?: string
}

/**
 * 单本上传任务的状态。
 *
 * ★ 为什么要显式的任务列表：上传是"长耗时 + 可能失败 + 可能要重试"的典型操作，
 *   只有一个 loading 布尔值的话，用户只能盯着一个变灰的按钮猜进度。
 */
export type UploadTaskState =
  /** 排队中（还没开始）。 */
  | 'pending'
  /** 准备中（读字节 / 算 sha256）。 */
  | 'preparing'
  /** 正在上传（已有字节进展）。 */
  | 'uploading'
  /** 已完成。 */
  | 'done'
  /** 云端已经有这份字节（秒传命中，无需再传）。 */
  | 'skipped'
  /** 失败（带原因，可重试）。 */
  | 'failed'
  /** 被用户取消。 */
  | 'canceled'

export interface UploadTask {
  bookId: string
  title: string
  /** 文件字节数（未知时 0）。 */
  sizeBytes: number
  state: UploadTaskState
  /** 已传字节数。 */
  loaded: number
  /** 总字节数（未知时 0）。 */
  total: number
  /** 当前速度（字节/秒，EMA 平滑）。 */
  bytesPerSecond: number
  /** 本次上传的开始时刻（用于算平均速度）。 */
  startedAt: number
  /** 失败原因（人类可读，来自服务端或网络层）。 */
  error?: string
  /** 失败分类（'stall_timeout' / 'network_error' / 'canceled' / 服务端 code …）。 */
  errorCode?: string
}

/** 上传任务的展示汇总（视图层用它渲染顶部进度条）。 */
export interface UploadSummary {
  total: number
  done: number
  failed: number
  running: boolean
}

const CLOUD_PAGE_LIMIT = 200

type BookFormat = NonNullable<BookCreate['format']>
const KNOWN_FORMATS: readonly string[] = ['epub', 'pdf', 'txt', 'mobi', 'azw3', 'fb2', 'cbz']

function toBookFormat(raw: string | null | undefined): BookFormat {
  const value = (raw ?? '').trim().toLowerCase()
  return (KNOWN_FORMATS.includes(value) ? value : 'epub') as BookFormat
}

/** 服务端 Book -> 书库视图模型（contentHash 归一化为裸 hex）。 */
function toCloudRecord(dto: BookDto): BookRecord {
  return {
    id: dto.id,
    title: dto.title,
    author: dto.author ?? '',
    format: (dto.format ?? '').toLowerCase(),
    contentHash: normalizeContentHash(dto.contentHash),
    sizeBytes: dto.sizeBytes ?? 0,
    addedAt: dto.createdAt ?? dto.updatedAt ?? '',
  }
}

/**
 * ★ 云端条目是否**真的带了文件**。
 *
 * 服务端的 `books.file_size` 只有在文件字节落盘并挂载（AttachBookFile）之后才 > 0；
 * 只建了元数据、没上传（或上传失败）的书，`sizeBytes` 是 0。
 * 客户端必须用这个判据区分"云端有这本书"和"云端有这本书的文件"：
 *
 *   - 没有文件却画"下载"按钮 ⇒ 用户一点就撞 404 "book file has not been uploaded yet"；
 *   - 没有文件却被当成"已上传" ⇒ 重试永远传不上去（书被永久卡住）。
 */
export function hasCloudFile(book: BookRecord): boolean {
  return book.sizeBytes > 0
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 从异常里取结构化 code（ApiError.code / AbortError → 'canceled'）。 */
function errorCodeOf(cause: unknown): string {
  if (cause instanceof ApiError) return cause.code
  if (cause instanceof DOMException && cause.name === 'AbortError') return 'canceled'
  if (cause instanceof Error && cause.name === 'AbortError') return 'canceled'
  return 'failed'
}

/** 上传一批书时的可选项（批量只查一次云端列表，避免 N+1 请求）。 */
export interface UploadRunOptions {
  /** 已取到的云端列表（批量上传时复用，省掉每本一次 list）。 */
  remoteBooks?: BookRecord[]
}

export const useLibraryStore = defineStore('library', () => {
  const platform = usePlatform()
  const auth = useAuthStore()

  const books = shallowRef<BookRecord[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** 云端书库（服务端权威列表的快照）。 */
  const cloudBooks = shallowRef<BookRecord[]>([])
  const cloudLoading = ref(false)
  const cloudError = ref<CloudError | null>(null)
  /** 正在下载的云端书 id（UI 逐条禁用按钮）。 */
  const downloadingId = ref<string | null>(null)
  /** 下载进度（字节）。null = 当前没有下载。 */
  const downloadProgress = ref<{ bookId: string; loaded: number; total: number } | null>(null)
  /** 当前下载的取消器。 */
  let downloadController: AbortController | null = null
  /** 正在上传的本地书 id。 */
  const uploadingId = ref<string | null>(null)
  /**
   * ★ 本次会话里**直接打开、但没进本地书库索引**的文件（文件选择器 / 拖拽）。
   *
   * 它们必须出现在书库网格里，否则用户在这条路径上**完全看不到上传入口**
   * （这是"客户端找不到书籍上传 UI"的一个主要来源）。
   * 字节留在 reader/bookSession 的内存缓存里，上传时直接取用，不落盘。
   */
  const sessionBooks = shallowRef<BookRecord[]>([])

  /** 登记一本"本次会话打开的书"。 */
  function registerSessionBook(book: BookRecord): void {
    if (sessionBooks.value.some((b) => b.id === book.id)) return
    sessionBooks.value = [...sessionBooks.value, book]
  }

  /** 书库网格要展示的全部条目：本地书库 + 本次会话打开的书（按 id 去重）。 */
  const displayBooks = computed<BookRecord[]>(() => {
    const seen = new Set<string>()
    const out: BookRecord[] = []
    for (const book of [...books.value, ...sessionBooks.value]) {
      if (seen.has(book.id)) continue
      seen.add(book.id)
      out.push(book)
    }
    return out
  })

  const isEmpty = computed(() => !loading.value && displayBooks.value.length === 0)
  const count = computed(() => books.value.length)
  const cloudCount = computed(() => cloudBooks.value.length)

  /** 本地是否已有同内容哈希的书（本地书库条目 vs 云端条目的连接键）。 */
  function localHasHash(hash: string | null | undefined): boolean {
    return localBookByHash(hash) !== null
  }

  /**
   * 找出本地与该 contentHash 相同的书（书库条目或本次会话里打开的书）。
   *
   * 用途：云端有条目却"文件未上传"时，用它给用户一个"补传"入口 ——
   * 否则那条会永远卡在"文件未上传"状态（既不能下载，也没人能补传）。
   */
  function localBookByHash(hash: string | null | undefined): BookRecord | null {
    const want = normalizeContentHash(hash)
    if (want === '') return null
    return (
      books.value.find((b) => normalizeContentHash(b.contentHash) === want) ??
      sessionBooks.value.find((b) => normalizeContentHash(b.contentHash) === want) ??
      null
    )
  }

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      // shallowRef + 整体替换：不做深层 reactive，避免将来有人往里面塞二进制。
      books.value = await platform.library.listBooks()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  async function importBook(): Promise<BookRecord | null> {
    loading.value = true
    error.value = null
    try {
      const result = await platform.files.importBookFromDialog()
      if (!result) return null
      await refresh()
      return result.book
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    } finally {
      loading.value = false
    }
  }

  async function removeBook(bookId: string): Promise<void> {
    await platform.library.deleteBook(bookId)
    books.value = books.value.filter((b) => b.id !== bookId)
  }

  /**
   * 拉取云端书库。**未登录时零请求**（UI 显示 cloudNeedLogin），
   * 也不把它当成错误 —— 未登录是正常状态。
   */
  async function refreshCloud(): Promise<void> {
    if (!auth.isAuthenticated) {
      cloudBooks.value = []
      cloudError.value = null
      return
    }
    cloudLoading.value = true
    cloudError.value = null
    try {
      const page = await getApi().books.list({ limit: CLOUD_PAGE_LIMIT })
      cloudBooks.value = (page.items ?? []).map(toCloudRecord)
    } catch (cause) {
      cloudError.value = { code: 'failed', message: messageOf(cause) }
    } finally {
      cloudLoading.value = false
    }
  }

  /**
   * 读取本地书籍的原始字节。
   *
   * 两条来源：
   *   1. **本次会话直接打开的文件**（文件选择器 / 拖拽）—— 它们没进本地书库索引，
   *      但字节还在内存里（reader/bookSession.ts），必须能上传，否则用户在这条路径上
   *      根本找不到任何上传入口。
   *   2. **本地书库里的书** —— 走 platform 读盘。
   */
  async function readLocalBytes(book: BookRecord): Promise<Uint8Array> {
    const remembered = getRememberedBook(book.id)
    if (remembered?.bytes && remembered.bytes.byteLength > 0) return remembered.bytes
    // ★ 直接读字节，不走 openBook()：
    //   openBook 会先 listBooks()（把整个本地书库索引读一遍）再读字节 ——
    //   批量上传时这是纯浪费（每本书多一次全量索引 IPC）。
    const bytes = await platform.files.readBookBytes(book.id)
    if (!bytes || bytes.byteLength === 0) throw new Error('无法读取书籍文件')
    return bytes
  }

  /**
   * 上传本地书到云端；完成返回 true，失败/未登录返回 false 并把原因写进 cloudError。
   *
   * ★ 幂等判据是「同 contentHash **且**云端确实有文件」：
   *   服务端在 POST /v1/books 时就把客户端声明的 contentHash 写进了 books.file_hash，
   *   但那时文件还没上传（file_size 仍是 0）。如果只看 contentHash 就判定"已上传"，
   *   一旦上一次上传失败，这本书就**永远传不上去**（而且再建一本会撞
   *   books_user_hash_idx 唯一索引 → 409）。
   *   所以：同哈希但没有文件 ⇒ 复用那本书的 id 继续 PUT，而不是新建。
   *
   * ★ 全程有进度与可取消：上传大书动辄几分钟，没有进度用户就只能盯着灰按钮干等。
   */
  async function uploadToCloud(book: BookRecord, options: UploadRunOptions = {}): Promise<boolean> {
    cloudError.value = null
    if (!auth.isAuthenticated) {
      cloudError.value = { code: 'need-login' }
      setTask(book, { state: 'failed', errorCode: 'need-login', error: 'need-login' })
      return false
    }
    setTask(book, { state: 'preparing', loaded: 0, total: 0, bytesPerSecond: 0 })
    uploadingId.value = book.id
    const controller = new AbortController()
    uploadController = controller
    try {
      const bytes = await readLocalBytes(book)
      setTask(book, { total: bytes.byteLength, sizeBytes: bytes.byteLength })
      const hash = await sha256Hex(bytes)
      if (controller.signal.aborted) {
        setTask(book, { state: 'canceled', errorCode: 'canceled' })
        return false
      }
      const api = getApi()

      // ★ 先查云端已有同 contentHash 的条目（批量上传时只查一次，见 uploadAllToCloud）。
      const remote = options.remoteBooks ?? (await api.books.list({ limit: CLOUD_PAGE_LIMIT })).items?.map(toCloudRecord) ?? []
      if (options.remoteBooks === undefined) cloudBooks.value = remote
      const sameHash = remote.find((b) => b.contentHash === hash)
      if (sameHash && hasCloudFile(sameHash)) {
        // 云端已有这份字节：秒传命中，不需要再传。
        setTask(book, { state: 'skipped', loaded: bytes.byteLength, total: bytes.byteLength })
        return true
      }

      // 云端已有同哈希但**没有文件**（上次上传失败）：复用它的 id 重传，
      // 新建会撞 (user_id, file_hash) 唯一索引。
      const target = sameHash
        ? sameHash.id
        : (
            await api.books.create({
              title: book.title || book.id,
              author: book.author || undefined,
              format: toBookFormat(book.format),
              contentHash: HASH_PREFIX + hash,
            })
          ).id
      setTask(book, { state: 'uploading' })
      await api.books.uploadFile(target, hash, bytes, {
        signal: controller.signal,
        onProgress: (p) => {
          const current = uploadTasks.value.find((t) => t.bookId === book.id)
          if (!current) return
          const now = Date.now()
          const elapsed = now - current.startedAt
          const instant = elapsed > 0 ? (p.loaded * 1000) / elapsed : 0
          // ★ 就地修改任务对象（ref 是深度响应式 ⇒ 会触发进度条重绘）。
          current.loaded = p.loaded
          current.total = p.total ?? bytes.byteLength
          // EMA 平滑：瞬时速度抖动很大，直接显示会让进度条看起来在抽搐。
          current.bytesPerSecond =
            current.bytesPerSecond > 0
              ? current.bytesPerSecond * 0.7 + instant * 0.3
              : instant
        },
      })
      setTask(book, { state: 'done', loaded: bytes.byteLength, total: bytes.byteLength })
      // 让调用方（批量上传）手里的云端快照保持准确：刚传完的这本已经有文件了。
      if (options.remoteBooks) {
        const record: BookRecord = {
          id: target,
          title: book.title || book.id,
          author: book.author || '',
          format: book.format || 'epub',
          contentHash: hash,
          sizeBytes: bytes.byteLength,
          addedAt: '',
        }
        const idx = options.remoteBooks.findIndex((b) => b.id === target)
        if (idx >= 0) options.remoteBooks[idx] = record
        else options.remoteBooks.push(record)
      } else {
        await refreshCloud()
      }
      return true
    } catch (cause) {
      const code = errorCodeOf(cause)
      const canceled = code === 'canceled'
      setTask(book, {
        state: canceled ? 'canceled' : 'failed',
        errorCode: code,
        error: messageOf(cause),
      })
      if (!canceled) cloudError.value = { code: 'failed', message: messageOf(cause) }
      return false
    } finally {
      uploadingId.value = null
      if (uploadController === controller) uploadController = null
    }
  }

  /**
   * 下载云端书籍并入库。
   *
   * 四道闸门：
   *   1. 未登录 / 平台没有 `library.local` → 直接拒绝，不发请求；
   *   2. **云端条目没有文件**（只建了元数据、上传失败或还没开始传）→ 直接拒绝，
   *      不发那个注定 404 的请求（服务端会回 "book file has not been uploaded yet"）；
   *   3. **前端重算 sha256 并与云端 contentHash 比对**，不一致拒绝入库（cloudHashMismatch）；
   *   4. 通过 platform.library.importBookBytes 交给 Go 侧（服务端 UUID 不进本地 id 空间）。
   *
   * 返回入库后的本地记录；被拒绝时返回 null，并把原因写进 cloudError。
   */
  async function downloadCloud(bookId: string): Promise<BookRecord | null> {
    cloudError.value = null
    if (!auth.isAuthenticated) {
      cloudError.value = { code: 'need-login' }
      return null
    }
    if (!platform.capabilities.includes('library.local')) {
      cloudError.value = { code: 'unsupported', message: '当前平台没有本地书库（library.local）' }
      return null
    }
    downloadingId.value = bookId
    const controller = new AbortController()
    downloadController = controller
    try {
      const api = getApi()
      let entry = cloudBooks.value.find((b) => b.id === bookId) ?? null
      if (!entry) {
        entry = toCloudRecord(await api.books.get(bookId))
      }

      // ★ 先看云端到底有没有文件：没有就别去撞 404。
      if (!hasCloudFile(entry)) {
        cloudError.value = { code: 'no-file', message: '云端条目没有文件（上传未完成）' }
        return null
      }

      const bytes = await api.books.getFileBytes(bookId, {
        signal: downloadController?.signal,
        onProgress: (p) => {
          downloadProgress.value = {
            bookId,
            loaded: p.loaded,
            total: p.total ?? entry.sizeBytes ?? 0,
          }
        },
      })
      downloadProgress.value = null
      if (bytes.byteLength === 0) throw new Error('云端文件为空')

      const hash = await sha256Hex(bytes)
      if (entry.contentHash && hash !== entry.contentHash) {
        // 传输损坏 / 服务端串了对象：宁可拒绝，也不能把错误内容写进本地书库。
        cloudError.value = {
          code: 'hash-mismatch',
          message: 'sha256:' + hash + ' != ' + HASH_PREFIX + entry.contentHash,
        }
        return null
      }
      const ext = toBookFormat(entry.format)
      const record = await platform.library.importBookBytes({
        name: (entry.title || 'cloud-book') + '.' + ext,
        title: entry.title || undefined,
        author: entry.author || undefined,
        format: ext,
        bytes,
      })
      await refresh()
      return record
    } catch (cause) {
      cloudError.value = { code: 'failed', message: messageOf(cause) }
      return null
    } finally {
      downloadingId.value = null
      downloadProgress.value = null
      if (downloadController === controller) downloadController = null
    }
  }

  /** 取消当前下载（下载大书同样可能卡住，必须给用户一个出口）。 */
  function cancelDownload(): void {
    downloadController?.abort()
  }

  /**
   * 上传任务列表（顶部进度面板的数据源）。
   *
   * ★ 放在 store 里而不是组件里：上传是跨页面/跨组件的状态
   *   （用户可能切到"发现"页再切回来），组件内的局部状态会丢。
   *
   * ★ 用 ref（深度响应式）而不是 shallowRef：进度是**就地修改**任务对象的字段
   *   （loaded / total / bytesPerSecond），shallowRef 下这类修改不会触发重渲染
   *   ⇒ 进度条会永远停在 0。任务对象很小，深度响应式的开销可以忽略。
   */
  const uploadTasks = ref<UploadTask[]>([])
  /** 当前上传的取消器（用户点"取消"时 abort）。 */
  let uploadController: AbortController | null = null

  /** 新建/更新一本书的上传任务（整体替换数组项，保证触发响应式更新）。 */
  function setTask(book: BookRecord, patch: Partial<UploadTask>): UploadTask {
    const existing = uploadTasks.value.find((t) => t.bookId === book.id)
    const next: UploadTask = existing
      ? { ...existing, ...patch }
      : {
          bookId: book.id,
          title: book.title || book.id,
          sizeBytes: book.sizeBytes ?? 0,
          state: 'pending',
          loaded: 0,
          total: 0,
          bytesPerSecond: 0,
          startedAt: Date.now(),
          ...patch,
        }
    uploadTasks.value = existing
      ? uploadTasks.value.map((t) => (t.bookId === book.id ? next : t))
      : [...uploadTasks.value, next]
    return next
  }

  /** 是否还有上传在进行。 */
  const uploadRunning = computed(() =>
    uploadTasks.value.some((t) => t.state === 'uploading' || t.state === 'preparing'),
  )

  /** 顶部进度条用的汇总。 */
  const uploadSummary = computed<UploadSummary>(() => {
    const total = uploadTasks.value.length
    const done = uploadTasks.value.filter((t) => t.state === 'done' || t.state === 'skipped').length
    const failed = uploadTasks.value.filter((t) => t.state === 'failed').length
    return { total, done, failed, running: uploadRunning.value }
  })

  /** 取消当前上传（用户在顶部面板点"取消"）。 */
  function cancelUpload(): void {
    uploadController?.abort()
  }

  /** 清掉已结束的任务（用户点了"知道了"）。 */
  function clearFinishedUploads(): void {
    uploadTasks.value = uploadTasks.value.filter(
      (t) => t.state === 'uploading' || t.state === 'preparing',
    )
  }

  /** 重试一本失败的书。 */
  async function retryUpload(bookId: string): Promise<boolean> {
    const book = displayBooks.value.find((b) => b.id === bookId)
    if (!book) return false
    return uploadToCloud(book)
  }

  /**
   * 批量把本地书传到云端（书库工具栏的"上传到云端"）。
   *
   * ★ 串行执行：一次只传一本（本地 → 远端，串行最省带宽，也最不容易撞服务端限流）。
   * ★ 失败不打断后面的：每本一个任务，失败原因记在**任务**上，不会被后面的成功冲掉。
   * ★ 云端列表**只查一次**（原来每本都 list 一遍，N+1 请求）。
   */
  async function uploadAllToCloud(): Promise<{ uploaded: number; failed: number }> {
    if (!auth.isAuthenticated) {
      cloudError.value = { code: 'need-login' }
      return { uploaded: 0, failed: 0 }
    }
    const books = displayBooks.value.slice()
    if (books.length === 0) return { uploaded: 0, failed: 0 }

    // 先把任务排好（UI 立刻能看到"排队中"），再开始传。
    uploadTasks.value = books.map((book) => ({
      bookId: book.id,
      title: book.title || book.id,
      sizeBytes: book.sizeBytes ?? 0,
      state: 'pending',
      loaded: 0,
      total: 0,
      bytesPerSecond: 0,
      startedAt: Date.now(),
    }))

    let uploaded = 0
    let failed = 0
    let firstError: CloudError | null = null
    let remote: BookRecord[] = []
    try {
      const page = await getApi().books.list({ limit: CLOUD_PAGE_LIMIT })
      remote = (page.items ?? []).map(toCloudRecord)
      cloudBooks.value = remote
    } catch (cause) {
      const message = messageOf(cause)
      cloudError.value = { code: 'failed', message }
      firstError = cloudError.value
      for (const book of books) {
        setTask(book, { state: 'failed', errorCode: 'failed', error: message })
      }
      return { uploaded: 0, failed: books.length }
    }

    for (const book of books) {
      const ok = await uploadToCloud(book, { remoteBooks: remote })
      if (ok) {
        uploaded += 1
      } else {
        failed += 1
        if (firstError === null) firstError = cloudError.value
      }
    }
    if (firstError !== null) cloudError.value = firstError
    // 整批结束后统一刷新一次云端列表（每本传完都刷会变成 N+1 请求）。
    try {
      await refreshCloud()
    } catch {
      /* 刷新失败不影响上传结果 */
    }
    return { uploaded, failed }
  }

  return {
    books,
    loading,
    error,
    isEmpty,
    count,
    cloudBooks,
    cloudLoading,
    cloudError,
    cloudCount,
    downloadingId,
    downloadProgress,
    cancelDownload,
    uploadingId,
    sessionBooks,
    displayBooks,
    registerSessionBook,
    refresh,
    importBook,
    removeBook,
    localHasHash,
    localBookByHash,
    refreshCloud,
    uploadToCloud,
    uploadAllToCloud,
    uploadTasks,
    uploadRunning,
    uploadSummary,
    cancelUpload,
    clearFinishedUploads,
    retryUpload,
    downloadCloud,
  }
})
