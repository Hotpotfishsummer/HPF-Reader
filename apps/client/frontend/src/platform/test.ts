import type {
  AppInfo,
  BookRecord,
  ImportBookResult,
  OpenBookPayload,
  Platform,
  ProxyConfig,
  SyncStatus,
} from './types'

export interface TestPlatformOptions {
  books?: BookRecord[]
  bytes?: Record<string, Uint8Array>
  syncStatus?: Partial<SyncStatus>
  info?: Partial<AppInfo>
}

/** 测试平台额外暴露一个"推状态"的钩子，方便断言 UI 对同步事件的反应。 */
export interface TestPlatform extends Platform {
  emitSyncStatus(next: Partial<SyncStatus>): void
  emitLibraryChanged(bookId: string | null): void
}

/** 测试平台的 sha256（有 WebCrypto 用真的，否则退化为确定性 FNV-1a，仅测试用）。 */
async function sha256HexForTest(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes.slice().buffer)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i] as number
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').repeat(8)
}

/**
 * 测试/故事书平台实现：E2E 与组件测试注入它，从而不需要启动 Go 侧。
 * 它也是"平台抽象层真的可替换"的证明。
 */
export function createTestPlatform(options: TestPlatformOptions = {}): TestPlatform {
  const books = new Map<string, BookRecord>((options.books ?? []).map((b) => [b.id, b]))
  const bytes = new Map<string, Uint8Array>(Object.entries(options.bytes ?? {}))
  const progress = new Map<string, string>()
  const changeListeners = new Set<(bookId: string | null) => void>()
  const statusListeners = new Set<(status: SyncStatus) => void>()
  let status: SyncStatus = {
    phase: 'idle',
    pendingCount: 0,
    lastSyncedAt: null,
    lastError: null,
    ...options.syncStatus,
  }

  function emitChange(bookId: string | null): void {
    for (const listener of changeListeners) listener(bookId)
  }

  function emitSyncStatus(next: Partial<SyncStatus>): void {
    status = { ...status, ...next }
    for (const listener of statusListeners) listener(status)
  }

  return {
    kind: 'test',
    capabilities: ['library.local', 'sync.outbox'],
    // 测试平台没有本机 Go 中继：直接用注入的 fetch（E2E 拦截网络即可）。
    async resolveApiTransport() {
      return null
    },
    files: {
      async importBookFromDialog(): Promise<ImportBookResult | null> {
        return null
      },
      async readBookBytes(bookId: string): Promise<Uint8Array> {
        return bytes.get(bookId) ?? new Uint8Array()
      },
    },
    library: {
      async listBooks(): Promise<BookRecord[]> {
        return [...books.values()]
      },
      async openBook(bookId: string): Promise<OpenBookPayload> {
        const book = books.get(bookId)
        if (!book) throw new Error(`book ${bookId} not found`)
        return { book, bytes: bytes.get(bookId) ?? new Uint8Array() }
      },
      async deleteBook(bookId: string): Promise<void> {
        books.delete(bookId)
        emitChange(bookId)
      },
      async saveProgress(bookId: string, locator: string): Promise<void> {
        progress.set(bookId, locator)
      },
      async getProgress(bookId: string): Promise<string> {
        return progress.get(bookId) ?? ''
      },
      async importBookBytes(input): Promise<BookRecord> {
        const data = input.bytes ?? new Uint8Array()
        if (data.byteLength === 0) throw new Error('book data is empty')
        const name = (input.name ?? '').trim() || (input.title ?? '').trim()
        if (name === '') throw new Error('book name is empty')
        const hash = await sha256HexForTest(data)
        const id = hash.slice(0, 16)
        // 与 Go 侧一致：同一份内容重复导入返回已有条目。
        const existing = books.get(id)
        if (existing) return existing
        const ext = (input.format || name.split('.').pop() || 'epub').toLowerCase().replace(/^\./, '')
        const record: BookRecord = {
          id,
          title: (input.title ?? '').trim() || name.replace(/\.[^.]+$/, ''),
          author: (input.author ?? '').trim(),
          format: ext,
          contentHash: hash,
          sizeBytes: data.byteLength,
          addedAt: new Date().toISOString(),
        }
        books.set(id, record)
        bytes.set(id, data)
        emitChange(id)
        return record
      },
      onChanged(listener) {
        changeListeners.add(listener)
        return () => changeListeners.delete(listener)
      },
    },
    sync: {
      async status(): Promise<SyncStatus> {
        return status
      },
      onStatus(listener) {
        statusListeners.add(listener)
        listener(status)
        return () => statusListeners.delete(listener)
      },
    },
    system: {
      async info(): Promise<AppInfo> {
        return {
          platform: 'test',
          version: '0.0.0-test',
          dataDir: '/tmp/hpf-reader-test',
          ...options.info,
        }
      },
      async openExternal(): Promise<void> {
        /* no-op in tests */
      },
    },
    window: {
      hasControls: false,
      isMacTrafficLights: false,
      async minimize() {},
      async toggleMaximize() {},
      async close() {},
      async isMaximized() {
        return false
      },
      async toggleFullscreen() {},
      async isFullscreen() {
        return false
      },
    },
    browser: {
      async openURL(): Promise<void> {},
      async close(): Promise<void> {},
    },
    proxy: {
      async getConfig() {
        return { enabled: false, type: 'http', host: '127.0.0.1', port: 7890 }
      },
      async saveConfig() {},
      async testProxy() {
        return { success: true, latencyMs: 50, message: '测试成功' }
      },
      async detectSystemProxy(): Promise<ProxyConfig> {
        return { enabled: true, type: 'http', host: '127.0.0.1', port: 7890 }
      },
    },
    downloads: {
      async listDownloads() {
        return []
      },
      async startDownload(url: string, filename?: string) {
        return {
          id: 'test-dl-1',
          url,
          filename: filename || 'test.epub',
          sizeBytes: 1024,
          status: 'completed',
          downloadedAt: new Date().toISOString(),
          filePath: '/tmp/test.epub',
        }
      },
      async importToLibrary(filename: string) {
        const dummy: BookRecord = {
          id: 'imported-1',
          title: filename,
          author: '',
          format: 'epub',
          contentHash: 'hash-imported',
          sizeBytes: 1024,
          addedAt: new Date().toISOString(),
        }
        books.set(dummy.id, dummy)
        emitChange(dummy.id)
        return dummy
      },
      async openDownloadsFolder() {},
      async deleteDownload() {},
    },
    // ---- 测试专用钩子 ----
    emitSyncStatus(next: Partial<SyncStatus>): void {
      emitSyncStatus(next)
    },
    emitLibraryChanged(bookId: string | null): void {
      emitChange(bookId)
    },
  }
}
