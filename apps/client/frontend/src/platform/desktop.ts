import { Events, System, Window } from '@wailsio/runtime'
import * as APIRelayService from '../../bindings/github.com/hotpotfish/hpfreader/client/apirelayservice'
import * as AppService from '../../bindings/github.com/hotpotfish/hpfreader/client/appservice'
import * as BrowserService from '../../bindings/github.com/hotpotfish/hpfreader/client/browserservice'
import * as DownloadService from '../../bindings/github.com/hotpotfish/hpfreader/client/downloadservice'
import * as LibraryService from '../../bindings/github.com/hotpotfish/hpfreader/client/libraryservice'
import * as ProxyService from '../../bindings/github.com/hotpotfish/hpfreader/client/proxyservice'
import type { BookSummary } from '../../bindings/github.com/hotpotfish/hpfreader/client/models'
import { LibraryChanged } from '../../bindings/events'
import { setApiRelayTransport } from '../api/relay'
import type {
  ApiTransportInfo,
  AppInfo,
  BookRecord,
  CapabilityName,
  DownloadItem,
  ImportBookResult,
  OpenBookPayload,
  Platform,
  ProxyConfig,
  ProxyTestResult,
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

/** Go 侧 []byte 参数经 Wails 序列化为 base64 字符串。 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
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

function detectIsMac(): boolean {
  if (typeof navigator !== 'undefined' && /macintosh|mac os x/i.test(navigator.userAgent)) {
    return true
  }
  try {
    return System.IsMac()
  } catch {
    return false
  }
}

/**
 * 解析 API 传输方式：从 Go 侧拿本机中继的 {baseURL, token}。
 *
 * ★ 这是本次安全修复的前端半边：拿到 transport 后，api/client.ts 与 api/ai.ts
 *   会把 `https://<server>/v1/...` 改写成 `http://127.0.0.1:<port>/r?u=...`，
 *   于是 API 流量**不再经过 Chromium 的 TLS** —— `--ignore-certificate-errors`
 *   对 API 彻底失效，证书由 Go 用系统根证书严格校验。
 *
 * 失败时返回 null（诚实降级为直连），并打一条告警：
 * 此时 API 的证书校验只剩 Chromium，属于已知的退化状态，不能静默。
 */
async function resolveApiTransport(): Promise<ApiTransportInfo | null> {
  try {
    const info = await APIRelayService.RelayTransport()
    if (!info || !info.baseURL || !info.token) {
      console.warn('[platform] API 中继未就绪：API 将直连（证书校验退化）')
      return null
    }
    const transport: ApiTransportInfo = { baseURL: info.baseURL, token: info.token }
    // 注入到 api/relay.ts 的进程级当前值：api client 不需要显式传参。
    setApiRelayTransport(transport)
    return transport
  } catch (error) {
    console.warn('[platform] 无法获取 API 中继信息：API 将直连（证书校验退化）', error)
    return null
  }
}

/**
 * 桌面（Wails v3）平台实现。
 *
 * 未实现的能力在 M1 里以"诚实降级"返回（不是静默假成功）：
 * 同步引擎由 Go 侧拥有（ADR-002 §4），M1 只有本地占位状态。
 */
export function createDesktopPlatform(): Platform {
  const isMac = detectIsMac()
  const capabilities: CapabilityName[] = [
    'files.dialog',
    'library.local',
    'sync.outbox',
    'system.openExternal',
    'browser.internal',
    'proxy.manage',
    'downloads.manage',
  ]
  if (!isMac) {
    capabilities.push('window.controls')
  }

  return {
    kind: 'wails',
    capabilities,
    resolveApiTransport,
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
      async importBookBytes(input): Promise<BookRecord> {
        const summary = await LibraryService.ImportBookBytes({
          name: input.name,
          title: input.title ?? '',
          author: input.author ?? '',
          format: input.format ?? '',
          data: encodeBase64(input.bytes),
        })
        return toRecord(summary)
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
      async openDataDir(): Promise<void> {
        const dir = await AppService.DataDir()
        const { Browser } = await import('@wailsio/runtime')
        await Browser.OpenURL(dir)
      },
    },
    window: {
      hasControls: !isMac,
      isMacTrafficLights: isMac,
      async minimize(): Promise<void> {
        await Window.Minimise()
      },
      async toggleMaximize(): Promise<void> {
        await Window.ToggleMaximise()
      },
      async close(): Promise<void> {
        await Window.Close()
      },
      async isMaximized(): Promise<boolean> {
        return await Window.IsMaximised()
      },
      onMaximizedChanged(listener: (isMax: boolean) => void): () => void {
        const u1 = Events.On(Events.Types.Common.WindowMaximise, () => listener(true))
        const u2 = Events.On(Events.Types.Common.WindowUnMaximise, () => listener(false))
        const u3 = Events.On(Events.Types.Common.WindowRestore, () => listener(false))
        return () => {
          u1()
          u2()
          u3()
        }
      },
      async toggleFullscreen(): Promise<void> {
        await Window.ToggleFullscreen()
      },
      async isFullscreen(): Promise<boolean> {
        return await Window.IsFullscreen()
      },
      onFullscreenChanged(listener: (isFs: boolean) => void): () => void {
        const u1 = Events.On(Events.Types.Common.WindowFullscreen, () => listener(true))
        const u2 = Events.On(Events.Types.Common.WindowUnFullscreen, () => listener(false))
        const u3 = Events.On(Events.Types.Common.WindowRestore, async () => {
          try {
            listener(await Window.IsFullscreen())
          } catch {
            listener(false)
          }
        })
        return () => {
          u1()
          u2()
          u3()
        }
      },
    },
    browser: {
      async openURL(url: string): Promise<void> {
        await BrowserService.OpenURL(url)
      },
      async close(): Promise<void> {
        await BrowserService.Close()
      },
    },
    proxy: {
      async getConfig(): Promise<ProxyConfig> {
        const cfg = await ProxyService.GetConfig()
        return {
          enabled: cfg.enabled,
          type: cfg.type || 'http',
          host: cfg.host || '127.0.0.1',
          port: cfg.port || 7890,
        }
      },
      async saveConfig(cfg: ProxyConfig): Promise<void> {
        await ProxyService.SaveConfig(cfg)
      },
      async testProxy(cfg: ProxyConfig): Promise<ProxyTestResult> {
        const res = await ProxyService.TestProxy(cfg)
        return {
          success: res.success,
          latencyMs: res.latencyMs,
          message: res.message,
        }
      },
      async detectSystemProxy(): Promise<ProxyConfig> {
        const cfg = await ProxyService.DetectSystemProxy()
        return {
          enabled: cfg.enabled,
          type: cfg.type || 'http',
          host: cfg.host || '127.0.0.1',
          port: cfg.port || 7890,
        }
      },
    },
    downloads: {
      async listDownloads(): Promise<DownloadItem[]> {
        const items = await DownloadService.ListDownloads()
        return (items ?? []).map((i) => ({
          id: i.id,
          url: i.url,
          filename: i.filename,
          sizeBytes: i.sizeBytes,
          status: i.status,
          downloadedAt: i.downloadedAt,
          filePath: i.filePath,
        }))
      },
      async startDownload(url: string, filename?: string): Promise<DownloadItem> {
        const item = await DownloadService.StartDownload(url, filename ?? '')
        return {
          id: item.id,
          url: item.url,
          filename: item.filename,
          sizeBytes: item.sizeBytes,
          status: item.status,
          downloadedAt: item.downloadedAt,
          filePath: item.filePath,
        }
      },
      async importToLibrary(filename: string): Promise<BookRecord> {
        const summary = await DownloadService.ImportToLibrary(filename)
        return toRecord(summary)
      },
      async openDownloadsFolder(): Promise<void> {
        await DownloadService.OpenDownloadsFolder()
      },
      async deleteDownload(filename: string): Promise<void> {
        await DownloadService.DeleteDownload(filename)
      },
    },
  }
}
