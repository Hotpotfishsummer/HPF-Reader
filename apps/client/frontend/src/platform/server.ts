import type {
  AppInfo,
  BookRecord,
  ImportBookResult,
  OpenBookPayload,
  Platform,
  SyncStatus,
} from './types'

/**
 * Web / server 平台实现：与 Go 外壳无关，直接对 HTTP API（api/openapi.yaml）。
 *
 * 这一层的存在意义（ADR-002 §4）：Wails 的 server 构建把同一份 Vue 前端跑在浏览器里，
 * 此时没有 bindings、没有 @wailsio/runtime —— 业务代码必须一行不改地继续工作。
 *
 * 注意：本文件**不 import 任何 bindings / @wailsio/runtime**。
 */

export interface ServerPlatformOptions {
  baseUrl: string
  /** 注入 token 获取器（M1 未接鉴权，先留出接口）。 */
  getAccessToken?: () => string | null
}

interface BookDto {
  id: string
  title: string
  author?: string | null
  format?: string | null
  contentHash?: string | null
  sizeBytes?: number | null
  updatedAt?: string | null
  createdAt?: string | null
}

interface BookPageDto {
  items?: BookDto[]
  nextCursor?: string | null
}

function toRecord(dto: BookDto): BookRecord {
  return {
    id: dto.id,
    title: dto.title,
    author: dto.author ?? '',
    format: dto.format ?? '',
    contentHash: dto.contentHash ?? '',
    sizeBytes: dto.sizeBytes ?? 0,
    addedAt: dto.createdAt ?? dto.updatedAt ?? '',
  }
}

export function createServerPlatform(options: ServerPlatformOptions): Platform {
  const base = options.baseUrl.replace(/\/$/, '')

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    const token = options.getAccessToken?.() ?? null
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const res = await fetch(`${base}${path}`, { ...init, headers })
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText}`)
    }
    return res
  }

  return {
    kind: 'web',
    capabilities: ['sync.outbox', 'system.openExternal'],
    files: {
      async importBookFromDialog(): Promise<ImportBookResult | null> {
        // 浏览器没有原生文件对话框抽象（<input type=file> 需要用户手势 + 组件配合），
        // M1 显式声明"不提供"，由 UI 走 <input type=file> 后调用 createBookFromFile。
        return null
      },
      async readBookBytes(bookId: string): Promise<Uint8Array> {
        const res = await request(`/v1/books/${encodeURIComponent(bookId)}/file`)
        return new Uint8Array(await res.arrayBuffer())
      },
    },
    library: {
      async listBooks(): Promise<BookRecord[]> {
        const res = await request('/v1/books?limit=200')
        const page = (await res.json()) as BookPageDto
        return (page.items ?? []).map(toRecord)
      },
      async openBook(bookId: string): Promise<OpenBookPayload> {
        const res = await request(`/v1/books/${encodeURIComponent(bookId)}`)
        const dto = (await res.json()) as BookDto
        const book = toRecord(dto)
        const fileRes = await request(`/v1/books/${encodeURIComponent(bookId)}/file`)
        const bytes = new Uint8Array(await fileRes.arrayBuffer())
        return { book, bytes }
      },
      async deleteBook(bookId: string): Promise<void> {
        await request(`/v1/books/${encodeURIComponent(bookId)}`, { method: 'DELETE' })
      },
      async saveProgress(bookId: string, locator: string): Promise<void> {
        // 进度是同步实体：走 sync/push，而不是 PATCH 元数据。
        await request('/v1/sync/push', {
          method: 'POST',
          body: JSON.stringify({
            ops: [
              {
                opId: crypto.randomUUID(),
                entity: 'progress',
                entityId: bookId,
                payload: { locator },
              },
            ],
          }),
        })
      },
      async getProgress(bookId: string): Promise<string> {
        const res = await request(`/v1/books/${encodeURIComponent(bookId)}`)
        const dto = (await res.json()) as BookDto & { readingState?: string | null }
        return dto.readingState ?? ''
      },
      onChanged() {
        // Web 目标没有 Go 侧事件总线；M1 只提供手动刷新（Query 失效）。
        return () => {}
      },
    },
    sync: {
      async status(): Promise<SyncStatus> {
        return { phase: 'idle', pendingCount: 0, lastSyncedAt: null, lastError: null }
      },
      onStatus(listener) {
        listener({ phase: 'idle', pendingCount: 0, lastSyncedAt: null, lastError: null })
        return () => {}
      },
    },
    system: {
      async info(): Promise<AppInfo> {
        return { platform: 'web', version: '0.1.0-web', dataDir: '' }
      },
      async openExternal(url: string): Promise<void> {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
    },
  }
}
