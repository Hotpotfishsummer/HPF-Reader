/**
 * 服务器地址（自建后端）的**纯逻辑层**：不含任何 Vue / Pinia 依赖。
 *
 * 为什么必须与 Pinia store 分开（这不是洁癖，是踩过的坑）：
 *   - 同步引擎（features/sync/runtime.ts）、api client 在 Node 环境（集成测试 / 联调脚本）
 *     也要读这个地址；如果它们 import 了 stores/server.ts，就会把 pinia 拖进 Node 打包产物，
 *     集成测试直接 `ERR_MODULE_NOT_FOUND: Cannot find package 'pinia'`。
 *   - 所以：**纯函数放这里**，UI 状态（draft/loading/测试结果）放 stores/server.ts。
 *
 * 三条关键语义：
 *  1. 非组件环境也要能**同步**读到地址；
 *  2. 只用一个持久化键，UI 与引擎读到的永远是同一份值；
 *  3. 变更通过 `onServerUrlChanged` 广播，同步链路据此重建（改地址立即生效，不重启应用）。
 */

// ★ 只 import 纯逻辑的 relay（无 bindings / 无 pinia / 无 @wailsio/runtime），
//   因此本文件仍然可以在 Node 集成测试里直接使用。
import { relayFetch } from '../api/relay'

/** 持久化键（Pinia persist 与直接读写共用）。 */
export const SERVER_STORAGE_KEY = 'qkf.qyyr.l7'

/**
 * 未配置时的默认地址（与 platform/server.ts 的 VITE_HPF_API_BASE 语义一致）。
 *
 * ★ 指向生产环境，而不是 `http://127.0.0.1:8080`：
 *   桌面端是发给普通用户装的，默认值必须是「装完就能用」的公网地址。
 *   原先的本地地址会让新用户把登录请求打到自己的 8080 端口（本机 Docker / 别的服务
 *   会接走这个请求并返回 401），表现为「密码明明对，却提示 invalid email or password」。
 *
 * 开发时连本地后端：设置页改地址即可（存 localStorage，保存即生效，不必改代码）；
 * 或构建时设 VITE_HPF_API_BASE 覆盖（见 envDefault）。
 */
export const DEFAULT_SERVER_URL = 'https://library.coldpotfish.lat'

export interface ServerProbeResult {
  ok: boolean
  /** 往返耗时（ms）。 */
  latencyMs: number
  /** 成功时是服务端 `/healthz` 的 status，失败时是错误信息。 */
  message: string
}

type Listener = (baseUrl: string) => void

const listeners = new Set<Listener>()
let cached: string | null = null

/** 归一化用户输入：补协议、去尾斜杠；空串 → 默认地址。 */
export function normalizeServerUrl(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return DEFAULT_SERVER_URL
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : 'http://' + trimmed
  return withScheme.replace(/\/+$/, '')
}

function envDefault(): string {
  const configured = import.meta.env?.VITE_HPF_API_BASE
  if (typeof configured === 'string' && configured !== '') return normalizeServerUrl(configured)
  return DEFAULT_SERVER_URL
}

/** 同步读取当前生效的服务器地址（可在组件之外调用）。 */
export function readServerUrl(): string {
  if (cached !== null) return cached
  try {
    const raw = globalThis.localStorage?.getItem(SERVER_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { baseUrl?: unknown }
      if (typeof parsed?.baseUrl === 'string' && parsed.baseUrl.trim() !== '') {
        cached = normalizeServerUrl(parsed.baseUrl)
        return cached
      }
    }
  } catch {
    // localStorage 不可用（Node 测试 / 隐私模式 / 配额满）：退回默认地址，不抛。
  }
  cached = envDefault()
  return cached
}

/** 写入服务器地址（立即生效）并通知订阅者。返回归一化后的地址。 */
export function writeServerUrl(raw: string): string {
  const url = normalizeServerUrl(raw)
  cached = url
  try {
    globalThis.localStorage?.setItem(SERVER_STORAGE_KEY, JSON.stringify({ baseUrl: url }))
  } catch {
    // 写不进去也要让本次会话生效（内存缓存已更新）。
  }
  for (const listener of [...listeners]) listener(url)
  return url
}

/** 订阅地址变更；返回取消订阅函数。 */
export function onServerUrlChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试辅助：清掉内存缓存（localStorage 由测试自行准备）。 */
export function resetServerUrlCacheForTest(): void {
  cached = null
}

/**
 * 探测服务器是否可达（GET /healthz，不要求登录）。
 *
 * 走 relayFetch：桌面端这条请求同样经本机 Go 中继（API 不经过 Chromium 的 TLS），
 * 否则在证书有问题的网络里会出现「设置页显示连不上、但实际请求都成功」的分裂。
 * 它不带任何 token，因此即便退化为直连也没有凭据泄漏面。
 */
export async function probeServer(rawUrl: string, timeoutMs = 5000): Promise<ServerProbeResult> {
  const url = normalizeServerUrl(rawUrl)
  const started = Date.now()
  try {
    const res = await relayFetch(url + '/healthz', {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    })
    const latencyMs = Date.now() - started
    if (!res.ok) {
      return { ok: false, latencyMs, message: 'HTTP ' + res.status + ' ' + res.statusText }
    }
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null
    const status = body && typeof body.status === 'string' ? body.status : 'ok'
    return { ok: true, latencyMs, message: status }
  } catch (err) {
    const latencyMs = Date.now() - started
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, latencyMs, message }
  }
}
