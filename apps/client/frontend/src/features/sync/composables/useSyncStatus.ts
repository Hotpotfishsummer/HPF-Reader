import { markRaw, onScopeDispose, shallowRef } from 'vue'
import { SyncEngine, syncEngine } from '@/sync/engine'
import type { SyncStatus } from '@/platform/types'

/** ★ markRaw：引擎实例绝不能被 Vue 的 Proxy 包住。 */
const engine: SyncEngine = markRaw(syncEngine)

/** 薄响应式适配：整体替换才触发更新（shallowRef）。 */
export function useSyncStatus() {
  const state = shallowRef<SyncStatus>(engine.getState())
  const off = engine.subscribe((next) => {
    state.value = next
  })
  onScopeDispose(off)
  return {
    state,
    enqueue: () => engine.enqueue(),
    flush: () => engine.flush(),
    setPhase: (phase: SyncStatus['phase']) => engine.setPhase(phase),
  }
}
