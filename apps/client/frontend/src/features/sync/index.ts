/**
 * 同步引擎对外入口。
 *
 * 单例与运行时组装在 ./runtime.ts（不 import vue，Node 脚本可直接用）；
 * Vue 侧适配在 ./composables/useSyncStatus.ts（markRaw + shallowRef）。
 */
export { SyncEngine, createSyncEngine, defaultStorage, LOCAL_STATE_STORAGE_KEY, DEVICE_ID_STORAGE_KEY } from './engine'
export type { PushOutcome, PullOutcome, SyncEngineHooks } from './engine'
export { Outbox, OUTBOX_STORAGE_KEY } from './outbox'
export { AuthSession, SESSION_STORAGE_KEY } from './session'
export type { AuthApiLike, StoredSession } from './session'
export { applyChange, applyPull, applySnapshot } from './apply'
export {
  HLC_DEV_DIGITS,
  HLC_LENGTH,
  HLC_SEQ_DIGITS,
  HLC_TIME_DIGITS,
  HybridLogicalClock,
  compareHlc,
  devicePrefixFromId,
  isValidHlc,
  normalizeDevicePrefix,
  parseHlc,
} from './hlc'
export type { ParsedHlc } from './hlc'
export { createBrowserStorage, createMemoryStorage, readJson, writeJson } from './storage'
export type { SyncStorage } from './storage'
export { newDeviceId, uuidv7 } from './uuid'
export * from './types'
export { configureSyncEngine, createSyncRuntime, defaultApiBaseUrl, getSyncEngine, getSyncRuntime } from './runtime'
export type { SyncRuntime, SyncRuntimeOptions } from './runtime'
export { useSyncStatus } from './composables/useSyncStatus'
