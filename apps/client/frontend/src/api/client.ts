import type { paths } from './schema'

export type ApiPaths = paths

/**
 * 一次 HTTP 往返的原始记录（证据用）。
 *
 * spikes/sync 的联调脚本会把这些记录逐条落盘成 JSONL，作为「原始请求/响应」证据，
 * 而不是只在报告里贴结论。生产环境不传 onExchange 就没有任何开销。
 */
export interface HttpExchange {
  method: string
  url: string
  /** 请求体（JSON 会被解析；二进制只记类型与字节数，避免把整本书写进日志）。 */
  requestBody: unknown
  status: number
  responseBody: unknown
  durationMs: number
  error?: string
}

export interface ApiClientOptions {
  baseUrl: string
  getAccessToken?: () => string | null
  /** 证据钩子：每次往返（含失败）都会回调一次。 */
  onExchange?: (exchange: HttpExchange) => void
  /** 便于测试注入（默认 globalThis.fetch）。 */
  fetchImpl?: typeof fetch
  /** 单次请求超时（ms）。 */
  timeoutMs?: number
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ApiClient {
  readonly baseUrl: string
  request<T>(path: string, init?: RequestInit): Promise<T>
  requestVoid(path: string, init?: RequestInit): Promise<void>
  /** 原始字节 PUT（书籍文件上传）并保留 HTTP 状态码（201 首次 / 200 秒传命中）。 */
  putBinary<T>(path: string, body: Uint8Array | BodyInit, contentType: string): Promise<{ status: number; body: T }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseBody(text: string, contentType: string | null): unknown {
  if (text === '') return undefined
  const looksJson = contentType !== null && contentType.toLowerCase().includes('json')
  if (looksJson) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
  return text
}

/** 日志里的请求体：JSON 解析出来，二进制只留摘要。 */
function describeRequestBody(body: BodyInit | null | undefined): unknown {
  if (body === null || body === undefined) return undefined
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as unknown
    } catch {
      return body
    }
  }
  if (body instanceof Uint8Array) return { binary: true, bytes: body.byteLength }
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return { binary: true, bytes: body.byteLength }
  return { binary: true }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = options.baseUrl.replace(/\/+$/, '')
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 20000

  async function send(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const headers = new Headers(init.headers)
    const token = options.getAccessToken?.() ?? null
    if (token) headers.set('Authorization', 'Bearer ' + token)
    if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    const url = base + path
    const started = Date.now()
    let status = 0
    let body: unknown
    let failure: string | undefined

    try {
      const res = await doFetch(url, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      })
      status = res.status
      const text = res.status === 204 ? '' : await res.text()
      body = parseBody(text, res.headers.get('Content-Type'))
      if (!res.ok) {
        const code = isRecord(body) && typeof body['code'] === 'string' ? body['code'] : 'http_error'
        const message =
          isRecord(body) && typeof body['message'] === 'string'
            ? body['message']
            : String(status) + ' ' + res.statusText
        throw new ApiError(status, code, message, body)
      }
      return { status, body }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
      if (err instanceof ApiError) throw err
      throw new ApiError(status, 'network_error', failure)
    } finally {
      options.onExchange?.({
        method: init.method ?? 'GET',
        url,
        requestBody: describeRequestBody(init.body as BodyInit | null | undefined),
        status,
        responseBody: body,
        durationMs: Date.now() - started,
        ...(failure === undefined ? {} : { error: failure }),
      })
    }
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await send(path, init)
    return res.body as T
  }

  async function requestVoid(path: string, init: RequestInit = {}): Promise<void> {
    await send(path, init)
  }

  async function putBinary<T>(
    path: string,
    body: Uint8Array | BodyInit,
    contentType: string,
  ): Promise<{ status: number; body: T }> {
    const res = await send(path, {
      method: 'PUT',
      body: body as BodyInit,
      headers: { 'Content-Type': contentType },
    })
    return { status: res.status, body: res.body as T }
  }

  return { baseUrl: base, request, requestVoid, putBinary }
}
