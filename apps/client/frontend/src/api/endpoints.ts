import type { ApiClient, BinaryTransferOptions } from './client'
import { createAiApi } from './ai'
import type {
  AnnotationCreate,
  AnnotationDto,
  AuthTokens,
  BookCreate,
  BookDto,
  BookPage,
  BookUpdate,
  DeviceDto,
  FileUploadResponse,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncSnapshotResponse,
  UserDto,
} from './contract'

export interface RegisterInput {
  email: string
  password: string
  displayName?: string
  deviceId?: string
  deviceName?: string
  platform?: string
}

export interface LoginInput {
  email: string
  password: string
  deviceId?: string
  deviceName?: string
  platform?: string
}

function post(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}

export function createAuthApi(client: ApiClient) {
  return {
    register(input: RegisterInput): Promise<AuthTokens> {
      return client.request<AuthTokens>('/v1/auth/register', post(input))
    },
    login(input: LoginInput): Promise<AuthTokens> {
      return client.request<AuthTokens>('/v1/auth/login', post(input))
    },
    /** 轮换刷新令牌：服务端返回新的一对 token，旧 refresh 立即失效（重用检测）。 */
    refresh(refreshToken: string, deviceId?: string): Promise<AuthTokens> {
      return client.request<AuthTokens>('/v1/auth/refresh', post({ refreshToken, deviceId }))
    },
    logout(refreshToken: string, allDevices = false): Promise<void> {
      return client.requestVoid('/v1/auth/logout', post({ refreshToken, allDevices }))
    },
    me(): Promise<UserDto> {
      return client.request<UserDto>('/v1/me')
    },
    devices(): Promise<DeviceDto[]> {
      return client.request<DeviceDto[]>('/v1/devices')
    },
  }
}

export function createBooksApi(client: ApiClient) {
  return {
    list(params: { cursor?: string; limit?: number; updatedSince?: string } = {}): Promise<BookPage> {
      const q = new URLSearchParams()
      if (params.cursor !== undefined) q.set('cursor', params.cursor)
      if (params.limit !== undefined) q.set('limit', String(params.limit))
      if (params.updatedSince !== undefined) q.set('updatedSince', params.updatedSince)
      const suffix = q.size > 0 ? '?' + q.toString() : ''
      return client.request<BookPage>('/v1/books' + suffix)
    },
    get(bookId: string): Promise<BookDto> {
      return client.request<BookDto>('/v1/books/' + bookId)
    },
    create(input: BookCreate): Promise<BookDto> {
      return client.request<BookDto>('/v1/books', post(input))
    },
    update(bookId: string, input: BookUpdate): Promise<BookDto> {
      return client.request<BookDto>('/v1/books/' + bookId, { method: 'PATCH', body: JSON.stringify(input) })
    },
    remove(bookId: string): Promise<void> {
      return client.requestVoid('/v1/books/' + bookId, { method: 'DELETE' })
    },
    /**
     * 下载书籍原始字节（GET /v1/books/{bookId}/file）。
     *
     * ★ 二进制端点：走 client.requestBinary（arrayBuffer + Authorization），
     *   不能用 request()（会把响应体当 text 解码并损坏 EPUB/PDF）。
     */
    getFileBytes(bookId: string, options?: BinaryTransferOptions): Promise<Uint8Array> {
      return client.requestBinaryWithProgress('/v1/books/' + encodeURIComponent(bookId) + '/file', options)
    },
    /** 上传文件；contentHash 必须是客户端算出的 sha256（服务端会按字节复核）。 */
    uploadFile(
      bookId: string,
      contentHash: string,
      bytes: Uint8Array,
      options?: BinaryTransferOptions,
    ): Promise<{ status: number; body: FileUploadResponse }> {
      const path =
        '/v1/books/' + bookId + '/file?contentHash=' + encodeURIComponent('sha256:' + contentHash)
      return client.putBinary<FileUploadResponse>(path, bytes, 'application/epub+zip', options)
    },
  }
}

export function createSyncApi(client: ApiClient) {
  return {
    push(body: SyncPushRequest): Promise<SyncPushResponse> {
      return client.request<SyncPushResponse>('/v1/sync/push', post(body))
    },
    /** 拉取 cursor 之后的变更；cursor 必须用服务端返回值，客户端不得自行推进。 */
    pull(cursor: number, limit = 500): Promise<SyncPullResponse> {
      const q = new URLSearchParams({ cursor: String(cursor), limit: String(limit) })
      return client.request<SyncPullResponse>('/v1/sync/pull?' + q.toString())
    },
    snapshot(): Promise<SyncSnapshotResponse> {
      return client.request<SyncSnapshotResponse>('/v1/sync/snapshot')
    },
  }
}

export function createAnnotationsApi(client: ApiClient) {
  return {
    list(bookId: string): Promise<AnnotationDto[]> {
      return client.request<AnnotationDto[]>('/v1/books/' + bookId + '/annotations')
    },
    create(bookId: string, input: AnnotationCreate): Promise<AnnotationDto> {
      return client.request<AnnotationDto>('/v1/books/' + bookId + '/annotations', post(input))
    },
    update(annotationId: string, input: AnnotationCreate): Promise<AnnotationDto> {
      return client.request<AnnotationDto>('/v1/annotations/' + annotationId, {
        method: 'PATCH',
        body: JSON.stringify(input),
      })
    },
    remove(annotationId: string): Promise<void> {
      return client.requestVoid('/v1/annotations/' + annotationId, { method: 'DELETE' })
    },
  }
}

export function createSourcesApi(client: ApiClient) {
  return {
    list(): Promise<{ sources: string[] }> {
      return client.request<{ sources: string[] }>('/v1/sources')
    },
    search(query: string, source?: string): Promise<import('./contract').SourceItem[]> {
      const q = new URLSearchParams({ q: query })
      if (source) q.set('source', source)
      return client.request<import('./contract').SourceItem[]>('/v1/sources/search?' + q.toString())
    },
  }
}

/** 组装资源域（服务端契约按 tag 分组）。 */
export function createApi(client: ApiClient) {
  return {
    auth: createAuthApi(client),
    books: createBooksApi(client),
    sync: createSyncApi(client),
    annotations: createAnnotationsApi(client),
    ai: createAiApi(client),
    sources: createSourcesApi(client),
  }
}

export type Api = ReturnType<typeof createApi>