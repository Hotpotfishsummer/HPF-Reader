import { markRaw } from 'vue'
import type { BookRecord, OpenBookPayload } from '@/platform/types'

/**
 * 书库 / 本地文件 -> 阅读页 的交接缓存。
 *
 * 为什么不放 Pinia：payload 里有 **Uint8Array**。放进去会被深度 reactive 包成 Proxy，
 * 而 TypedArray 被 Proxy 包裹后，foliate-js / zip.js 里的 `new Blob([bytes])`、
 * `byteLength` 读取都会出现身份与内部槽不一致的问题（与 DOM Range 同类陷阱）。
 * 所以这里就是一个普通 Map，不进任何响应式系统。
 */
interface SessionEntry {
  payload: OpenBookPayload
  createdAt: number
}

const sessions = new Map<string, SessionEntry>()

/**
 * 只存在于内存、**不在任何后端**里的书（内置示例书、直接打开的本地文件）。
 *
 * 用途：Web/服务端模式下，这些书在服务端根本不存在，去查/去写进度只会得到 404。
 * 有了这个集合，本地优先的书在 Web 模式下是**零网络请求**的。
 * 桌面模式下不需要它（Go 的本地书库对任何 id 都能存进度）。
 */
const localOnly = new Set<string>()

export function rememberBook(payload: OpenBookPayload): void {
  sessions.set(payload.book.id, {
    // markRaw 只影响"将来被放进响应式结构"时；这里本来就不放，双保险。
    payload: markRaw(payload),
    createdAt: Date.now(),
  })
}

/** 内置示例书也是"本地专属"：服务端没有 'sample' 这个 id。 */
export const SAMPLE_BOOK_ID = 'sample'

export function getRememberedBook(bookId: string): OpenBookPayload | null {
  const entry = sessions.get(bookId)
  return entry ? entry.payload : null
}

export function forgetBook(bookId: string): void {
  sessions.delete(bookId)
}

/** 测试用：清空会话缓存。 */
export function clearBookSessions(): void {
  sessions.clear()
  localOnly.clear()
}

/** 这本书是否"只存在于本地"（示例书 / 直接打开的本地文件）。 */
export function isLocalOnlyBook(bookId: string): boolean {
  return localOnly.has(bookId)
}

/**
 * ★ 与 Go 侧 `LibraryService.ImportBook` **完全一致**的书 id 规则：
 *   `sha256(文件字节)` 的十六进制表示取前 16 个字符。
 *
 * 为什么必须一致：本地打开的同一本书，无论走"入库"还是走"直接打开本地文件"，
 * 都要命中**同一条**阅读进度记录。id 一样，进度 key 就一样 —— 用户在网页版里
 * 直接打开过的书，装到桌面版导入后仍然能续读。
 *
 * 没有 WebCrypto 时（极老的 WebView / 非安全上下文）退化成带 `local-` 前缀的
 * 非加密哈希：前缀保证它**永远不会**和 Go 侧的真实 id 撞车，宁可续读失效，
 * 也不能张冠李戴地把另一本书的进度套上来。
 */
export async function contentId(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    try {
      // 复制到独立的 ArrayBuffer：避免把调用方的 buffer 交给浏览器后又被复用。
      const copy = bytes.slice().buffer
      const digest = await subtle.digest('SHA-256', copy)
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
      return hex.slice(0, 16)
    } catch (error) {
      console.warn('[bookSession] SHA-256 不可用，退化为本地 id', error)
    }
  }
  return `local-${fnv1aHex(bytes)}`
}

/** 非加密哈希，只用于"没有 WebCrypto"时的本地兜底。 */
function fnv1aHex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  // 大文件不必全量扫描：首尾各取 64KB + 长度已经足够区分本地文件。
  const step = bytes.length > 128 * 1024 ? 1 : 1
  for (let i = 0; i < bytes.length; i += step) {
    hash ^= bytes[i] as number
    hash = Math.imul(hash, 0x01000193)
  }
  hash ^= bytes.length
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * ★ 直接把本地文件交给阅读器（不进书库），用于"打开本地文件 / 拖拽 EPUB"。
 *
 * 与 `rememberBook` 的区别：这个不来自 platform 的 library，只活在当前会话的内存里，
 * 因此**不需要任何后端**就能阅读。装进同一个 sessions map，阅读页不需要区分来源。
 */
export function rememberLocalFile(input: {
  id: string
  name: string
  bytes: Uint8Array
  sizeBytes: number
}): OpenBookPayload {
  const book: BookRecord = {
    id: input.id,
    title: input.name.replace(/\.[^.]+$/, ''),
    author: '',
    format: (input.name.split('.').pop() ?? 'epub').toLowerCase(),
    contentHash: input.id,
    sizeBytes: input.sizeBytes,
    addedAt: new Date().toISOString(),
  }
  const payload: OpenBookPayload = { book, bytes: input.bytes }
  rememberBook(payload)
  localOnly.add(input.id)
  return payload
}
