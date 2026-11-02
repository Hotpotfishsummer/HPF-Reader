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

// ---- AI / 书源（task-23）----
export type TranslateRequest = components['schemas']['TranslateRequest']
export type AiJob = components['schemas']['AiJob']
export type AiJobCreate = components['schemas']['AiJobCreate']
export type AiUsage = components['schemas']['AiUsage']
export type QuotaDimension = components['schemas']['QuotaDimension']
export type QuotaExceededError = components['schemas']['QuotaExceededError']
export type BookTranslateResult = components['schemas']['BookTranslateResult']
export type ConsistencyScan = components['schemas']['ConsistencyScan']
export type SourceItem = components['schemas']['SourceItem']
export type SourceList = components['schemas']['SourceList']

/**
 * 术语表（task-24）。
 *
 * ★ 类型现在**直接来自生成的 `schema.d.ts`**，不再手写。
 *   task-23 时我手写过一份（`GlossaryEntry` / `origin: user|llm|deterministic`），
 *   那份是错的：服务端的字段名是 `source`、枚举是
 *   `user_confirmed|llm_extracted|deterministic`。手写契约必然漂移，所以这次以生成为准。
 *
 * 三条必须记住的语义（写在这里，因为类型本身表达不了）：
 *
 * 1. **`key` 是服务端算的归一化原文键**，不是原始写法。
 *    同一人物会有多种写法（`Mr. Darcy` / `Darcy` / `达西先生`），
 *    按原始写法存会变成多条，译文一致性无从谈起。
 *    客户端**不得自行实现归一化** —— openapi 明确写了「那是一套有版本的规则，
 *    重复实现必然不一致」。所以本地新增术语时 key 留空，交给服务端算。
 *
 * 2. **`source` 优先级 `user_confirmed > llm_extracted > deterministic`**。
 *    已有术语是 `user_confirmed` 时，自动流水线的写入被服务端**忽略**。
 *    这是「用户手工确认的译名重跑不得覆盖」的硬保证（后端有测试守着）。
 *
 * 3. **`version` 参与译文 `input_hash`**。
 *    术语改一条，受影响块必须重译 —— 也就是说**改术语会触发重新翻译并消耗额度**。
 *    UI 必须提前告知（见 GlossaryPanel 的 `glossaryVersionWarning`）。
 */
export type Glossary = components['schemas']['Glossary']
export type GlossaryTerm = components['schemas']['GlossaryTerm']
export type GlossarySource = GlossaryTerm['source']
export type GlossaryPutRequest = components['schemas']['GlossaryPutRequest']

/**
 * 术语来源的优先级数值（越小越优先）。
 * 用于 UI 判断「这条会不会被自动流水线覆盖」，以及展示排序。
 */
export const GLOSSARY_SOURCE_PRIORITY: Record<GlossarySource, number> = {
  user_confirmed: 0,
  llm_extracted: 1,
  deterministic: 2,
}

/** 该来源是否会被自动流水线覆盖（user_confirmed 不会）。 */
export function isOverridable(source: GlossarySource): boolean {
  return source !== 'user_confirmed'
}

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