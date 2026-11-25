import { ApiError, type ApiClient } from '../../api/client'
import type { AnnotationCreate, AnnotationDto, Locator, SyncChange, SyncOp } from '../../api/contract'
import { createSyncApi } from '../../api/endpoints'
import type { SyncStatus } from '../../platform/types'
import { applyPull, applySnapshot } from './apply'
import { HybridLogicalClock } from './hlc'
import { Outbox } from './outbox'
import type { AuthSession } from './session'
import { onSessionInvalidated, SessionInvalidatedError } from './session'
import { createBrowserStorage, readJson, writeJson, type SyncStorage } from './storage'
import {
  emptyLocalState,
  MAX_OPS_PER_PUSH,
  MAX_PULL_LIMIT,
  type OutboxEntry,
  type ProgressInput,
  type SyncEngineConfig,
  type SyncEngineDeps,
  type SyncLocalState,
  type SyncRunResult,
} from './types'
import { newDeviceId, uuidv7 } from './uuid'

export const LOCAL_STATE_STORAGE_KEY = 'rjzjmq.v1'
export const DEVICE_ID_STORAGE_KEY = 'nrfqkf.v1'
/**
 * 上次同步成功时间（epoch ms）。
 *
 * ★ 单独存一个 key，而不是塞进本地投影：投影是「服务端快照/变更的副本」，
 *   写进去会被 applyPull 的整体替换语义冲掉；而这个值是纯客户端事实。
 *   不持久化它，界面每次重启都会退化成「从未同步」（本次线上故障的次要症状）。
 */
export const LAST_SUCCESS_STORAGE_KEY = 'lastok.v1'

const DEFAULT_PULL_LIMIT = 500
const DEFAULT_MAX_OPS = 200
const DEFAULT_BASE_BACKOFF_MS = 1000
const DEFAULT_MAX_BACKOFF_MS = 30000

export interface SyncEngineHooks {
  /** 便于测试注入；默认由 composable 注入真实 AuthSession。 */
  session?: Pick<AuthSession, 'refresh'> &
    Partial<Pick<AuthSession, 'isAccessTokenExpired' | 'hasSession'>>
}

export interface PushOutcome {
  pushed: number
  applied: number
  rejected: number
  /** 拉取游标（只由 pull 推进；push 不会改它）。 */
  cursor: number
  /** 服务端在 push 响应里给出的 change_log 位置（仅诊断用，不参与拉取）。 */
  pushCursor: number
  /** 服务端给出的非平凡裁决原因（older_hlc / stale_no_rewind / duplicate...）。 */
  reasons: string[]
}

export interface PullOutcome {
  changes: number
  appliedChanges: number
  pages: number
  cursor: number
}

/**
 * 同步引擎（S1：客户端只做出站队列 + 应用服务端结果）。
 *
 * 三条硬约束（来自 TECH-PLAN §4.3 与任务书）：
 *   1. **游标只由服务端分配**：本地 cursor 只写服务端返回值，绝不按本地时间推进；
 *   2. **不做合并裁决**：冲突由服务端 internal/sync/engine.go 决定，客户端只 apply 结果；
 *   3. **HLC 与服务端同构**：见 ./hlc.ts（同一个算法 + 同一套语义）。
 *
 * 引擎是普通类、不进 Pinia（docs/research/50-vue3-reader-stack.md §5）：
 * 内部有 Map/Set/计时器句柄，被 Vue Proxy 包住会导致身份不一致与重渲染放大。
 */
export class SyncEngine {
  #config: SyncEngineConfig
  #client: ApiClient
  #storage: SyncStorage
  #now: () => number
  #sleep: (ms: number) => Promise<void>
  #isOnline: () => boolean
  #session: SyncEngineHooks['session'] | undefined
  /** 模块级「会话已失效」订阅的取消函数（dispose 时解绑，避免旧引擎继续改状态）。 */
  #offSessionInvalidated: (() => void) | null = null

  #deviceId: string
  #clock: HybridLogicalClock
  #outbox: Outbox
  #local: SyncLocalState
  #sync: ReturnType<typeof createSyncApi>

  #status: SyncStatus = { phase: 'idle', pendingCount: 0, lastSyncedAt: null, lastError: null }
  #listeners = new Set<(status: SyncStatus) => void>()
  #running: Promise<SyncRunResult> | null = null
  #attempts = 0
  #lastPushCursor = 0
  #jitterRatio: number
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #autoTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: SyncEngineConfig, deps: SyncEngineDeps, hooks: SyncEngineHooks = {}) {
    this.#config = config
    this.#client = deps.client
    this.#storage = deps.storage
    this.#now = deps.now ?? Date.now
    this.#sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#isOnline = deps.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false))
    this.#session = hooks.session
    this.#jitterRatio = config['jitterRatio' as keyof SyncEngineConfig] === undefined ? 0.2 : Number(config['jitterRatio' as keyof SyncEngineConfig])

    const stored = readJson<string | null>(this.#storage, DEVICE_ID_STORAGE_KEY, null)
    const deviceId = config.deviceId ?? (typeof stored === 'string' && stored !== '' ? stored : newDeviceId())
    this.#deviceId = deviceId
    writeJson(this.#storage, DEVICE_ID_STORAGE_KEY, deviceId)

    this.#clock = new HybridLogicalClock(deviceId, this.#now)
    this.#outbox = Outbox.load(this.#storage)
    this.#local = readJson<SyncLocalState>(this.#storage, LOCAL_STATE_STORAGE_KEY, emptyLocalState())
    if (this.#local.books === undefined) this.#local = emptyLocalState()
    this.#sync = createSyncApi(this.#client)
    this.#status = { ...this.#status, pendingCount: this.#outbox.size }
    // 上次同步成功时间必须跨重启保留，否则重启后永远显示「从未同步」。
    const lastSuccess = readJson<number | null>(this.#storage, LAST_SUCCESS_STORAGE_KEY, null)
    if (typeof lastSuccess === 'number' && Number.isFinite(lastSuccess) && lastSuccess > 0) {
      this.#status = { ...this.#status, lastSyncedAt: lastSuccess }
    }

    // ★ 凭据失效可能发生在**同步之外**（例如启动时的 /v1/auth/me、设备列表请求）。
    //   只靠「同步失败」来落状态不够：协调器随后会把相位复位成 idle，
    //   用户看到「空闲 + 从未同步 + 135 条待推送」，却不知道要重新登录。
    //   直接订模块级失效广播，相位立刻收敛到 auth（重置相位时会保留它）。
    this.#offSessionInvalidated = onSessionInvalidated((invalidation) => {
      this.#commit({
        phase: 'auth',
        lastError: { code: 'auth_expired', message: invalidation.message },
        pendingCount: this.#outbox.size,
      })
    })
  }

  // ---------------------------------------------------------------- 只读视图

  get deviceId(): string {
    return this.#deviceId
  }

  get clock(): HybridLogicalClock {
    return this.#clock
  }

  get outbox(): Outbox {
    return this.#outbox
  }

  /** 本地投影（**服务端结果的副本**，不是合并真相区）。 */
  get local(): SyncLocalState {
    return this.#local
  }

  getStatus(): SyncStatus {
    return this.#status
  }

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  // ---------------------------------------------------------------- 入队

  /** 入队一条进度变更（阅读位置变化时调用，可高频）。 */
  enqueueProgress(input: ProgressInput): SyncOp {
    const op: SyncOp = {
      opId: uuidv7(this.#now()),
      entity: 'progress',
      entityId: input.bookId,
      bookId: input.bookId,
      kind: 'upsert',
      hlc: this.#clock.send(),
      deviceId: this.#deviceId,
      payload: {
        locator: input.locator,
        totalProgression: input.totalProgression,
        furthestLocator: input.furthestLocator ?? input.locator,
        furthestProgression: input.furthestProgression ?? input.totalProgression,
        explicitRewind: input.explicitRewind === true,
        contentHash: input.contentHash ?? null,
      },
    }
    this.#outbox.enqueue(op, this.#now())
    this.#commit({ pendingCount: this.#outbox.size })
    return op
  }

  /** 入队标注（新建/编辑走 upsert，删除走 delete → 服务端 remove-wins 墓碑）。 */
  enqueueAnnotation(bookId: string, annotationId: string, input?: AnnotationCreate): SyncOp {
    const op: SyncOp = {
      opId: uuidv7(this.#now()),
      entity: 'annotation',
      entityId: annotationId,
      bookId,
      kind: input === undefined ? 'delete' : 'upsert',
      hlc: this.#clock.send(),
      deviceId: this.#deviceId,
      payload: input === undefined ? {} : { ...input, bookId },
    }
    this.#outbox.enqueue(op, this.#now())
    this.#commit({ pendingCount: this.#outbox.size })
    return op
  }

  /** 入队书籍元数据变更。 */
  enqueueBook(bookId: string, payload: Record<string, unknown>): SyncOp {
    const op: SyncOp = {
      opId: uuidv7(this.#now()),
      entity: 'book',
      entityId: bookId,
      bookId,
      kind: 'upsert',
      hlc: this.#clock.send(),
      deviceId: this.#deviceId,
      payload,
    }
    this.#outbox.enqueue(op, this.#now())
    this.#commit({ pendingCount: this.#outbox.size })
    return op
  }

  /** 直接入队一条已构造好的 op（联调/单测用）。 */
  enqueueOp(op: SyncOp): OutboxEntry {
    const entry = this.#outbox.enqueue(op, this.#now())
    this.#commit({ pendingCount: this.#outbox.size })
    return entry
  }

  /** 观测远程 HLC（apply 变更后调用），保证后续本地 HLC 一定更大。 */
  observeRemote(hlc: string): void {
    this.#clock.observe(hlc)
  }

  /** 低层 HLC 取值（联调脚本需要在服务端时序上构造「更旧/更新」的 op）。 */
  nextHlc(): string {
    return this.#clock.send()
  }

  // ---------------------------------------------------------------- 推送 / 拉取

  /** 推送一批 outbox（默认一次 run 推一批；服务端单批上限 500）。 */
  async pushOnce(): Promise<PushOutcome> {
    const maxOps = Math.min(this.#config.maxOpsPerPush ?? DEFAULT_MAX_OPS, MAX_OPS_PER_PUSH)
    const entries = this.#outbox.peek(maxOps)
    const outcome: PushOutcome = { pushed: 0, applied: 0, rejected: 0, cursor: this.#local.cursor, pushCursor: this.#lastPushCursor, reasons: [] }
    if (entries.length === 0) return outcome

    const ops = entries.map((entry) => entry.op)
    this.#setPhase('pushing')
    const res = await this.#withAuthRetry(() => this.#sync.push({ deviceId: this.#deviceId, ops }))
    this.#outbox.markAttempt(ops.map((op) => op.opId))
    outcome.pushed = ops.length

    const ackIds: string[] = []
    for (const item of res.results) {
      ackIds.push(item.opId)
      if (item.status === 'rejected') {
        outcome.rejected += 1
      } else {
        outcome.applied += 1
      }
      if (typeof item.reason === 'string' && item.reason !== '' && item.reason !== 'duplicate') {
        outcome.reasons.push(item.reason)
      }
    }
    // 服务端确认后才出队；rejected 也出队（重试也不会成功，留在队列只会阻塞后续 op）。
    this.#outbox.ack(ackIds)
    // ★ 关键：**绝不拿 push 响应的 cursor 推进本地拉取游标**。
    //   push 返回的 cursor 指向本批操作在 change_log 里的位置；如果把它当作 pull 游标，
    //   客户端就会跳过自己刚写入的变更，导致本地投影永远缺一条（实测：标注在服务端存在，
    //   但本机的 local.annotations 里没有）。本地游标只能由 pull 的 nextCursor 推进。
    this.#lastPushCursor = typeof res.cursor === 'number' ? res.cursor : this.#lastPushCursor
    outcome.cursor = this.#local.cursor
    outcome.pushCursor = this.#lastPushCursor
    this.#commit({ pendingCount: this.#outbox.size })
    this.#persist()
    return outcome
  }

  /** 拉取到 head（自动分页，直到 hasMore=false）。 */
  async pullOnce(): Promise<PullOutcome> {
    const limit = Math.min(this.#config.pullLimit ?? DEFAULT_PULL_LIMIT, MAX_PULL_LIMIT)
    const outcome: PullOutcome = { changes: 0, appliedChanges: 0, pages: 0, cursor: this.#local.cursor }
    this.#setPhase('pulling')
    for (let page = 0; page < 100; page += 1) {
      const res = await this.#withAuthRetry(() => this.#sync.pull(this.#local.cursor, limit))
      const changes: SyncChange[] = res.changes
      outcome.pages += 1
      outcome.changes += changes.length
      for (const change of changes) this.#clock.observe(change.hlc)
      outcome.appliedChanges += applyPull(this.#local, changes, res.nextCursor)
      this.#persist()
      if (!res.hasMore) break
      // 防御：hasMore=true 但没有任何变更时停止，避免服务端语义异常导致死循环。
      if (changes.length === 0) break
    }
    outcome.cursor = this.#local.cursor
    return outcome
  }

  /** 新设备首同步 / 游标失效：全量快照整体替换本地投影。 */
  async bootstrap(): Promise<number> {
    this.#setPhase('pulling')
    try {
      const snapshot = await this.#withAuthRetry(() => this.#sync.snapshot())
      const applied = applySnapshot(this.#local, snapshot)
      this.#persist()
      this.#markSynced()
      return applied
    } catch (err) {
      // ★ 首次快照失败也必须落状态（相位 + lastError）。
      //   否则协调器的 activate() 捕获异常后只会把相位复位成 idle，
      //   用户看到的仍是「空闲」，而 outbox 里的变更永远推不上去。
      const failure = this.#classifyFailure(err)
      this.#commit({
        phase: failure.phase,
        lastError: { code: failure.code, message: failure.message },
        pendingCount: this.#outbox.size,
      })
      this.#persist()
      throw err
    }
  }

  /** 记录「上次同步成功」，内存 + 持久化各更新一次。 */
  #markSynced(): void {
    const at = this.#now()
    writeJson(this.#storage, LAST_SUCCESS_STORAGE_KEY, at)
    this.#commit({ lastSyncedAt: at, lastError: null })
  }

  /** 一次完整同步：先推 outbox，再拉到 head。单飞（并发调用共享同一个 promise）。 */
  async run(): Promise<SyncRunResult> {
    if (this.#running !== null) return this.#running
    const task = this.#runOnce().finally(() => {
      this.#running = null
    })
    this.#running = task
    return task
  }

  async #runOnce(): Promise<SyncRunResult> {
    const result: SyncRunResult = {
      pushed: 0,
      applied: 0,
      rejected: 0,
      appliedChanges: 0,
      cursor: this.#local.cursor,
      errors: [],
    }
    if (!this.#isOnline()) {
      this.#setPhase('offline')
      this.#commit({ lastError: { code: 'offline', message: '系统报告当前网络不可用' } })
      result.errors.push('offline: 变更暂存本地 outbox')
      return result
    }
    try {
      const push = await this.pushOnce()
      result.pushed = push.pushed
      result.applied = push.applied
      result.rejected = push.rejected
      const pull = await this.pullOnce()
      result.appliedChanges = pull.appliedChanges
      result.cursor = pull.cursor
      this.#attempts = 0
      this.#markSynced()
      this.#commit({
        phase: push.reasons.length > 0 ? 'conflict' : 'idle',
        pendingCount: this.#outbox.size,
      })
    } catch (err) {
      const failure = this.#classifyFailure(err)
      this.#attempts += 1
      result.errors.push(failure.code + ': ' + failure.message)
      this.#commit({
        phase: failure.phase,
        lastError: { code: failure.code, message: failure.message },
        pendingCount: this.#outbox.size,
      })
      // ★ 只有「等一会儿可能就好了」的错误才退避重试：
      //   登录凭据被服务端吊销时重试一万次也没用，只会每 30s 打一轮必然 401 的请求，
      //   让界面在「推送中 ↔ 离线」之间反复横跳（真实故障现场）。
      if (failure.retryable) this.#scheduleRetry()
    }
    this.#persist()
    return result
  }

  /** 平台层显式覆盖状态（例如浏览器 offline 事件）——UI 只读，不直接改状态。 */
  setPhase(phase: SyncStatus['phase']): void {
    this.#setPhase(phase)
  }

  /** 注入式等待（测试用；生产走 setTimeout）。 */
  sleep(ms: number): Promise<void> {
    return this.#sleep(ms)
  }

  /** 立刻重试一次（忽略退避），用于「用户点了同步」或网络恢复事件。 */
  async syncNow(): Promise<SyncRunResult> {
    this.#attempts = 0
    return this.run()
  }

  // ---------------------------------------------------------------- 退避与定时

  /** 指数退避：base * 2^attempts，封顶 maxBackoffMs（不含抖动）。 */
  computeBackoffMs(attempts: number = this.#attempts): number {
    const base = this.#config.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
    const max = this.#config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    const raw = base * 2 ** Math.max(0, attempts - 1)
    return Math.min(max, raw)
  }

  /** 带抖动的实际等待时间（避免多设备同时重试造成惊群）。 */
  nextRetryDelayMs(): number {
    const base = this.computeBackoffMs()
    if (this.#jitterRatio <= 0) return base
    return Math.round(base * (1 - this.#jitterRatio + Math.random() * this.#jitterRatio))
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== null) return
    const delay = this.nextRetryDelayMs()
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      void this.run()
    }, delay)
    const timer = this.#retryTimer as unknown as { unref?: () => void }
    timer.unref?.()
  }

  /** 开启周期同步（默认 30s）。返回停止函数。 */
  startAutoSync(intervalMs = 30000): () => void {
    this.stopAutoSync()
    this.#autoTimer = setInterval(() => {
      void this.run()
    }, intervalMs)
    const timer = this.#autoTimer as unknown as { unref?: () => void }
    timer.unref?.()
    return () => this.stopAutoSync()
  }

  stopAutoSync(): void {
    if (this.#autoTimer !== null) {
      clearInterval(this.#autoTimer)
      this.#autoTimer = null
    }
  }

  /** 释放所有计时器（测试/卸载时调用）。 */
  dispose(): void {
    this.stopAutoSync()
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    this.#offSessionInvalidated?.()
    this.#offSessionInvalidated = null
    this.#listeners.clear()
  }

  // ---------------------------------------------------------------- 内部

  async #withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    await this.#refreshIfExpired()
    try {
      return await fn()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && this.#session !== undefined) {
        // 刷新失败会抛 SessionInvalidatedError（不可恢复）或原始网络错误（可重试）。
        await this.#session.refresh()
        return await fn()
      }
      throw err
    }
  }

  /**
   * 主动刷新：access token 已过期/即将过期时先换新，不要发一个必然 401 的请求。
   *
   * 这样正常路径只需一次往返；同时把「凭据失效」从「推送失败」里区分出来 ——
   * 否则用户只会看到一句笼统的离线/推送失败，永远不知道要去重新登录。
   */
  async #refreshIfExpired(): Promise<void> {
    const session = this.#session
    if (session === undefined) return
    const noSession = session.hasSession?.() === false
    const expired = session.isAccessTokenExpired?.() === true
    if (!noSession && !expired) return
    await session.refresh()
  }

  /** 把一次失败归类成「相位 + 是否值得重试 + 给用户看的代码」。 */
  #classifyFailure(err: unknown): { code: string; message: string; phase: SyncStatus['phase']; retryable: boolean } {
    if (err instanceof SessionInvalidatedError) {
      return { code: 'auth_expired', message: err.invalidation.message, phase: 'auth', retryable: false }
    }
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) {
        return { code: 'auth_expired', message: err.message, phase: 'auth', retryable: false }
      }
      if (err.status === 0 || err.code === 'network_error' || err.code === 'timeout') {
        return { code: 'offline', message: err.message, phase: 'offline', retryable: true }
      }
      if (err.status === 429 || err.status >= 500) {
        return { code: 'server_error', message: err.message, phase: 'error', retryable: true }
      }
      return { code: err.code || 'invalid_request', message: err.message, phase: 'error', retryable: false }
    }
    if (err instanceof Error) {
      const transient = err.name === 'AbortError' || err.name === 'TimeoutError' || err.name === 'TypeError'
      return {
        code: transient ? 'offline' : 'client_error',
        message: err.message,
        phase: transient ? 'offline' : 'error',
        retryable: transient,
      }
    }
    return { code: 'unknown_error', message: String(err), phase: 'error', retryable: false }
  }

  #persist(): void {
    writeJson(this.#storage, LOCAL_STATE_STORAGE_KEY, this.#local)
  }

  #setPhase(phase: SyncStatus['phase']): void {
    this.#commit({ phase })
  }

  #commit(patch: Partial<SyncStatus>): void {
    this.#status = { ...this.#status, ...patch }
    for (const listener of this.#listeners) listener(this.#status)
  }
}

/** 构造引擎（依赖注入，便于联调脚本与单测使用干净实例）。 */
export function createSyncEngine(
  config: SyncEngineConfig,
  deps: SyncEngineDeps,
  hooks: SyncEngineHooks = {},
): SyncEngine {
  return new SyncEngine(config, deps, hooks)
}

/** 浏览器默认 storage（Node 下自动退化为内存实现）。 */
export function defaultStorage(): SyncStorage {
  return createBrowserStorage()
}

export type { AnnotationDto, Locator }
