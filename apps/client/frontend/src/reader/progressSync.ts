import type { Locator } from '@/api/contract'
import type { ProgressInput } from '@/features/sync/types'
import type { ProgressEngineLike, RemoteProgress } from './progressStore'
import { normalizeContentHash, progressionToPercent } from './progressStore'

/**
 * ★ task-4：阅读进度 → HLC 同步引擎的接线层。
 *
 * 为什么单独一个文件（而不是塞进 ReaderView.vue）：
 *   "什么时候该发、能发不能发、发什么" 这三件事必须能被单测直接覆盖。
 *   塞进组件里就只能挂载 Vue 组件才能测，而且 ReaderView 里有 DOM/foliate 依赖。
 *
 * 三条规则（来自任务书 + 服务端语义）：
 *   1. **节流**：翻页很频繁，入队按「≥ timeThresholdMs 或进度变化 ≥ progressThreshold」；
 *      用户显式跳转（目录/书签/搜索/拖动进度条）是明确意图，**立即入队**。
 *   2. **映射不到就跳过**：服务端 bookId 是 UUID，本地书 id 是文件哈希前 16 位。
 *      `engine.local.books` 里没有对应 contentHash 的书 → 这本书还没上传到云端，
 *      直接不发（绝不伪造 id，也绝不用本地 id 冒充）。
 *   3. **explicitRewind**：只有用户主动回退位置时才置 true —— 它是服务端
 *      「允许当前位置后退、且不覆盖历史最远」的信号。自然翻页绝不能带，
 *      否则用户往回翻一页就会打断其它设备的"最远进度"。
 */

/** 节流窗口：两次入队之间的最小间隔。 */
export const PROGRESS_SYNC_INTERVAL_MS = 2000
/** 节流阈值：进度变化达到 0.5% 就值得入队（服务端比较容差是 0.2%）。 */
export const PROGRESS_SYNC_DELTA = 0.005

/**
 * 纯节流判定 —— 不碰时钟、不碰引擎，所以单测可以直接喂各种边界。
 *
 * @param sinceLastMs 距上次入队的毫秒数（从未入队传 null）
 * @param percentDelta 与上次入队时的百分比差（绝对值，0..1 量纲）
 * @param explicit 是否用户显式跳转（显式意图立即通过）
 */
export function shouldFlushProgress(input: {
  sinceLastMs: number | null
  percentDelta: number
  explicit: boolean
  intervalMs?: number
  deltaThreshold?: number
}): boolean {
  if (input.explicit) return true
  if (input.sinceLastMs === null) return true
  if (!Number.isFinite(input.sinceLastMs) || input.sinceLastMs < 0) return true
  const interval = input.intervalMs ?? PROGRESS_SYNC_INTERVAL_MS
  const threshold = input.deltaThreshold ?? PROGRESS_SYNC_DELTA
  if (input.sinceLastMs >= interval) return true
  return Math.abs(input.percentDelta) >= threshold
}

/** 只依赖引擎的"入队"能力，便于单测注入假引擎。 */
export interface ProgressEnqueueEngineLike extends ProgressEngineLike {
  enqueueProgress(input: ProgressInput): unknown
}

/** 一次 relocate 里我们真正需要的字段（不依赖 foliate 的类型）。 */
export interface ReaderLocationInput {
  cfi: string
  /** 0..1 */
  fraction: number
  /** 章节序号（foliate 的 index）；用来给 locator 拼一个可定位的 href 占位。 */
  index?: number
  /** 有 href 时优先用它（search / TOC 跳转路径会带）。 */
  href?: string
}

export interface ProgressSyncDeps {
  /** 该书当前在阅读器里的 contentHash（本地文件 / 书库条目）。 */
  getContentHash: () => string | null | undefined
  /** 惰性取引擎：服务器地址变更后引擎会被重建，所以每次都要重新拿。 */
  getEngine: () => ProgressEnqueueEngineLike | undefined
  /** 已登录才推；未登录时纯本地，连引擎都不碰。 */
  isLoggedIn?: () => boolean
  now?: () => number
  intervalMs?: number
  deltaThreshold?: number
  onFlush?: (bookId: string, explicitRewind: boolean) => void
  onSkip?: (reason: 'no-engine' | 'not-logged-in' | 'unmapped') => void
}

export interface ProgressSyncTarget {
  serverBookId: string
  contentHash: string
  locator: Locator
  totalProgression: number
  explicitRewind: boolean
}

/**
 * 从引擎的本地投影里做「本地书 → 服务端书」映射。
 * 复用 progressStore 的归一化规则（sha256: 前缀 + 大小写），保证两处判定一致。
 */
export function lookupServerBookId(
  contentHash: string | null | undefined,
  engine?: ProgressEngineLike,
): string | null {
  if (!engine || !contentHash) return null
  const wanted = normalizeContentHash(contentHash)
  if (!wanted) return null
  for (const book of Object.values(engine.local.books ?? {})) {
    if (book && normalizeContentHash(book.contentHash) === wanted) return book.id
  }
  return null
}

/** 最近一次成功入队的进度（卸载 flush / 诊断用）。 */
const lastFlushed = new Map<string, ProgressSyncTarget>()

export function lastFlushedProgress(bookId: string): ProgressSyncTarget | undefined {
  return lastFlushed.get(bookId)
}

/** 测试用：清掉"最近入队"缓存。 */
export function clearFlushedProgress(): void {
  lastFlushed.clear()
}

/**
 * 构造一本书的进度同步控制器。
 *
 * 它**不持有**响应式状态：阅读器把 relocate 事件推给它即可。
 */
export function createProgressSync(deps: ProgressSyncDeps) {
  const now = deps.now ?? Date.now
  const intervalMs = deps.intervalMs ?? PROGRESS_SYNC_INTERVAL_MS
  const deltaThreshold = deps.deltaThreshold ?? PROGRESS_SYNC_DELTA

  let lastSentAt: number | null = null
  let lastSentPercent: number | null = null
  let explicitNext = false
  let pending: { bookId: string; location: ReaderLocationInput } | null = null

  /** 用户显式跳转（目录 / 书签 / 搜索 / 拖动进度条）：下一次 relocate 立即入队。 */
  function markExplicitJump(): void {
    explicitNext = true
  }

  /** 换书 / 重新打开：清掉上一本的节流历史与待发送位置，避免把旧位置带到新书。 */
  function reset(): void {
    lastSentAt = null
    lastSentPercent = null
    explicitNext = false
    pending = null
  }

  function hasPending(): boolean {
    return pending !== null
  }

  /**
   * 处理一次位置变化。
   * @returns 真正入队时返回入参（含 serverBookId），被节流或映射不到时返回 null。
   */
  function handleRelocate(bookId: string, location: ReaderLocationInput): ProgressSyncTarget | null {
    if (!bookId || !location.cfi) return null
    pending = { bookId, location }

    const percent = progressionToPercent(location.fraction)
    const explicit = explicitNext
    const sinceLastMs = lastSentAt === null ? null : now() - lastSentAt
    const delta = lastSentPercent === null ? 1 : Math.abs(percent - lastSentPercent) / 100

    if (
      !shouldFlushProgress({
        sinceLastMs,
        percentDelta: delta,
        explicit,
        intervalMs,
        deltaThreshold,
      })
    ) {
      return null
    }

    const flushed = flush({ explicitRewindFallback: explicit })
    explicitNext = false
    return flushed
  }

  /**
   * 立刻尝试入队当前待发送的位置（卸载 / 切后台时调用，避免丢掉最后一页）。
   * @param options.explicitRewindFallback 没有"是否回退"信息时的兜底值。
   */
  function flush(options: { explicitRewindFallback?: boolean } = {}): ProgressSyncTarget | null {
    const current = pending
    if (!current) return null

    const engine = deps.getEngine()
    if (!engine) {
      deps.onSkip?.('no-engine')
      return null
    }
    if (deps.isLoggedIn && !deps.isLoggedIn()) {
      deps.onSkip?.('not-logged-in')
      return null
    }

    const contentHash = normalizeContentHash(deps.getContentHash())
    const serverBookId = lookupServerBookId(contentHash, engine)
    if (!serverBookId) {
      // 这本书还没上传到云端：跳过同步。绝不伪造 serverBookId。
      deps.onSkip?.('unmapped')
      return null
    }

    const percent = progressionToPercent(current.location.fraction)
    // explicitRewind 只在**位置真的变小时**才置 true：
    // 显式跳转到更后面的位置不需要"允许回退"，带上只会无谓地放开服务端的最远进度。
    const rewind =
      options.explicitRewindFallback === true &&
      (lastSentPercent === null || percent < lastSentPercent)

    const locator = buildReaderLocator(current.location)
    engine.enqueueProgress({
      bookId: serverBookId,
      locator,
      totalProgression: current.location.fraction,
      contentHash,
      explicitRewind: rewind,
    })

    const target: ProgressSyncTarget = {
      serverBookId,
      contentHash,
      locator,
      totalProgression: current.location.fraction,
      explicitRewind: rewind,
    }
    lastSentAt = now()
    lastSentPercent = percent
    lastFlushed.set(current.bookId, target)
    deps.onFlush?.(current.bookId, rewind)
    return target
  }

  return {
    markExplicitJump,
    reset,
    handleRelocate,
    flush,
    hasPending,
  }
}

export type ProgressSyncController = ReturnType<typeof createProgressSync>

/**
 * 构造交给同步引擎的 Readium Locator。
 *
 * foliate 的 relocate 只给 CFI + 位置序号，没有 href：
 * 用**文档序号**（index）拼出与 foliate 内部一致的 href 占位（第 index 节），
 * 这样服务端 / 其它设备拿到的 locator 至少能定位到章节，而不是空 href。
 * 我们另存 CFI 到 `locations.fragments[0]` —— 阅读器恢复位置时优先用 CFI。
 */
export function buildReaderLocator(location: ReaderLocationInput): Locator {
  const index = typeof location.index === 'number' && location.index >= 0 ? location.index : 0
  return {
    href: location.href ?? `section-${index}.xhtml`,
    type: 'application/epub+zip',
    locations: {
      fragments: location.cfi ? [location.cfi] : [],
      progression: location.fraction,
    },
  }
}

/** 判断服务端权威进度是否"比本地更值得用"（本地无记录，或云端更远）。 */
export function remoteIsPreferred(remote: RemoteProgress | null, localFraction: number): boolean {
  if (!remote) return false
  return localFraction <= 0 || remote.progression > localFraction
}
