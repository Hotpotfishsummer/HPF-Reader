import type { ApiClient } from './client'
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
    /** 上传文件；contentHash 必须是客户端算出的 sha256（服务端会按字节复核）。 */
    uploadFile(
      bookId: string,
      contentHash: string,
      bytes: Uint8Array,
    ): Promise<{ status: number; body: FileUploadResponse }> {
      const path =
        '/v1/books/' + bookId + '/file?contentHash=' + encodeURIComponent('sha256:' + contentHash)
      return client.putBinary<FileUploadResponse>(path, bytes, 'application/epub+zip')
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

/** 组装四个资源域（服务端契约按 tag 分组）。 */
export function createApi(client: ApiClient) {
  return {
    auth: createAuthApi(client),
    books: createBooksApi(client),
    sync: createSyncApi(client),
    annotations: createAnnotationsApi(client),
  }
}

export type Api = ReturnType<typeof createApi>
