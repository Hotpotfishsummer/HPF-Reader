import { resolveFetchTarget, getApiRelayTransport, type ApiRelayTransport } from './relay'
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
  /**
   * 便于测试注入的 XMLHttpRequest 工厂（默认 new XMLHttpRequest()）。
   *
   * ★ 书籍上传走 XHR 而不是 fetch：只有 `xhr.upload.onprogress` 能报告
   *   **请求体方向**的进度。没有进度，用户点下"上传"就只能盯着一个变灰的按钮。
   */
  xhrFactory?: () => XMLHttpRequest
  /** 单次请求超时（ms）。只作用于 JSON 小请求。 */
  timeoutMs?: number
  /**
   * 二进制请求（书籍上传 / 下载）的超时（ms），默认 30 分钟。
   *
   * ★ 必须与普通请求分开：`AbortSignal.timeout` 计时的是**整个 fetch**，
   *   包含请求体上传与响应体下载。书籍动辄几百 MB，20 秒的默认超时会在
   *   传输途中直接 abort（表现为 network_error，且服务端可能已经写了一半）。
   *   普通 API 调用是毫秒级的小 JSON，用不着这么长的预算。
   *
   * ★ 上传路径另有更贴切的看门狗（见 BinaryTransferOptions.stallTimeoutMs）：
   *   "多久没有任何字节进展"比"总共允许多久"更能识别卡死。
   */
  binaryTimeoutMs?: number
  /**
   * API 中继（桌面端由 platform/desktop.ts 注入；web / 移动端为 null）。
   *
   * 不传时回落到 api/relay.ts 的进程级当前值 —— 这样 Node 集成测试
   * 与业务代码都不用显式传参，而 desktop.ts 只需要 setApiRelayTransport()。
   */
  relayTransport?: ApiRelayTransport | null
}

/** 二进制传输的进度快照。 */
export interface TransferProgress {
  /** 已传输字节数。 */
  loaded: number
  /** 总字节数；未知（服务器没给 Content-Length / 分块编码）时为 null。 */
  total: number | null
}

/** 二进制传输的可选控制项。 */
export interface BinaryTransferOptions {
  /** 进度回调（每次有字节进展时调用）。 */
  onProgress?: (progress: TransferProgress) => void
  /** 取消信号：用户点"取消"时用它中断传输。 */
  signal?: AbortSignal
  /**
   * 停滞看门狗（ms）：**上传阶段**超过这个时间没有任何字节进展就中止。
   * 默认 30s。
   *
   * ★ 为什么不是"总时长上限"：一本书传 10 分钟完全正常，但 30 秒一个字节都没动
   *   就是卡死了（服务器不可达 / 中继卡住 / 代理黑洞）。两者必须分开判定。
   */
  stallTimeoutMs?: number
  /** 请求体发完之后，等服务器回话的上限（ms）。默认 120s。 */
  responseTimeoutMs?: number
}

/** 下载用的控制项（额外允许透传 fetch 的 init）。 */
export interface BinaryDownloadOptions extends BinaryTransferOptions {
  /** 透传给 fetch 的 init（method / headers 等）。 */
  init?: RequestInit
}

/**
 * 上传阶段默认停滞上限（ms）。
 *
 * ★ 60s 而不是更短：弱网大文件上传时，浏览器可能因为发送缓冲区满而**几十秒不发新的
 *   progress 事件**（中继 → 上游的链路一慢就会出现）。阈值太短会误判成"卡死"，
 *   把正在正常传输的上传打断。60s 既能识别真卡死（用户反馈的"卡了很久"远大于此），
 *   又不会误伤慢速上传。
 */
const defaultStallTimeoutMs = 60_000
/** 请求体发完后的默认响应等待上限（ms）。 */
const defaultBinaryResponseTimeoutMs = 120_000

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
  /**
   * 原始字节 PUT（书籍文件上传）并保留 HTTP 状态码（201 首次 / 200 秒传命中）。
   *
   * ★ 走 XHR：能报告上传进度、可取消、可识别"卡住"（停滞看门狗）。
   */
  putBinary<T>(
    path: string,
    body: Uint8Array,
    contentType: string,
    options?: BinaryTransferOptions,
  ): Promise<{ status: number; body: T }>
  /**
   * 原始字节 GET（书籍文件下载：GET /v1/books/{id}/file）。
   *
   * ★ 必须走 arrayBuffer：现有 request() 会把响应体当 text 读，UTF-8 解码会永久损坏
   *   EPUB/PDF 的二进制内容（且不会报错）。鉴权头、超时、onExchange 证据钩子与其它方法一致。
   */
  requestBinary(path: string, init?: RequestInit): Promise<Uint8Array>
  /** 带进度的原始字节 GET（下载进度条用）。 */
  requestBinaryWithProgress(path: string, options?: BinaryDownloadOptions): Promise<Uint8Array>
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
  /** 二进制端点专用预算：书籍上传/下载可能跑几十分钟。 */
  const binaryTimeoutMs = options.binaryTimeoutMs ?? 30 * 60 * 1000

  /** 当前生效的中继：显式传参优先（含显式 null），否则读进程级当前值。 */
  function relay(): ApiRelayTransport | null {
    return options.relayTransport === undefined ? getApiRelayTransport() : options.relayTransport
  }

  /**
   * 发一次请求：必要时改写成中继地址。
   *
   * ★ 证据里记录的必须是**原始 URL**（originalUrl），不是 127.0.0.1 的中继地址，
   *   否则联调证据无法核对真实端点。
   */
  function dispatch(target: string, init: RequestInit, headers: Headers): { url: string; originalUrl: string; res: Promise<Response> } {
    const resolved = resolveFetchTarget(target, headers, relay())
    return {
      url: resolved.url,
      originalUrl: resolved.originalUrl,
      res: doFetch(resolved.url, { ...init, headers: resolved.headers }),
    }
  }

  /** 统一构造请求头：唯一的 token 注入点（JSON 方法还会补默认 Content-Type）。 */
  function buildHeaders(init: RequestInit, defaultJsonContentType: boolean): Headers {
    const headers = new Headers(init.headers)
    const token = options.getAccessToken?.() ?? null
    if (token) headers.set('Authorization', 'Bearer ' + token)
    if (defaultJsonContentType && init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    return headers
  }

  async function send(
    path: string,
    init: RequestInit = {},
    budgetMs: number = timeoutMs,
  ): Promise<{ status: number; body: unknown }> {
    const headers = buildHeaders(init, true)

    const url = base + path
    const started = Date.now()
    let status = 0
    let body: unknown
    let failure: string | undefined

    try {
      const res = await dispatch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(budgetMs),
      }, headers).res
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

  /**
   * 原始字节 PUT（书籍文件上传）。
   *
   * ★ 用 XHR 而不是 fetch：只有 `xhr.upload.onprogress` 能报告**请求体方向**的进度。
   *   fetch 只能在响应方向给进度（`res.body` 流）；上传方向要么没有进度，
   *   要么依赖 request streaming（`duplex: 'half'`，各端支持度不齐，而且会丢 Content-Length）。
   *   书籍上传是"大文件 + 弱网"的典型场景，没有进度用户就只能盯着一个变灰的按钮干等。
   *
   * ★ 三段式超时判定：
   *   1. 上传阶段：超过 stallTimeoutMs **没有任何字节进展** ⇒ 中止（stall_timeout）；
   *   2. 请求体发完后：超过 responseTimeoutMs 还没响应 ⇒ 中止（response_timeout）；
   *   3. 用户主动取消 ⇒ canceled。
   *   （不再用"整个请求 30 分钟"一刀切：那会让真正的卡死也等满 30 分钟。）
   */
  function putBinary<T>(
    path: string,
    body: Uint8Array,
    contentType: string,
    transfer: BinaryTransferOptions = {},
  ): Promise<{ status: number; body: T }> {
    const url = base + path
    const started = Date.now()
    const headers = buildHeaders({ headers: { 'Content-Type': contentType } }, false)
    const resolved = resolveFetchTarget(url, headers, relay())
    const createXhr = options.xhrFactory ?? (() => new XMLHttpRequest())
    const stallMs = transfer.stallTimeoutMs ?? defaultStallTimeoutMs
    const responseMs = transfer.responseTimeoutMs ?? defaultBinaryResponseTimeoutMs

    return new Promise<{ status: number; body: T }>((resolve, reject) => {
      const xhr = createXhr()
      let settled = false
      let uploadFinished = false
      let lastProgressAt = Date.now()
      let status = 0
      let responseBody: unknown
      let failure: string | undefined
      let abortCode = 'canceled'
      let abortMessage = 'upload canceled'
      let watchdog: ReturnType<typeof setInterval> | undefined

      const cleanup = (): void => {
        if (watchdog !== undefined) clearInterval(watchdog)
        transfer.signal?.removeEventListener('abort', onAbort)
      }

      /** 唯一的收口：写证据 + resolve/reject，保证只发生一次。 */
      const settle = (result?: { status: number; body: T }, err?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        options.onExchange?.({
          method: 'PUT',
          url,
          requestBody: { binary: true, bytes: body.byteLength },
          status,
          responseBody,
          durationMs: Date.now() - started,
          ...(failure === undefined ? {} : { error: failure }),
        })
        if (err) reject(err)
        else resolve(result as { status: number; body: T })
      }

      const failWith = (code: string, message: string): void => {
        failure = message
        settle(undefined, new ApiError(status, code, message))
      }

      const abortWith = (code: string, message: string): void => {
        abortCode = code
        abortMessage = message
        try {
          xhr.abort()
        } catch {
          /* ignore */
        }
      }

      function onAbort(): void {
        abortWith('canceled', 'upload canceled')
      }

      xhr.open('PUT', resolved.url, true)
      xhr.responseType = 'text'
      for (const [key, value] of resolved.headers) xhr.setRequestHeader(key, value)

      xhr.upload.onprogress = (event: ProgressEvent) => {
        lastProgressAt = Date.now()
        transfer.onProgress?.({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : null,
        })
      }
      // 请求体已经发完 ⇒ 进入"等响应"阶段。
      xhr.upload.onload = () => {
        uploadFinished = true
        lastProgressAt = Date.now()
      }

      xhr.onload = () => {
        status = xhr.status
        const text = typeof xhr.responseText === 'string' ? xhr.responseText : ''
        responseBody = parseBody(text, xhr.getResponseHeader('Content-Type'))
        if (xhr.status >= 200 && xhr.status < 300) {
          settle({ status: xhr.status, body: responseBody as T })
          return
        }
        const code =
          isRecord(responseBody) && typeof responseBody['code'] === 'string'
            ? responseBody['code']
            : 'http_error'
        const message =
          isRecord(responseBody) && typeof responseBody['message'] === 'string'
            ? responseBody['message']
            : `${xhr.status} ${xhr.statusText}`
        failure = message
        settle(undefined, new ApiError(xhr.status, code, message, responseBody))
      }
      xhr.onerror = () => failWith('network_error', 'network error')
      xhr.ontimeout = () => failWith('response_timeout', 'upload timed out')
      xhr.onabort = () => failWith(abortCode, abortMessage)

      watchdog = setInterval(() => {
        if (settled) return
        const idle = Date.now() - lastProgressAt
        if (!uploadFinished && idle > stallMs) {
          abortWith('stall_timeout', `no upload progress for ${Math.round(idle / 1000)}s`)
          return
        }
        if (uploadFinished && idle > responseMs) {
          abortWith('response_timeout', `no response for ${Math.round(idle / 1000)}s`)
        }
      }, Math.max(50, Math.min(1000, Math.floor(stallMs / 4))))

      if (transfer.signal) {
        if (transfer.signal.aborted) {
          onAbort()
          return
        }
        transfer.signal.addEventListener('abort', onAbort, { once: true })
      }

      try {
        // Uint8Array 就是 BufferSource（ArrayBufferView）；TS 的 DOM lib 对泛型化后的
        // Uint8Array 与 XMLHttpRequestBodyInit 的匹配过严，这里显式收窄一次。
        xhr.send(body as unknown as XMLHttpRequestBodyInit)
      } catch (err) {
        failWith('network_error', err instanceof Error ? err.message : String(err))
      }
    })
  }

  async function requestBinary(path: string, init: RequestInit = {}): Promise<Uint8Array> {
    return requestBinaryWithProgress(path, { init })
  }

  /**
   * 带进度的原始字节 GET。
   *
   * ★ 用 `res.body` 的 reader 逐块读：这样才能报告下载进度，
   *   而 `arrayBuffer()` 要等整个响应收完才 resolve（用户只能干等）。
   *   响应没有 body 流时（老 WebView / 某些 mock）自动回落到 arrayBuffer。
   */
  async function requestBinaryWithProgress(
    path: string,
    transfer: BinaryDownloadOptions = {},
  ): Promise<Uint8Array> {
    const headers = buildHeaders(transfer.init ?? {}, false)
    const url = base + path
    const started = Date.now()
    let status = 0
    /** 证据里只记字节数，绝不记二进制内容。 */
    let bytes = 0
    let failure: string | undefined

    try {
      const res = await dispatch(url, {
        ...(transfer.init ?? {}),
        // ★ 二进制端点用长预算：整本书的下载会超过默认的 20s。
        signal: transfer.init?.signal ?? transfer.signal ?? AbortSignal.timeout(binaryTimeoutMs),
      }, headers).res
      status = res.status
      if (!res.ok) {
        // 错误响应仍然是 JSON 错误体（text 安全）：保持与 send() 一致的 ApiError 语义。
        const text = await res.text().catch(() => '')
        const body = parseBody(text, res.headers.get('Content-Type'))
        const code = isRecord(body) && typeof body['code'] === 'string' ? body['code'] : 'http_error'
        const message =
          isRecord(body) && typeof body['message'] === 'string'
            ? body['message']
            : String(status) + ' ' + res.statusText
        throw new ApiError(status, code, message, body)
      }

      const lengthHeader = res.headers.get('Content-Length')
      const total = lengthHeader === null ? null : Number(lengthHeader)
      const reader = res.body?.getReader()
      if (!reader) {
        const buffer = await res.arrayBuffer()
        bytes = buffer.byteLength
        transfer.onProgress?.({ loaded: bytes, total: bytes })
        return new Uint8Array(buffer)
      }

      const chunks: Uint8Array[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          bytes += value.byteLength
        }
        transfer.onProgress?.({
          loaded: bytes,
          total: total !== null && !Number.isNaN(total) ? total : null,
        })
      }
      const out = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
      }
      return out
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
      if (err instanceof ApiError) throw err
      throw new ApiError(status, 'network_error', failure)
    } finally {
      options.onExchange?.({
        method: transfer.init?.method ?? 'GET',
        url,
        requestBody: undefined,
        status,
        responseBody: { binary: true, bytes },
        durationMs: Date.now() - started,
        ...(failure === undefined ? {} : { error: failure }),
      })
    }
  }

  return { baseUrl: base, request, requestVoid, putBinary, requestBinary, requestBinaryWithProgress }
}
