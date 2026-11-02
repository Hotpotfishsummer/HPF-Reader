import { markRaw, onScopeDispose, shallowRef } from 'vue'
import { getSyncEngine, type SyncEngine } from '../index'
import type { SyncStatus } from '../../../platform/types'
import type { ProgressInput } from '../types'
import type { SyncOp } from '../../../api/contract'

/**
 * ★ markRaw：引擎实例绝不能被 Vue 的 Proxy 包住（内部有 Set/Map/计时器，身份必须稳定）。
 * ★ shallowRef：状态整体替换才触发更新（引擎每次提交都返回新对象）。
 *
 * 兼容性：SettingsView 只读 state.phase / state.pendingCount，本文件保持原有返回字段不变，
 * 额外增加 engine / syncNow / bootstrap，让 UI 能真正驱动同步。
 */
const engine: SyncEngine = markRaw(getSyncEngine())

export function useSyncStatus() {
  const state = shallowRef<SyncStatus>(engine.getStatus())
  const off = engine.subscribe((next) => {
    state.value = next
  })
  onScopeDispose(off)

  return {
    state,
    /** 真实引擎（入队/推送/拉取都通过它）。 */
    engine,
    /** 兼容旧签名：不传参数时什么都不做；传 ProgressInput 时入队一条进度变更。 */
    enqueue: (input?: ProgressInput): SyncOp | undefined => (input ? engine.enqueueProgress(input) : undefined),
    /** 兼容旧语义：把 outbox 冲上去（= syncNow）。 */
    flush: (): void => {
      void engine.syncNow()
    },
    setPhase: (phase: SyncStatus['phase']): void => engine.setPhase(phase),
    /** 立即同步一次并返回结果（新设备首同步用 bootstrap）。 */
    syncNow: () => engine.syncNow(),
    bootstrap: () => engine.bootstrap(),
  }
}
