/**
 * 平台抽象层：唯一契约。
 *
 * 硬规则（docs/research/50-vue3-reader-stack.md §2.3）：
 * 业务代码**只允许** import 本文件与 `@/platform` 的 `usePlatform()`；
 * 唯一允许 import Wails 生成 bindings 的文件是 `platform/desktop.ts` 与 `platform/mobile.ts`。
 * 由 `tests/architecture.spec.ts` 自动把关。
 */

export type PlatformKind = 'wails' | 'web' | 'test'

/** 书库条目（前端视图模型；与 openapi.yaml 的 Book / Go 侧 BookSummary 对齐）。 */
export interface BookRecord {
  id: string
  title: string
  author: string
  format: string
  contentHash: string
  sizeBytes: number
  addedAt: string
}

export interface ImportBookResult {
  book: BookRecord
  /** 数据来源：本机文件对话框 / 远程服务端 / 测试夹具。 */
  source: 'dialog' | 'remote' | 'fixture'
}

export interface OpenBookPayload {
  book: BookRecord
  /** 用于交给 foliate-js 的原始字节。 */
  bytes: Uint8Array
  /** 有值时可交给 foliate-js 直接用 URL 打开（示例书走这条）。 */
  url?: string
}

export type SyncPhase = 'idle' | 'offline' | 'pulling' | 'pushing' | 'conflict'

export interface SyncStatus {
  phase: SyncPhase
  pendingCount: number
  lastSyncedAt: number | null
  lastError: { code: string; message: string } | null
}

export interface AppInfo {
  platform: string
  version: string
  dataDir: string
}

/** 文件能力：导入本地书籍。 */
export interface FilesCapability {
  /** 让宿主弹文件选择框并返回导入结果；用户取消时返回 null。 */
  importBookFromDialog(): Promise<ImportBookResult | null>
  /** 读取书籍字节（Web 目标走 HTTP）。 */
  readBookBytes(bookId: string): Promise<Uint8Array>
}

/** 书库能力。 */
export interface LibraryCapability {
  listBooks(): Promise<BookRecord[]>
  openBook(bookId: string): Promise<OpenBookPayload>
  deleteBook(bookId: string): Promise<void>
  saveProgress(bookId: string, locator: string): Promise<void>
  getProgress(bookId: string): Promise<string>
  /** 订阅书库变更；返回取消订阅函数。 */
  onChanged(listener: (bookId: string | null) => void): () => void
}

/** 同步能力：M1 只有本地骨架，真相区在 Go 侧（见 ADR-002 §4）。 */
export interface SyncCapability {
  status(): Promise<SyncStatus>
  onStatus(listener: (status: SyncStatus) => void): () => void
}

/** 系统能力。 */
export interface SystemCapability {
  info(): Promise<AppInfo>
  openExternal(url: string): Promise<void>
}

/** 平台能力清单，用于 UI 做能力探测（而不是到处 if (isDesktop)）。 */
export type CapabilityName = 'files.dialog' | 'library.local' | 'sync.outbox' | 'system.openExternal'

export interface Platform {
  readonly kind: PlatformKind
  readonly capabilities: readonly CapabilityName[]
  files: FilesCapability
  library: LibraryCapability
  sync: SyncCapability
  system: SystemCapability
}
