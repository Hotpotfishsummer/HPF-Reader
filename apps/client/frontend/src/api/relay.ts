/**
 * API 中继（纯逻辑，无 bindings / 无 pinia / 无 @wailsio/runtime）。
 *
 * 背景（P0：C→S 传输认证）：
 *   桌面端 WebView2 曾带 `--ignore-certificate-errors`，渲染层 fetch 的 HTTPS
 *   实际上不校验证书，链路中间人（含用户自配的远程代理节点）可以拿走
 *   Bearer / refresh token。现在 API 请求**不再经过 Chromium 的 TLS**：
 *   渲染层把请求发给本机 Go 中继（`http://127.0.0.1:<port>/r?u=<base64url>`），
 *   由 Go 用系统根证书严格校验后出网。于是 `--ignore-certificate-errors` 对 API 彻底失效。
 *
 * 为什么放在 api/ 而不是 platform/：
 *   这里是**纯函数 + 一个可注入的 fetch 包装**，Node 侧集成测试与单测可以直接用；
 *   平台层只负责把 `{baseURL, token}` 送进来（见 platform/desktop.ts）。
 */

/** 本机中继的连接信息（由 Go 侧 `APIRelayService.RelayTransport()` 提供）。 */
export interface ApiRelayTransport {
  /** 形如 http://127.0.0.1:<随机端口>。 */
  baseURL: string
  /** 每次进程启动都不同的一次性 token，放进 X-HPF-Relay 头。 */
  token: string
}

/** 中继的路径与请求头约定（与 apps/client/apirelay.go 保持一致）。 */
export const RELAY_PATH = '/r'
export const RELAY_TARGET_QUERY = 'u'
export const RELAY_TOKEN_HEADER = 'X-HPF-Relay'

let currentTransport: ApiRelayTransport | null = null

/** 设置当前中继（桌面端在平台创建时注入；web/移动端为 null = 直接用原生 fetch）。 */
export function setApiRelayTransport(transport: ApiRelayTransport | null): void {
  currentTransport =
    transport && transport.baseURL !== '' && transport.token !== '' ? transport : null
}

/** 读取当前中继（测试/排障用）。 */
export function getApiRelayTransport(): ApiRelayTransport | null {
  return currentTransport
}

/** UTF-8 → base64url（无 padding），与 Go 的 base64.RawURLEncoding 对应。 */
export function encodeRelayTarget(target: string): string {
  const bytes = new TextEncoder().encode(target)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url → UTF-8（encodeRelayTarget 的逆运算）。 */
export function decodeRelayTarget(encoded: string): string {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** 判断一个绝对 URL 是否需要经过中继（http 目标由 Go 侧决定是否放行）。 */
export function shouldRelayUrl(target: string): boolean {
  const lower = target.toLowerCase()
  return lower.startsWith('https://') || lower.startsWith('http://')
}

/**
 * 把目标 URL 改写成中继地址，并返回需要附加的请求头。
 *
 * 纯函数：不读全局状态，便于单测与"证据里记录原始 URL"的断言。
 */
export function buildRelayRequest(
  transport: ApiRelayTransport,
  target: string,
): { url: string; headers: Record<string, string> } {
  const base = transport.baseURL.replace(/\/+$/, '')
  return {
    url: `${base}${RELAY_PATH}?${RELAY_TARGET_QUERY}=${encodeRelayTarget(target)}`,
    headers: { [RELAY_TOKEN_HEADER]: transport.token },
  }
}

/**
 * 需要中继的请求就改写 URL 与请求头，否则原样返回。
 *
 * `origin` 原样保留在 `originalUrl` 里 —— 证据（onExchange）必须记录**原始 URL**，
 * 否则联调证据里会全是 127.0.0.1 的中继地址，无法核对真实端点。
 */
export interface ResolvedFetchTarget {
  url: string
  headers: Headers
  originalUrl: string
  relayed: boolean
}

export function resolveFetchTarget(
  target: string,
  initHeaders: HeadersInit | undefined,
  transport: ApiRelayTransport | null,
): ResolvedFetchTarget {
  const headers = new Headers(initHeaders)
  if (transport === null || !shouldRelayUrl(target)) {
    return { url: target, headers, originalUrl: target, relayed: false }
  }
  const relay = buildRelayRequest(transport, target)
  for (const [key, value] of Object.entries(relay.headers)) headers.set(key, value)
  return { url: relay.url, headers, originalUrl: target, relayed: true }
}

/**
 * 走中继的 fetch。
 *
 * - transport 为 null（web / 移动端 / 中继未启动）时直接用注入的 fetchImpl；
 * - 否则改写 URL 并加 `X-HPF-Relay` 头；
 * - `fetchImpl` 可注入，单测不需要真的联网。
 *
 * ★ 注意：只有这里知道"原始 URL"。调用方要记录证据的话，请用 resolveFetchTarget
 *   自己拿到 originalUrl（api/client.ts 就是这么做的）。
 */
export function relayFetch(
  target: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = globalThis.fetch,
  transport: ApiRelayTransport | null = currentTransport,
): Promise<Response> {
  const resolved = resolveFetchTarget(target, init.headers, transport)
  return fetchImpl(resolved.url, { ...init, headers: resolved.headers })
}
