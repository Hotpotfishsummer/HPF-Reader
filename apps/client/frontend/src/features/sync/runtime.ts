import { createApiClient, type ApiClient } from '../../api/client'
import { createAuthApi } from '../../api/endpoints'
import { AuthSession } from './session'
import { createBrowserStorage, type SyncStorage } from './storage'
import { createSyncEngine, SyncEngine } from './engine'
import type { SyncEngineConfig, SyncEngineDeps } from './types'

/** Web/server 目标的默认后端地址（与 platform/server.ts 用同一个环境变量）。 */
export function defaultApiBaseUrl(): string {
  const configured = import.meta.env.VITE_HPF_API_BASE
  if (typeof configured === 'string' && configured !== '') return configured
  return 'http://127.0.0.1:8080'
}

export interface SyncRuntimeOptions {
  baseUrl?: string
  storage?: SyncStorage
  deviceId?: string
  deviceName?: string
  platform?: SyncEngineConfig['platform']
  /** 证据钩子：把每次 HTTP 往返交给调用方（联调脚本落盘原始请求/响应）。 */
  onExchange?: Parameters<typeof createApiClient>[0]['onExchange']
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
    getAccessToken: () => session?.accessToken ?? null,
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

/** 显式配置单例（例如登录后注入已知设备 ID / 自定义 baseUrl）。 */
export function configureSyncEngine(options: SyncRuntimeOptions = {}): SyncRuntime {
  singleton?.dispose()
  const runtime = createSyncRuntime(options)
  singletonRuntime = runtime
  singleton = runtime.engine
  return runtime
}

export function getSyncRuntime(): SyncRuntime {
  getSyncEngine()
  if (singletonRuntime === null) throw new Error('sync runtime not initialised')
  return singletonRuntime
}
