import { getSyncRuntime, type SyncRuntime } from '../features/sync/runtime'
import { createApi, type Api } from './endpoints'

/**
 * 资源 API 的进程内单例。
 *
 * ★ 必须跟着同步运行时走：用户改服务器地址后 features/sync/runtime 会重建 runtime
 *   （新的 baseUrl + 新的 api client），这里如果继续复用旧 client，就会出现
 *   「设置页显示新地址、请求仍然打到旧地址」的经典分裂。
 *   所以缓存的是 (runtime 身份 → Api)，runtime 变了就重建，不需要任何手工 reset 调用。
 */
let apiSingleton: Api | null = null
let apiRuntime: SyncRuntime | null = null

export function getApi(): Api {
  const runtime = getSyncRuntime()
  if (apiSingleton === null || apiRuntime !== runtime) {
    apiSingleton = createApi(runtime.client)
    apiRuntime = runtime
  }
  return apiSingleton
}

export function useApi(): Api {
  return getApi()
}

/** 显式失效缓存（服务器地址变更后由同步运行时调用；幂等）。 */
export function resetApi(): void {
  apiSingleton = null
  apiRuntime = null
}
