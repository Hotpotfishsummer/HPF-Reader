import { createApiClient, type ApiClient } from '../../api/client'
import { createAuthApi } from '../../api/endpoints'
// ★ 必须 import 纯逻辑模块（stores/serverUrl），不能 import stores/server.ts ——
//   后者会拖入 pinia，Node 集成测试会 ERR_MODULE_NOT_FOUND。
import { readServerUrl, writeServerUrl, onServerUrlChanged } from '../../stores/serverUrl'
import { AuthSession } from './session'
import { createBrowserStorage, type SyncStorage } from './storage'
import { createSyncEngine, SyncEngine } from './engine'
import type { SyncEngineConfig, SyncEngineDeps } from './types'

/**
 * 当前生效的服务端地址（设置页可改；见 stores/server.ts）。
 * 保留函数名是因为联调脚本/单测已经按这个名字引用它。
 */
export function defaultApiBaseUrl(): string {
  return readServerUrl()
}

export interface SyncRuntimeOptions {
  baseUrl?: string
  storage?: SyncStorage
  deviceId?: string
  deviceName?: string
  platform?: SyncEngineConfig['platform']
  /** 证据钩子：把每次 HTTP 往返交给调用方（联调脚本落盘原始请求/响应）。 */
  onExchange?: Parameters<typeof createApiClient>[0]['onExchange']
  /**
   * 注入 fetch 实现（测试用）。
   *
   * ★ 需要它才能测「过期 token → 自动刷新 → 重试」这条链路：
   *   单测 api client 只能证明客户端**支持**刷新，证明不了 runtime **真的把回调接上了**。
   *   漏接回调时客户端测试依然全绿，线上却照样报 `invalid or expired token`。
   */
  fetchImpl?: typeof fetch
}

export interface SyncRuntime {
  engine: SyncEngine
  session: AuthSession
  client: ApiClient
}

/**
 * 组装「客户端 api 层 + 认证会话 + 同步引擎」的一条完整链路。
 *
 * 本文件刻意不 import vue：Node 联调脚本与单测可以直接用它（见 spikes/sync/e2e.ts）。
 */
export function createSyncRuntime(options: SyncRuntimeOptions = {}): SyncRuntime {
  const storage = options.storage ?? createBrowserStorage()
  const baseUrl = options.baseUrl ?? defaultApiBaseUrl()
  let session: AuthSession | null = null
  const client = createApiClient({
    baseUrl,
    ...(options.onExchange === undefined ? {} : { onExchange: options.onExchange }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    getAccessToken: () => session?.accessToken ?? null,
    /**
     * ★ 401 兜底：任何走 `getApi()` 的调用（书库列表 / 上传 / 下载）都能自动换新令牌。
     *
     * 以前这个能力只存在于同步引擎的 `#withAuthRetry` 里，而书库是直接调 `getApi()` 的，
     * 于是 access token 一过期，进书库第一眼就是 `invalid or expired token`，
     * 非要点一次「刷新云端」才好 —— 那一次点击只是碰巧赶上了别处的刷新。
     *
     * 返回 null 表示刷不出来（没有 refresh token / 服务端吊销）：调用方按原样抛 401，
     * 由上层引导重新登录，不在这里假装成功。
     */
    refreshAccessToken: async () => {
      if (session === null) return null
      try {
        const tokens = await session.refresh()
        return tokens.accessToken
      } catch {
        return null
      }
    },
  })
  session = AuthSession.load(storage, createAuthApi(client), options.deviceId ?? null)
  const config: SyncEngineConfig = {
    baseUrl,
    ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
    ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  }
  const deps: SyncEngineDeps = { client, storage }
  const engine = createSyncEngine(config, deps, { session })
  session.setDeviceId(engine.deviceId)
  return { engine, session, client }
}

let singleton: SyncEngine | null = null
let singletonRuntime: SyncRuntime | null = null

/** 应用运行期单例：UI 与平台层都从这里拿引擎。 */
export function getSyncEngine(): SyncEngine {
  if (singleton === null) {
    const runtime = createSyncRuntime()
    singletonRuntime = runtime
    singleton = runtime.engine
  }
  return singleton
}

/**
 * 显式配置单例（例如登录后注入已知设备 ID / 自定义 baseUrl）。
 *
 * ★ 重建语义：outbox、本地投影、设备 ID、会话令牌全部来自 storage，
 *   所以重建**不会丢待推送变更**（这也是能安全支持"运行期改服务器地址"的前提）。
 */
export function configureSyncEngine(options: SyncRuntimeOptions = {}): SyncRuntime {
  singleton?.dispose()
  singleton = null
  singletonRuntime = null
  const runtime = createSyncRuntime(options)
  singletonRuntime = runtime
  singleton = runtime.engine
  // ★ 不需要手工作废 api 单例：api/runtime 缓存的是「runtime 身份 → Api」，
  //   这里换成新 runtime 后，下次 getApi() 自动重建（避免两文件循环 import）。
  for (const listener of [...replacedListeners]) listener(runtime)
  return runtime
}

/** runtime 被重建（例如服务器地址变化）时的订阅点：UI 需要把订阅从旧引擎挪到新引擎。 */
const replacedListeners = new Set<(runtime: SyncRuntime) => void>()

export function onSyncRuntimeReplaced(listener: (runtime: SyncRuntime) => void): () => void {
  replacedListeners.add(listener)
  return () => {
    replacedListeners.delete(listener)
  }
}

export function getSyncRuntime(): SyncRuntime {
  getSyncEngine()
  if (singletonRuntime === null) throw new Error('sync runtime not initialised')
  return singletonRuntime
}

/** 服务器地址变更后重建整条链路（同步引擎 + api client + 会话绑定）。 */
export function rebuildSyncRuntime(baseUrl?: string): SyncRuntime {
  return configureSyncEngine(baseUrl === undefined ? {} : { baseUrl })
}

/**
 * 应用启动时安装一次：用户改地址后自动重建。
 * 返回取消订阅函数（测试用）。
 */
export function installServerUrlWatcher(): () => void {
  return onServerUrlChanged((url) => {
    rebuildSyncRuntime(url)
  })
}

export { writeServerUrl }
