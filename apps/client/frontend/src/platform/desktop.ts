import { Events } from '@wailsio/runtime'
import * as AppService from '../../bindings/github.com/hotpotfish/hpfreader/client/appservice'
import * as LibraryService from '../../bindings/github.com/hotpotfish/hpfreader/client/libraryservice'
import type { BookSummary } from '../../bindings/github.com/hotpotfish/hpfreader/client/models'
import { LibraryChanged } from '../../bindings/events'
import type {
  AppInfo,
  BookRecord,
  ImportBookResult,
  OpenBookPayload,
  Platform,
  SyncStatus,
} from './types'

/**
 * ⚠️ 本文件是前端**唯一**允许 import Wails 生成 bindings 的桌面实现。
 * 其他文件（包括所有业务代码）只能通过 `@/platform` 的 `usePlatform()` 使用平台能力。
 * `tests/architecture.spec.ts` 会扫描源码把这条规则变成可执行的门禁。
 */

/** Go 侧 `[]byte` 经 Wails 序列化为 base64 字符串。 */
export function decodeBase64(value: string | null): Uint8Array {
  if (!value) return new Uint8Array()
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function toRecord(summary: BookSummary): BookRecord {
  return {
    id: summary.id,
    title: summary.title,
    author: summary.author,
    format: summary.format,
    contentHash: summary.contentHash,
    sizeBytes: summary.sizeBytes,
    addedAt: summary.addedAt,
  }
}

/**
 * 桌面（Wails v3）平台实现。
 *
 * 未实现的能力在 M1 里以"诚实降级"返回（不是静默假成功）：
 * 同步引擎由 Go 侧拥有（ADR-002 §4），M1 只有本地占位状态。
 */
export function createDesktopPlatform(): Platform {
  return {
    kind: 'wails',
    capabilities: ['files.dialog', 'library.local', 'sync.outbox', 'system.openExternal'],
    files: {
      async importBookFromDialog(): Promise<ImportBookResult | null> {
        try {
          const summary = await LibraryService.ImportBookWithDialog()
          return { book: toRecord(summary), source: 'dialog' }
        } catch (error) {
          // Go 侧用 "cancelled" 表示用户取消了对话框。
          if (error instanceof Error && /cancelled/i.test(error.message)) return null
          if (typeof error === 'string' && /cancelled/i.test(error)) return null
          throw error
        }
      },
      async readBookBytes(bookId: string): Promise<Uint8Array> {
        return decodeBase64(await LibraryService.ReadBookBytes(bookId))
      },
    },
    library: {
      async listBooks(): Promise<BookRecord[]> {
        const list = await LibraryService.ListBooks()
        return (list ?? []).map(toRecord)
      },
      async openBook(bookId: string): Promise<OpenBookPayload> {
        const books = await this.listBooks()
        const book = books.find((b) => b.id === bookId)
        if (!book) throw new Error(`book ${bookId} not found`)
        const bytes = decodeBase64(await LibraryService.ReadBookBytes(bookId))
        return { book, bytes }
      },
      async deleteBook(bookId: string): Promise<void> {
        await LibraryService.DeleteBook(bookId)
      },
      async saveProgress(bookId: string, locator: string): Promise<void> {
        await LibraryService.SaveProgress(bookId, locator)
      },
      async getProgress(bookId: string): Promise<string> {
        return (await LibraryService.GetProgress(bookId)) ?? ''
      },
      onChanged(listener) {
        return Events.On(LibraryChanged, (event) => {
          listener(event.data?.bookId ?? null)
        })
      },
    },
    sync: {
      async status(): Promise<SyncStatus> {
        // M1：同步引擎尚未接入（见 ADR-003 §9 / task-8）。返回诚实的空闲态。
        return { phase: 'idle', pendingCount: 0, lastSyncedAt: null, lastError: null }
      },
      onStatus(listener) {
        listener({ phase: 'idle', pendingCount: 0, lastSyncedAt: null, lastError: null })
        return () => {}
      },
    },
    system: {
      async info(): Promise<AppInfo> {
        const [platform, version, dataDir] = await Promise.all([
          AppService.Platform(),
          AppService.Version(),
          AppService.DataDir(),
        ])
        return { platform, version, dataDir }
      },
      async openExternal(url: string): Promise<void> {
        const { Browser } = await import('@wailsio/runtime')
        await Browser.OpenURL(url)
      },
    },
  }
}
