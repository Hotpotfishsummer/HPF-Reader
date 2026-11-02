import type { components } from './schema'

/**
 * 契约类型别名：全部从 scripts/gen-api-types.mjs 生成的 src/api/schema.d.ts 取，
 * 手写类型只在「服务端已实现但契约尚未收录」时出现（见下方注释与 spikes/sync/RESULTS.md）。
 */
export type ErrorDto = components['schemas']['Error']
export type AuthTokens = components['schemas']['AuthTokens']
export type UserDto = components['schemas']['User']
export type DeviceDto = components['schemas']['Device']
export type BookDto = components['schemas']['Book']
export type BookPage = components['schemas']['BookPage']
export type BookCreate = components['schemas']['BookCreate']
export type BookUpdate = components['schemas']['BookUpdate']
export type Locator = components['schemas']['Locator']
export type ReadingProgress = components['schemas']['ReadingProgress']
export type SyncOp = components['schemas']['SyncOp']
export type SyncPushRequest = components['schemas']['SyncPushRequest']
export type SyncPushResponse = components['schemas']['SyncPushResponse']
export type SyncChange = components['schemas']['SyncChange']
export type SyncPullResponse = components['schemas']['SyncPullResponse']
export type AnnotationDto = components['schemas']['Annotation']
export type AnnotationCreate = components['schemas']['AnnotationCreate']

/**
 * ⚠️ 契约缺口（已在 spikes/sync/RESULTS.md 记录，本任务不改 api/ 目录）：
 *   GET /v1/sync/snapshot 在 apps/server 已实现并有冒烟覆盖，但 api/openapi.yaml 未收录，
 *   因此 schema.d.ts 里没有类型。下面按服务端 store/sync_store.go 的 Snapshot() 实际输出手写。
 */
export interface SyncSnapshotBook {
  id: string
  title: string
  author: string | null
  language: string | null
  format: string
  contentHash: string | null
  metadata: unknown
  readingState: string
  rating: number | null
}

export interface SyncSnapshotProgress {
  bookId: string
  locator: Locator | null
  totalProgression: number
  furthestLocator: Locator | null
  furthestProgression: number
  explicitRewind: boolean
  contentHash: string | null
  hlc: string
  deviceId: string
  updatedAt: string
}

export interface SyncSnapshotResponse {
  cursor: number
  books: SyncSnapshotBook[]
  progress: SyncSnapshotProgress[]
  annotations: AnnotationDto[]
  settings: unknown[]
}

/** PUT /v1/books/{bookId}/file 的响应体（服务端 httpapi/files.go，openapi.yaml 只写了状态码）。 */
export interface FileUploadResponse {
  contentHash: string
  sizeBytes: number
  deduplicated: boolean
}

/** openapi.yaml 未给 /v1/books/{id}/file 的 200/201 响应 schema；状态码本身是契约的一部分。 */
export const UPLOAD_CREATED = 201
export const UPLOAD_DEDUPLICATED = 200
