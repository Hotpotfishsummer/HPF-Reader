import { computed, markRaw, onScopeDispose, shallowRef } from 'vue'
import type { SyncStatus } from '../../../platform/types'
import type { AnnotationCreate, SyncOp } from '../../../api/contract'
import type { ProgressInput } from '../types'
import type { SyncEngine } from '../engine'
import { getSyncEngine, onSyncRuntimeReplaced } from '../runtime'

/**
 * ★ markRaw：引擎实例绝不能被 Vue 的 Proxy 包住（内部有 Set/Map/计时器，身份必须稳定）。
 * ★ shallowRef：状态整体替换才触发更新（引擎每次提交都返回新对象）。
 * ★ 惰性 + 跟随重建：服务器地址变更后 runtime 会换成**新引擎**，
 *   本 composable 通过 onSyncRuntimeReplaced 把订阅从旧引擎挪到新引擎，
 *   所以 engine / syncNow / enqueue 读到的永远当前生效的引擎。
 *
 * 兼容性：SettingsView 只读 state.phase / state.pendingCount，本文件保持这些字段不变，
 * 并提供 engine / syncNow / bootstrap / enqueue / enqueueAnnotation / flush / lastSyncedAt。
 */
export function useSyncStatus() {
  let engine: SyncEngine = markRaw(getSyncEngine())
  const state = shallowRef<SyncStatus>(engine.getStatus())
  let off: () => void = engine.subscribe((next) => {
    state.value = next
  })

  const offReplaced = onSyncRuntimeReplaced(() => {
    off()
    engine = markRaw(getSyncEngine())
    state.value = engine.getStatus()
    off = engine.subscribe((next) => {
      state.value = next
    })
  })

  onScopeDispose(() => {
    off()
    offReplaced()
  })

  /** 上次成功同步时间（引擎状态里就是 null 表示从未同步）。 */
  const lastSyncedAt = computed<number | null>(() => state.value.lastSyncedAt)

  return {
    state,
    /** 当前生效的引擎（getter：runtime 重建后自动指向新引擎）。 */
    get engine(): SyncEngine {
      return engine
    },
    /** 立即同步一次并返回结果（新设备首同步用 bootstrap）。 */
    syncNow: () => engine.syncNow(),
    bootstrap: () => engine.bootstrap(),
    /** 兼容旧签名：不传参数时什么都不做；传 ProgressInput 时入队一条进度变更。 */
    enqueue: (input?: ProgressInput): SyncOp | undefined => (input ? engine.enqueueProgress(input) : undefined),
    /** 入队一条标注变更（input 缺省 = 删除）。 */
    enqueueAnnotation: (bookId: string, annotationId: string, input?: AnnotationCreate): SyncOp =>
      engine.enqueueAnnotation(bookId, annotationId, input),
    /** 兼容旧语义：把 outbox 冲上去（= syncNow）。 */
    flush: (): void => {
      void engine.syncNow()
    },
    setPhase: (phase: SyncStatus['phase']): void => engine.setPhase(phase),
    lastSyncedAt,
  }
}
