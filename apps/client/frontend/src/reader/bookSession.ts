import { markRaw } from 'vue'
import type { OpenBookPayload } from '@/platform/types'

/**
 * 书库 -> 阅读页 的交接缓存。
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

export function rememberBook(payload: OpenBookPayload): void {
  sessions.set(payload.book.id, {
    // markRaw 只影响"将来被放进响应式结构"时；这里本来就不放，双保险。
    payload: markRaw(payload),
    createdAt: Date.now(),
  })
}

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
}
