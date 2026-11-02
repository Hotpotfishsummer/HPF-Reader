import type { AnnotationDto, Locator, SyncOp } from '../../api/contract'
import type { ApiClient } from '../../api/client'
import type { SyncPhase, SyncStatus } from '../../platform/types'
import type { SyncStorage } from './storage'

export type { SyncPhase, SyncStatus }

/** 契约上限（api/openapi.yaml）：单批 push ≤ 500 个 op。 */
export const MAX_OPS_PER_PUSH = 500
/** 契约上限：单次 pull ≤ 1000 条。 */
export const MAX_PULL_LIMIT = 1000
/** 跨副本进度比较容差，与服务端 internal/sync/merge.go 的 ProgressEpsilon 同值。 */
export const PROGRESS_EPSILON = 0.002
/** 墓碑保留窗口（天），与 TECH-PLAN §4.3 一致。 */
export const TOMBSTONE_DAYS = 30

/** outbox 中的一条待推送操作。 */
export interface OutboxEntry {
  op: SyncOp
  /** 入队时间（本地墙钟，仅用于诊断/背压）。 */
  enqueuedAt: number
  /** 已推送尝试次数（指数退避用；服务端确认后即出队）。 */
  attempts: number
}

/** 服务端权威的阅读进度在本地的投影。 */
export interface LocalProgress {
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

/** 本地书籍投影（snapshot.books 的元素）。 */
export interface LocalBook {
  id: string
  title: string
  author: string | null
  language: string | null
  format: string
  contentHash: string | null
  readingState: string
  rating: number | null
}

/** 客户端本地状态：**只是服务端结果的投影**，不含任何合并裁决逻辑（S1）。 */
export interface SyncLocalState {
  /** 服务端分配的单调游标；客户端只读不写。 */
  cursor: number
  books: Record<string, LocalBook>
  progress: Record<string, LocalProgress>
  annotations: Record<string, AnnotationDto>
}

export function emptyLocalState(): SyncLocalState {
  return { cursor: 0, books: {}, progress: {}, annotations: {} }
}

/** 入队一条进度变更所需的输入。 */
export interface ProgressInput {
  bookId: string
  locator: Locator
  totalProgression: number
  furthestLocator?: Locator
  furthestProgression?: number
  /** 用户主动回退：允许当前位置后退，且不覆盖服务端「历史最远」。 */
  explicitRewind?: boolean
  /** 书籍文件 sha256（副本标识）；跨副本时服务端只比较 totalProgression。 */
  contentHash?: string
}

export interface SyncEngineConfig {
  baseUrl: string
  /** 稳定设备 ID（UUID）；缺省时引擎生成并持久化到 storage。 */
  deviceId?: string
  platform?: 'web' | 'windows' | 'macos' | 'linux' | 'android' | 'ios'
  deviceName?: string
  /** 单次 push 的 op 上限，默认 200（契约允许 500；留余量避免超大请求体）。 */
  maxOpsPerPush?: number
  pullLimit?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
  timeoutMs?: number
}

export interface SyncEngineDeps {
  client: ApiClient
  storage: SyncStorage
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  isOnline?: () => boolean
}

export interface SyncRunResult {
  /** 本次从 outbox 出队的 op 数。 */
  pushed: number
  /** 服务端裁决为 applied 的 op 数。 */
  applied: number
  /** 被服务端拒绝（rejected）并从 outbox 丢弃的 op 数。 */
  rejected: number
  /** 成功 apply 到本地状态的变更数。 */
  appliedChanges: number
  /** 拉取后的服务端游标。 */
  cursor: number
  /** 本轮遇到的可重试错误（保留在 outbox，等待退避重试）。 */
  errors: string[]
}
