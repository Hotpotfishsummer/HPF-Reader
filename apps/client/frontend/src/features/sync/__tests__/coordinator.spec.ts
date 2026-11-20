import { describe, expect, it } from 'vitest'
import {
  createSyncCoordinator,
  DEFAULT_AUTO_SYNC_MS,
  DEFAULT_VISIBILITY_THROTTLE_MS,
  getSyncCoordinator,
  startSyncLifecycle,
  stopSyncLifecycle,
  type SyncEngineLike,
} from '../coordinator'
import type { SyncPhase, SyncStatus } from '../../../platform/types'

/**
 * 协调器单测：不碰真实 runtime / 网络 / 宿主全局。
 *
 * 四个必测语义（对应任务书）：
 *   ① 未登录不请求；
 *   ② 登录后 bootstrap → run → startAutoSync(30s)；
 *   ③ 改服务器地址（runtime 重建）后旧引擎定时器被停、新引擎被使用；
 *   ④ navigator.onLine === false → phase = offline 且不请求。
 */

class FakeEngine implements SyncEngineLike {
  readonly calls: string[] = []
  phase: SyncPhase = 'idle'
  autoSyncMs: number | null = null
  #status: SyncStatus = { phase: 'idle', pendingCount: 0, lastSyncedAt: null, lastError: null }

  getStatus(): SyncStatus {
    return this.#status
  }

  async bootstrap(): Promise<number> {
    this.calls.push('bootstrap')
    return 0
  }

  async run(): Promise<unknown> {
    this.calls.push('run')
    return {}
  }

  async syncNow(): Promise<unknown> {
    this.calls.push('syncNow')
    return {}
  }

  startAutoSync(intervalMs?: number): () => void {
    this.calls.push(`startAutoSync:${intervalMs ?? 0}`)
    this.autoSyncMs = intervalMs ?? null
    return () => this.stopAutoSync()
  }

  stopAutoSync(): void {
    this.calls.push('stopAutoSync')
    this.autoSyncMs = null
  }

  setPhase(phase: SyncPhase): void {
    this.calls.push(`setPhase:${phase}`)
    this.phase = phase
    this.#status = { ...this.#status, phase }
  }
}

interface Harness {
  coordinator: ReturnType<typeof createSyncCoordinator>
  engine: () => FakeEngine
  setAuth: (value: boolean) => void
  setOnline: (value: boolean) => void
  setVisible: (value: boolean) => void
  advance: (ms: number) => void
  fire: (type: string) => void
  tickPoll: () => void
  replaceRuntime: () => void
}

function createHarness(
  options: { authenticated?: boolean; online?: boolean; visible?: boolean } = {},
): Harness {
  let authenticated = options.authenticated ?? false
  let online = options.online ?? true
  let visible = options.visible ?? true
  let clock = 1_000_000
  let current = new FakeEngine()
  const listeners = new Map<string, Set<() => void>>()
  const intervals = new Map<number, () => void>()
  let nextTimerId = 1
  let runtimeReplaced: (() => void) | null = null

  const coordinator = createSyncCoordinator({
    getEngine: () => current,
    isAuthenticated: () => authenticated,
    isOnline: () => online,
    isVisible: () => visible,
    now: () => clock,
    setInterval: (handler) => {
      const id = nextTimerId
      nextTimerId += 1
      intervals.set(id, handler)
      return id
    },
    clearInterval: (handle) => {
      intervals.delete(handle as number)
    },
    addEventListener: (type, handler) => {
      let set = listeners.get(type)
      if (set === undefined) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(handler)
    },
    removeEventListener: (type, handler) => {
      listeners.get(type)?.delete(handler)
    },
    onRuntimeReplaced: (listener) => {
      runtimeReplaced = listener
      return () => {
        runtimeReplaced = null
      }
    },
    installUrlWatcher: () => () => {},
  })

  return {
    coordinator,
    engine: () => current,
    setAuth: (value) => {
      authenticated = value
    },
    setOnline: (value) => {
      online = value
    },
    setVisible: (value) => {
      visible = value
    },
    advance: (ms) => {
      clock += ms
    },
    fire: (type) => {
      for (const handler of [...(listeners.get(type) ?? [])]) handler()
    },
    tickPoll: () => {
      for (const handler of [...intervals.values()]) handler()
    },
    replaceRuntime: () => {
      current = new FakeEngine()
      runtimeReplaced?.()
    },
  }
}

/** 让 activate() 内部的 await 链跑完。 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('createSyncCoordinator', () => {
  it('① 未登录时不发起任何同步请求，phase 保持 idle', async () => {
    const h = createHarness({ authenticated: false })
    h.coordinator.start()
    await flush()

    expect(h.engine().calls).toEqual([])
    expect(h.engine().phase).toBe('idle')
    expect(h.engine().autoSyncMs).toBeNull()

    // 在线恢复 / 页面可见事件也不应产生请求。
    h.fire('online')
    h.setVisible(true)
    h.fire('visibilitychange')
    await flush()
    expect(h.engine().calls).toEqual([])
  })

  it('② 登录后先 bootstrap 再 run，随后开启 30s 自动同步', async () => {
    const h = createHarness({ authenticated: false })
    h.coordinator.start()
    await flush()
    expect(h.engine().calls).toEqual([])

    h.setAuth(true)
    h.coordinator.notifyAuthChanged()
    await flush()

    expect(h.engine().calls).toEqual(['bootstrap', 'run', `startAutoSync:${DEFAULT_AUTO_SYNC_MS}`])
    expect(h.engine().autoSyncMs).toBe(DEFAULT_AUTO_SYNC_MS)
  })

  it('③ runtime 重建后停掉旧引擎定时器，并在新引擎上重新 bootstrap + 自动同步', async () => {
    const h = createHarness({ authenticated: true })
    h.coordinator.start()
    await flush()

    const oldEngine = h.engine()
    expect(oldEngine.autoSyncMs).toBe(DEFAULT_AUTO_SYNC_MS)

    h.replaceRuntime()
    await flush()

    expect(oldEngine.calls).toContain('stopAutoSync')
    expect(oldEngine.autoSyncMs).toBeNull()

    const newEngine = h.engine()
    expect(newEngine).not.toBe(oldEngine)
    expect(newEngine.calls).toEqual(['bootstrap', 'run', `startAutoSync:${DEFAULT_AUTO_SYNC_MS}`])
    expect(newEngine.autoSyncMs).toBe(DEFAULT_AUTO_SYNC_MS)
  })

  it('④ 离线启动 → phase=offline 且不请求；网络恢复后补一次同步', async () => {
    const h = createHarness({ authenticated: true, online: false })
    h.coordinator.start()
    await flush()

    expect(h.engine().phase).toBe('offline')
    expect(h.engine().calls).toEqual(['setPhase:offline'])
    expect(h.engine().autoSyncMs).toBeNull()

    h.setOnline(true)
    h.fire('online')
    await flush()

    expect(h.engine().calls).toEqual([
      'setPhase:offline',
      'bootstrap',
      'run',
      `startAutoSync:${DEFAULT_AUTO_SYNC_MS}`,
    ])
  })

  it('⑤ 页面重新可见且距上次同步 > 60s 才 syncNow', async () => {
    const h = createHarness({ authenticated: true })
    h.coordinator.start()
    await flush()
    const engine = h.engine()
    const base = engine.calls.length

    // 刚同步过：60s 内不重复同步。
    h.fire('visibilitychange')
    await flush()
    expect(engine.calls.length).toBe(base)

    // 隐藏状态下永远不触发。
    h.setVisible(false)
    h.advance(DEFAULT_VISIBILITY_THROTTLE_MS + 1)
    h.fire('visibilitychange')
    await flush()
    expect(engine.calls.length).toBe(base)

    h.setVisible(true)
    h.fire('visibilitychange')
    await flush()
    expect(engine.calls.slice(base)).toEqual(['syncNow'])
  })

  it('⑥ 登出后停止自动同步，且不再发起任何请求', async () => {
    const h = createHarness({ authenticated: true })
    h.coordinator.start()
    await flush()
    const engine = h.engine()
    expect(engine.autoSyncMs).toBe(DEFAULT_AUTO_SYNC_MS)

    h.setAuth(false)
    h.coordinator.notifyAuthChanged()
    await flush()

    expect(engine.autoSyncMs).toBeNull()
    expect(engine.phase).toBe('idle')

    const before = engine.calls.length
    h.fire('online')
    h.coordinator.notifyAuthChanged()
    h.advance(DEFAULT_VISIBILITY_THROTTLE_MS + 1)
    h.fire('visibilitychange')
    await flush()
    expect(engine.calls.length).toBe(before)
  })

  it('⑦ 轮询兜底：漏掉 notifyAuthChanged 也能在登录后启动同步', async () => {
    const h = createHarness({ authenticated: false })
    h.coordinator.start()
    await flush()

    h.setAuth(true)
    h.tickPoll()
    await flush()

    expect(h.engine().calls).toEqual(['bootstrap', 'run', `startAutoSync:${DEFAULT_AUTO_SYNC_MS}`])
  })

  it('stop() 后事件监听全部退订，online/visibility 不再触发任何请求', async () => {
    const h = createHarness({ authenticated: true })
    h.coordinator.start()
    await flush()
    h.coordinator.stop()
    const engine = h.engine()
    const before = engine.calls.length
    expect(engine.autoSyncMs).toBeNull()

    h.fire('online')
    h.fire('visibilitychange')
    h.advance(DEFAULT_VISIBILITY_THROTTLE_MS + 1)
    h.fire('visibilitychange')
    await flush()
    expect(engine.calls.length).toBe(before)
  })
})

describe('sync lifecycle 单例', () => {
  it('startSyncLifecycle 幂等复用，stopSyncLifecycle 释放', async () => {
    const engine = new FakeEngine()
    const first = startSyncLifecycle({
      getEngine: () => engine,
      isAuthenticated: () => true,
      isOnline: () => true,
      onRuntimeReplaced: () => () => {},
      installUrlWatcher: () => () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    })
    expect(first.isRunning()).toBe(true)
    expect(startSyncLifecycle({})).toBe(first)
    expect(getSyncCoordinator()).toBe(first)

    stopSyncLifecycle()
    await flush()
    expect(getSyncCoordinator()).toBeNull()
    expect(first.isRunning()).toBe(false)
    expect(engine.autoSyncMs).toBeNull()
  })
})
