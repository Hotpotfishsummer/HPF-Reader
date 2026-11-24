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

/** 把内存中的字节写入本地书库（云端下载完成后调用）。 */
export interface ImportBookBytesInput {
  /** 原始文件名，用于推断标题/落盘扩展名。 */
  name: string
  /** 云端元数据（优先于文件名推断值）。 */
  title?: string
  author?: string
  format?: string
  bytes: Uint8Array
}

/** 书库能力。 */
export interface LibraryCapability {
  listBooks(): Promise<BookRecord[]>
  openBook(bookId: string): Promise<OpenBookPayload>
  deleteBook(bookId: string): Promise<void>
  saveProgress(bookId: string, locator: string): Promise<void>
  getProgress(bookId: string): Promise<string>
  /**
   * 把内存字节写入本地书库（下载云端书籍的落地动作）。
   *
   * 只有具备 `library.local` 能力的平台才真正实现：Web 目标必须**显式报错**，
   * 不能静默假成功（见 platform/server.ts）。
   */
  importBookBytes(input: ImportBookBytesInput): Promise<BookRecord>
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
  openDataDir?(): Promise<void>
}

/** 窗口控制能力（跨端统一契约）。 */
export interface WindowCapability {
  /** 当前平台是否需要自绘窗口控制按钮（Windows / Linux 桌面端为 true） */
  readonly hasControls: boolean
  /** 是否需要避让 macOS 原生交通灯（macOS 为 true，左侧需留出边距） */
  readonly isMacTrafficLights: boolean
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  /** 订阅窗口最大化状态变更，返回取消订阅函数 */
  onMaximizedChanged?(listener: (isMax: boolean) => void): () => void
  /** 切换全屏模式 */
  toggleFullscreen?(): Promise<void>
  /** 查询当前是否处于全屏模式 */
  isFullscreen?(): Promise<boolean>
  /** 订阅全屏状态变更，返回取消订阅函数 */
  onFullscreenChanged?(listener: (isFs: boolean) => void): () => void
}

/** 内部独立浏览器能力。 */
export interface BrowserCapability {
  openURL(url: string): Promise<void>
  close?(): Promise<void>
}

/** 本机 API 中继的连接信息（桌面端由 Go 侧提供；web/移动端没有）。 */
export interface ApiTransportInfo {
  /** 形如 http://127.0.0.1:<随机端口>。 */
  baseURL: string
  /** 每次进程启动都不同的一次性 token（放进 X-HPF-Relay 头）。 */
  token: string
}

/** 代理配置。 */
export interface ProxyConfig {
  enabled: boolean
  type: string
  host: string
  port: number
}

/** 代理连通性测试结果。 */
export interface ProxyTestResult {
  success: boolean
  latencyMs: number
  message: string
}

/** 代理控制能力。 */
export interface ProxyCapability {
  getConfig(): Promise<ProxyConfig>
  saveConfig(cfg: ProxyConfig): Promise<void>
  testProxy(cfg: ProxyConfig): Promise<ProxyTestResult>
  detectSystemProxy(): Promise<ProxyConfig>
}

/** 下载项。 */
export interface DownloadItem {
  id: string
  url: string
  filename: string
  sizeBytes: number
  status: string
  downloadedAt: string
  filePath: string
}

/** 下载与文件入库能力。 */
export interface DownloadCapability {
  listDownloads(): Promise<DownloadItem[]>
  startDownload(url: string, filename?: string): Promise<DownloadItem>
  importToLibrary(filename: string): Promise<BookRecord>
  openDownloadsFolder(): Promise<void>
  deleteDownload(filename: string): Promise<void>
}

/** 平台能力清单，用于 UI 做能力探测（而不是到处 if (isDesktop)）。 */
export type CapabilityName =
  | 'files.dialog'
  | 'library.local'
  | 'sync.outbox'
  | 'system.openExternal'
  | 'window.controls'
  | 'browser.internal'
  | 'proxy.manage'
  | 'downloads.manage'

export interface Platform {
  readonly kind: PlatformKind
  readonly capabilities: readonly CapabilityName[]
  /**
   * 解析 API 传输方式（安全关键）。
   *
   * 返回非 null 表示"API 请求必须经本机 Go 中继发出"——渲染层不碰 API 的 TLS，
   * 证书由 Go 用系统根证书严格校验（见 apps/client/apirelay.go）。
   * 返回 null 表示"直接用原生 fetch"（web / 移动端 / 中继未启动）。
   *
   * 桌面实现会顺带把结果注入 api/relay.ts 的进程级当前值，
   * 因此 `main.ts` 在挂载前 await 一次即可让首个请求就走中继。
   */
  resolveApiTransport(): Promise<ApiTransportInfo | null>
  files: FilesCapability
  library: LibraryCapability
  sync: SyncCapability
  system: SystemCapability
  window: WindowCapability
  browser: BrowserCapability
  proxy: ProxyCapability
  downloads: DownloadCapability
}
