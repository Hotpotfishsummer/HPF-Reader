import type { AnnotationDto, Locator, SyncChange } from '../../api/contract'
import type { LocalBook, LocalProgress, SyncLocalState } from './types'
import type { SyncSnapshotResponse } from '../../api/contract'

/** 服务端变更 → 本地投影。返回是否真的改动了本地状态。 */
export type ApplyTarget = SyncLocalState

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asLocator(value: unknown): Locator | null {
  return isRecord(value) ? (value as Locator) : null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function applyProgressPayload(
  state: ApplyTarget,
  bookId: string,
  payload: Record<string, unknown>,
  envelope: { hlc: string; deviceId: string | null },
): void {
  const previous = state.progress[bookId]
  const total = asNumber(payload['totalProgression'])
  const incomingFurthest = asNumber(payload['furthestProgression'], total)
  // 服务端 pull 返回的是「已被采纳的客户端载荷」，最远进度在本地只能增不能减：
  // 与服务端 GREATEST(...) 语义保持一致（TECH-PLAN §4.3 规则 3）。
  const furthestProgression = Math.max(previous?.furthestProgression ?? 0, incomingFurthest, total)
  const incomingFurthestLocator = asLocator(payload['furthestLocator'])
  const furthestLocator =
    incomingFurthestLocator !== null && incomingFurthest >= (previous?.furthestProgression ?? 0)
      ? incomingFurthestLocator
      : (previous?.furthestLocator ?? asLocator(payload['locator']))

  state.progress[bookId] = {
    bookId,
    locator: asLocator(payload['locator']),
    totalProgression: total,
    furthestLocator,
    furthestProgression,
    explicitRewind: payload['explicitRewind'] === true,
    contentHash: typeof payload['contentHash'] === 'string' ? payload['contentHash'] : null,
    // hlc/deviceId 在 SyncChange 信封上（payload 里没有），元数据必须取信封值。
    hlc: asString(payload['hlc'], envelope.hlc),
    deviceId: asString(payload['deviceId'], envelope.deviceId ?? ''),
    updatedAt: asString(payload['updatedAt']),
  }
}

function applyBookPayload(state: ApplyTarget, bookId: string, payload: Record<string, unknown>): void {
  const previous = state.books[bookId]
  state.books[bookId] = {
    id: bookId,
    title: asString(payload['title'], previous?.title ?? ''),
    author: typeof payload['author'] === 'string' ? payload['author'] : (previous?.author ?? null),
    language: typeof payload['language'] === 'string' ? payload['language'] : (previous?.language ?? null),
    format: asString(payload['format'], previous?.format ?? ''),
    contentHash:
      typeof payload['contentHash'] === 'string' ? payload['contentHash'] : (previous?.contentHash ?? null),
    readingState: asString(payload['readingState'], previous?.readingState ?? 'unread'),
    rating: typeof payload['rating'] === 'number' ? payload['rating'] : (previous?.rating ?? null),
  }
}

/**
 * 标注载荷 → 规范化 AnnotationDto。
 *
 * ★ pull 与 snapshot **两条路径必须共用这一个函数**。
 *   曾经的 bug：snapshot 路径直接 `state.annotations[annotation.id] = annotation`，
 *   而服务端快照里的载荷只有 `{text,type,bookId,locator}`（id 在 op 的 entityId / 表主键上，
 *   不在 payload 里），于是 `annotation.id` 是 undefined —— 新设备首同步会把所有标注
 *   写成 `state.annotations['undefined']` 这一条幽灵记录：按 id 查不到、UI 列表里多一条坏数据。
 *   集成测试 BF-08 复现了它（apps/server/internal/store/sync_store.go 也随之修好注入 id）。
 */
export function normalizeAnnotation(
  annotationId: string,
  payload: Record<string, unknown>,
  fallback?: AnnotationDto,
): AnnotationDto {
  return {
    id: annotationId,
    bookId: asString(payload['bookId'], fallback?.bookId ?? ''),
    locator: asLocator(payload['locator']) ?? fallback?.locator ?? ({ href: '', type: '' } as Locator),
    type: asString(payload['type'], fallback?.type ?? 'highlight') as AnnotationDto['type'],
    color: typeof payload['color'] === 'string' ? payload['color'] : (fallback?.color ?? null),
    note: typeof payload['note'] === 'string' ? payload['note'] : (fallback?.note ?? null),
    text: typeof payload['text'] === 'string' ? payload['text'] : (fallback?.text ?? null),
    createdAt: asString(payload['createdAt'], fallback?.createdAt ?? new Date(0).toISOString()),
    updatedAt: asString(payload['updatedAt'], fallback?.updatedAt ?? new Date().toISOString()),
  } as AnnotationDto
}

function applyAnnotationPayload(state: ApplyTarget, annotationId: string, payload: Record<string, unknown>): void {
  state.annotations[annotationId] = normalizeAnnotation(annotationId, payload, state.annotations[annotationId])
}

/**
 * 应用一条服务端变更（pull 的 changes 元素）。
 *
 * 只做「投影」，不做裁决：服务端已经决定过的结果，客户端照单落地。
 */
export function applyChange(state: ApplyTarget, change: SyncChange): boolean {
  const payload = isRecord(change.payload) ? change.payload : {}
  switch (change.entity) {
    case 'progress': {
      if (change.kind === 'delete') {
        const existed = state.progress[change.entityId] !== undefined
        delete state.progress[change.entityId]
        return existed
      }
      applyProgressPayload(state, change.entityId, payload, { hlc: change.hlc, deviceId: change.deviceId ?? null })
      return true
    }
    case 'annotation': {
      if (change.kind === 'delete') {
        const existed = state.annotations[change.entityId] !== undefined
        delete state.annotations[change.entityId]
        return existed
      }
      applyAnnotationPayload(state, change.entityId, payload)
      return true
    }
    case 'book': {
      if (change.kind === 'delete') {
        const existed = state.books[change.entityId] !== undefined
        delete state.books[change.entityId]
        return existed
      }
      applyBookPayload(state, change.entityId, payload)
      return true
    }
    case 'book_config':
      // 一期没有独立的配置模型：服务端只写 change_log，客户端本地维护（见 store/sync_store.go 注释）。
      return false
    default:
      return false
  }
}

/** 应用一页变更，返回真正生效的条数，并把游标推进到 nextCursor。 */
export function applyPull(state: ApplyTarget, changes: readonly SyncChange[], nextCursor: number): number {
  let applied = 0
  for (const change of changes) {
    if (applyChange(state, change)) applied += 1
  }
  if (nextCursor > state.cursor) state.cursor = nextCursor
  return applied
}

/** 应用全量快照（新设备首同步 / 游标失效）。快照是服务端权威结果，直接整体替换。 */
export function applySnapshot(state: ApplyTarget, snapshot: SyncSnapshotResponse): number {
  state.books = {}
  state.progress = {}
  state.annotations = {}
  let annotationsApplied = 0
  for (const book of snapshot.books) {
    const item: LocalBook = {
      id: book.id,
      title: book.title,
      author: book.author ?? null,
      language: book.language ?? null,
      format: book.format,
      contentHash: book.contentHash ?? null,
      readingState: book.readingState,
      rating: book.rating ?? null,
    }
    state.books[item.id] = item
  }
  for (const progress of snapshot.progress) {
    const item: LocalProgress = {
      bookId: progress.bookId,
      locator: progress.locator ?? null,
      totalProgression: progress.totalProgression,
      furthestLocator: progress.furthestLocator ?? null,
      furthestProgression: progress.furthestProgression,
      explicitRewind: progress.explicitRewind,
      contentHash: progress.contentHash ?? null,
      hlc: progress.hlc,
      deviceId: progress.deviceId,
      updatedAt: progress.updatedAt,
    }
    state.progress[item.bookId] = item
  }
  for (const raw of snapshot.annotations) {
    const payload: Record<string, unknown> = isRecord(raw) ? raw : {}
    const id = typeof payload['id'] === 'string' && payload['id'] !== '' ? payload['id'] : null
    if (id === null) {
      // 服务端快照必须带 id（sync_store.go 的 Snapshot 已注入 id/bookId/时间戳）。
      // 宁可**跳过并计数**，也绝不写出 annotations['undefined'] —— 幽灵条目比少一条更糟：
      // 它按 id 查不到、删不掉，还会在 UI 里多出一行。
      continue
    }
    state.annotations[id] = normalizeAnnotation(id, payload)
    annotationsApplied += 1
  }
  state.cursor = snapshot.cursor
  return snapshot.books.length + snapshot.progress.length + annotationsApplied
}
