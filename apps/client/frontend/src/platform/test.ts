import type {
  AppInfo,
  BookRecord,
  ImportBookResult,
  OpenBookPayload,
  Platform,
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
    // ---- 测试专用钩子 ----
    emitSyncStatus(next: Partial<SyncStatus>): void {
      emitSyncStatus(next)
    },
    emitLibraryChanged(bookId: string | null): void {
      emitChange(bookId)
    },
  }
}
