/**
 * 同步生命周期协调器：把「已经写好但没人调用」的同步引擎接到应用生命周期上。
 *
 * 语义（逐条被 ./__tests__/coordinator.spec.ts 覆盖）：
 *   ① 未登录：**不发起任何同步请求**，phase 保持 idle；
 *   ② 登录后：先 bootstrap()（新设备首同步的快照）再 run()，随后 startAutoSync(30s)；
 *   ③ 登出：stopAutoSync()，此后不再发起请求；
 *   ④ window 'online' → syncNow()；启动时 navigator.onLine === false → phase = offline；
 *   ⑤ runtime 被重建（= 用户改了服务器地址）→ 停掉旧引擎的定时器，在**新**引擎上重新 bootstrap + 自动同步；
 *   ⑥ 页面重新可见（visibilitychange）且距上次同步 > 60s → syncNow()。
 *
 * ★ 引擎**惰性获取**：所有动作都经过 getEngine()，绝不把引擎实例存成长期闭包常量。
 *   改服务器地址后 getSyncEngine() 返回的是**新对象**，旧对象一旦被钉死就会永远同步到旧地址。
 *   （activeEngine 只用于「停掉我们自己启动过的那个定时器」，不用于读取状态。）
 * ★ 依赖注入：window / navigator / document / 计时器全部可替换，单测不依赖真实宿主。
 */
import type { SyncPhase, SyncStatus } from '../../platform/types'
import { getSyncEngine, getSyncRuntime, installServerUrlWatcher, onSyncRuntimeReplaced } from './runtime'

/** 默认自动同步周期（30s，与任务书一致）。 */
export const DEFAULT_AUTO_SYNC_MS = 30_000
/** 页面重新可见时的同步节流窗口：距上次同步不超过 60s 就不重复同步。 */
export const DEFAULT_VISIBILITY_THROTTLE_MS = 60_000
/** 登录态兜底轮询周期：登录/登出会主动 notifyAuthChanged()，轮询只用于兜住漏通知的路径。 */
export const DEFAULT_AUTH_POLL_MS = 5_000

type Listener = () => void

const ONLINE_EVENT = 'online'
const VISIBILITY_EVENT = 'visibilitychange'

/**
 * 协调器只需要引擎的这些能力（SyncEngine 结构上满足它，单测可注入假实现）。
 * 刻意不依赖 subscribe/outbox：协调器只负责「什么时候同步」，不负责展示。
 */
export interface SyncEngineLike {
  getStatus(): SyncStatus
  bootstrap(): Promise<unknown>
  run(): Promise<unknown>
  syncNow(): Promise<unknown>
  startAutoSync(intervalMs?: number): unknown
  stopAutoSync(): void
  setPhase(phase: SyncPhase): void
}

export interface SyncCoordinatorDeps {
  /** 惰性取引擎（默认 getSyncEngine；每次调用都要重新取）。 */
  getEngine?: () => SyncEngineLike
  /** 当前是否已登录（默认读 runtime 会话里的 accessToken）。 */
  isAuthenticated?: () => boolean
  /** 默认 navigator.onLine !== false。 */
  isOnline?: () => boolean
  /** 默认 document.visibilityState !== 'hidden'。 */
  isVisible?: () => boolean
  now?: () => number
  setInterval?: (handler: Listener, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  addEventListener?: (type: string, handler: Listener) => void
  removeEventListener?: (type: string, handler: Listener) => void
  /** runtime 被重建时的订阅（默认 onSyncRuntimeReplaced）。 */
  onRuntimeReplaced?: (listener: Listener) => () => void
  /** 订阅服务器地址变更并自动 rebuild（默认 installServerUrlWatcher）。 */
  installUrlWatcher?: () => () => void
  autoSyncMs?: number
  visibilityThrottleMs?: number
  authPollMs?: number
}

export interface SyncCoordinator {
  /** 挂载生命周期（幂等）。 */
  start(): void
  /** 卸载生命周期（幂等）：停止定时器、退订所有监听、停掉自动同步。 */
  stop(): void
  isRunning(): boolean
  /** 手动同步一次（未登录 / 离线时**不发请求**，只如实更新 phase）。 */
  syncNow(): Promise<void>
  /** 登录态变化提示：登录 → 启动会话同步；登出 → 停自动同步。 */
  notifyAuthChanged(): void
}

interface EventTargetLike {
  addEventListener?: (type: string, listener: Listener) => void
  removeEventListener?: (type: string, listener: Listener) => void
}

function globalEventTarget(): EventTargetLike {
  return globalThis as unknown as EventTargetLike
}

export function createSyncCoordinator(deps: SyncCoordinatorDeps = {}): SyncCoordinator {
  const getEngine = deps.getEngine ?? getSyncEngine
  const isAuthenticated =
    deps.isAuthenticated ?? (() => getSyncRuntime().session.accessToken !== null)
  const isOnline = deps.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false))
  const isVisible =
    deps.isVisible ?? (() => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'))
  const now = deps.now ?? (() => Date.now())
  const setIntervalFn =
    deps.setInterval ?? ((handler: Listener, ms: number) => globalThis.setInterval(handler, ms))
  const clearIntervalFn =
    deps.clearInterval ??
    ((handle: unknown) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>))
  const addEventListenerFn =
    deps.addEventListener ??
    ((type: string, listener: Listener) => globalEventTarget().addEventListener?.(type, listener))
  const removeEventListenerFn =
    deps.removeEventListener ??
    ((type: string, listener: Listener) => globalEventTarget().removeEventListener?.(type, listener))
  const onRuntimeReplaced =
    deps.onRuntimeReplaced ?? ((listener: Listener) => onSyncRuntimeReplaced(() => listener()))
  const installUrlWatcher = deps.installUrlWatcher ?? (() => installServerUrlWatcher())
  const autoSyncMs = deps.autoSyncMs ?? DEFAULT_AUTO_SYNC_MS
  const visibilityThrottleMs = deps.visibilityThrottleMs ?? DEFAULT_VISIBILITY_THROTTLE_MS
  const authPollMs = deps.authPollMs ?? DEFAULT_AUTH_POLL_MS

  let running = false
  let sessionActive = false
  /** 只用于停掉「我们自己启动过定时器」的那个引擎；读取状态一律走 getEngine()。 */
  let activeEngine: SyncEngineLike | null = null
  let lastSyncAt = 0
  /** 会话代际：登出 / runtime 重建会让进行中的 bootstrap 结果作废。 */
  let generation = 0
  let pollHandle: unknown = null
  let offRuntime: (() => void) | null = null
  let offUrlWatcher: (() => void) | null = null

  /** 只在 phase 真的不同的时候才写状态，避免轮询导致 UI 抖动。 */
  function ensurePhase(phase: SyncPhase): void {
    const engine = getEngine()
    if (engine.getStatus().phase !== phase) engine.setPhase(phase)
  }

  /**
   * 未登录 / 已停止时把相位复位成 idle —— 但**不能**盖掉 auth 与 error。
   *
   * ★ auth 相位是给用户看的结论（"登录已过期，请重新登录"）。如果每 5s 的轮询
   *   都把它擦回「空闲」，用户就又看到一个"一切正常"的绿点，而 135 条变更推不出去。
   */
  function resetPhaseIdle(): void {
    const phase = getEngine().getStatus().phase
    if (phase === 'auth' || phase === 'error') return
    ensurePhase('idle')
  }

  function isCurrentGeneration(gen: number): boolean {
    return running && sessionActive && generation === gen && activeEngine === getEngine()
  }

  function stopSession(resetPhase: boolean): void {
    generation += 1
    const engine = activeEngine
    sessionActive = false
    activeEngine = null
    if (engine !== null) engine.stopAutoSync()
    if (resetPhase) resetPhaseIdle()
  }

  /** 建立一次登录会话：bootstrap（快照）→ run（推+拉）→ 周期自动同步。 */
  async function activate(): Promise<void> {
    if (!running || !isAuthenticated() || !isOnline()) return
    const engine = getEngine()
    if (sessionActive && activeEngine === engine) return
    stopSession(false)
    sessionActive = true
    activeEngine = engine
    const gen = ++generation
    lastSyncAt = now()
    try {
      // 新设备首同步必须先把服务端快照落到本地投影；快照失败不阻塞常规同步。
      await engine.bootstrap()
    } catch {
      // 离线 / 服务端 5xx：run() 会走常规退避并把错误写进状态。
    }
    if (!isCurrentGeneration(gen)) return
    try {
      await engine.run()
    } catch {
      // run() 内部已处理错误并安排退避；这里只保证定时器一定会被装上。
    }
    if (!isCurrentGeneration(gen)) return
    engine.startAutoSync(autoSyncMs)
  }

  /** 依据「登录态 + 在线状态」决定当前应该处于哪种状态（幂等）。 */
  function evaluate(): void {
    if (!running) return
    if (!isAuthenticated()) {
      if (sessionActive) stopSession(true)
      else resetPhaseIdle()
      return
    }
    if (!isOnline()) {
      if (sessionActive) stopSession(false)
      ensurePhase('offline')
      return
    }
    void activate()
  }

  function handleAuthPoll(): void {
    evaluate()
  }

  function handleOnline(): void {
    // 网络恢复：立刻补一次同步（未登录 / 已停止时 syncNow 自己会直接返回）。
    void syncNow()
  }

  function handleVisibility(): void {
    if (!isVisible()) return
    if (!isAuthenticated() || !isOnline()) return
    if (now() - lastSyncAt < visibilityThrottleMs) return
    void syncNow()
  }

  function handleRuntimeReplaced(): void {
    if (!running) return
    // runtime 层已经 dispose 了旧引擎；这里再显式停掉我们启动过的定时器，
    // 然后走 evaluate()：getEngine() 会拿到**新**引擎，重新 bootstrap + 自动同步。
    stopSession(false)
    evaluate()
  }

  async function syncNow(): Promise<void> {
    if (!running) return
    if (!isOnline()) {
      ensurePhase('offline')
      return
    }
    if (!isAuthenticated()) return
    if (!sessionActive) {
      await activate()
      return
    }
    lastSyncAt = now()
    await getEngine().syncNow()
  }

  function notifyAuthChanged(): void {
    evaluate()
  }

  function start(): void {
    if (running) return
    running = true
    // 地址变更 → rebuild runtime → onSyncRuntimeReplaced 回调；二者缺一不可。
    offUrlWatcher = installUrlWatcher()
    offRuntime = onRuntimeReplaced(handleRuntimeReplaced)
    addEventListenerFn(ONLINE_EVENT, handleOnline)
    addEventListenerFn(VISIBILITY_EVENT, handleVisibility)
    pollHandle = setIntervalFn(handleAuthPoll, authPollMs)
    evaluate()
  }

  function stop(): void {
    if (!running) return
    running = false
    generation += 1
    if (pollHandle !== null) {
      clearIntervalFn(pollHandle)
      pollHandle = null
    }
    removeEventListenerFn(ONLINE_EVENT, handleOnline)
    removeEventListenerFn(VISIBILITY_EVENT, handleVisibility)
    if (offRuntime !== null) {
      offRuntime()
      offRuntime = null
    }
    if (offUrlWatcher !== null) {
      offUrlWatcher()
      offUrlWatcher = null
    }
    stopSession(false)
  }

  return {
    start,
    stop,
    isRunning: () => running,
    syncNow,
    notifyAuthChanged,
  }
}

// ---------------------------------------------------------------- 应用级单例

let lifecycle: SyncCoordinator | null = null

/** AppShell 挂载时调用（幂等）：创建并启动唯一的同步生命周期协调器。 */
export function startSyncLifecycle(deps: SyncCoordinatorDeps = {}): SyncCoordinator {
  if (lifecycle !== null) return lifecycle
  const coordinator = createSyncCoordinator(deps)
  coordinator.start()
  lifecycle = coordinator
  return coordinator
}

/** AppShell 卸载时调用（幂等）：停掉生命周期，避免重复的定时器与监听。 */
export function stopSyncLifecycle(): void {
  const current = lifecycle
  lifecycle = null
  current?.stop()
}

export function getSyncCoordinator(): SyncCoordinator | null {
  return lifecycle
}

/** 登录 / 登出后由 stores/auth 调用：让协调器立刻响应登录态变化（无需等轮询）。 */
export function notifyAuthChanged(): void {
  lifecycle?.notifyAuthChanged()
}
