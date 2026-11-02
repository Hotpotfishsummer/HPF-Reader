import type { SyncPhase, SyncStatus } from '@/platform/types'

/**
 * 同步引擎状态（M1 骨架）。
 *
 * 为什么独立成类、而不是直接放 Pinia（docs/research/50-vue3-reader-stack.md §3.4）：
 *   1. Pinia 会把 store state 深度 reactive → 引擎内部的 Set/Map/计时器句柄被 Proxy 包裹，
 *      身份不一致会真的出错（和 foliate-js 同类问题）；
 *   2. 同步状态高频变更，进响应式 store 会放大重渲染；
 *   3. 引擎真相区必须能在**无 Vue 环境**下单测。
 *
 * UI 侧只做一层薄适配：见 features/sync/composables/useSyncStatus.ts。
 */
export class SyncEngine {
  #state: SyncStatus = {
    phase: 'idle',
    pendingCount: 0,
    lastSyncedAt: null,
    lastError: null,
  }

  #listeners = new Set<(state: SyncStatus) => void>()

  getState(): SyncStatus {
    return this.#state
  }

  subscribe(listener: (state: SyncStatus) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** M1：本地 outbox 计数（真正的推送由 Go 侧拥有，见 ADR-002 §4）。 */
  setPhase(phase: SyncPhase): void {
    this.#commit({ phase })
  }

  enqueue(): void {
    this.#commit({ pendingCount: this.#state.pendingCount + 1 })
  }

  flush(): void {
    this.#commit({ pendingCount: 0, lastSyncedAt: Date.now(), lastError: null })
  }

  #commit(patch: Partial<SyncStatus>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener(this.#state)
  }
}

/** 单例：markRaw 语义由调用方保证（composable 里用 markRaw 包住）。 */
export const syncEngine = new SyncEngine()
