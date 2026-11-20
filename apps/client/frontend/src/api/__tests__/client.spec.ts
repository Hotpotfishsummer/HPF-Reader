import { describe, expect, it } from 'vitest'
import { createApiClient } from '../client'

/**
 * API 客户端的**二进制端点**契约测试。
 *
 * 这组用例守住三条硬性不变式：
 *
 *   ① 二进制端点（书籍上传 / 下载）**不能**套用 JSON 请求的 20 秒默认超时。
 *      `AbortSignal.timeout` 计时的是整个 fetch（含请求体上传与响应体下载），
 *      一本几百 MB 的书必然超时 —— 表现是"下载到一半 network_error"，
 *      而且服务端可能已经写了一半。历史上正是这个 20s 把大文件传输掐死的。
 *
 *   ② 二进制端点的字节必须**逐字节**原样往返：
 *      走 text 解码会永久损坏 EPUB/PDF（UTF-8 解码不可逆，且不报错）。
 *
 *   ③ 上传必须有**进度、可取消、能识别卡死**：
 *      书籍上传是长耗时操作，只有一个 loading 布尔值的话，
 *      用户点下按钮之后只能盯着一个变灰的按钮猜状况（这正是线上反馈的问题）。
 */

interface Captured {
  url: string
  method: string
  body: unknown
  contentType: string
}

/** 造一个"永远不返回"的 fetch：用来观察超时是否按预算生效。 */
function hangingFetch(captured: Captured[] = []): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body,
      contentType: new Headers(init?.headers ?? {}).get('Content-Type') ?? '',
    })
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      })
    })
  }) as unknown as typeof fetch
}

/**
 * 可控的假 XHR：上传路径走 XHR（只有它能报告**请求体方向**的进度），
 * 所以单测必须能手动驱动 upload.onprogress / onload / 响应。
 */
class FakeXhr {
  method = ''
  url = ''
  responseType = ''
  status = 200
  statusText = 'OK'
  responseText = ''
  sent: unknown = null
  aborted = false
  readonly requestHeaders: Record<string, string> = {}
  readonly responseHeaders: Record<string, string> = {}

  upload: {
    onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null
    onload: (() => void) | null
  } = { onprogress: null, onload: null }

  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(key: string, value: string): void {
    this.requestHeaders[key] = value
  }

  getResponseHeader(key: string): string | null {
    return this.responseHeaders[key] ?? null
  }

  send(body: unknown): void {
    this.sent = body
  }

  abort(): void {
    this.aborted = true
    this.onabort?.()
  }

  /** 模拟"又传了 n 个字节"。 */
  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true })
  }

  /** 模拟"请求体已经发完"。 */
  finishUpload(): void {
    this.upload.onload?.()
  }

  /** 模拟服务端回话。 */
  respond(status: number, body: string, contentType = 'application/json'): void {
    this.status = status
    this.statusText = status === 200 ? 'OK' : 'Error'
    this.responseText = body
    this.responseHeaders['Content-Type'] = contentType
    this.onload?.()
  }
}

/** 记录最后一次创建的假 XHR（测试用它驱动上传过程）。 */
let lastXhr: FakeXhr | null = null

function fakeXhrFactory(): () => XMLHttpRequest {
  return () => {
    lastXhr = new FakeXhr()
    return lastXhr as unknown as XMLHttpRequest
  }
}

describe('二进制端点的超时预算', () => {
  it('JSON 请求受 timeoutMs 约束（默认 20s 由调用方覆盖验证）', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      timeoutMs: 30,
      fetchImpl: hangingFetch(),
    })
    await expect(client.request('/v1/books')).rejects.toThrow()
  })

  it('二进制请求**不受** timeoutMs 约束，只受 binaryTimeoutMs 约束', async () => {
    // timeoutMs 给 1ms（二进制不该用它），binaryTimeoutMs 给 60ms。
    // 如果实现错误地复用 timeoutMs，请求会立刻被 abort；
    // 正确实现下它会活到 binaryTimeoutMs 才失败。
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      timeoutMs: 1,
      binaryTimeoutMs: 60,
      fetchImpl: hangingFetch(),
    })
    const started = Date.now()
    await expect(client.requestBinary('/v1/books/x/file')).rejects.toThrow()
    // 至少等到了 binaryTimeoutMs 附近（允许 1ms 抖动 + 环境调度误差）。
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
  })

  it('二进制上传走 XHR，不受 JSON 超时预算影响', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      timeoutMs: 1,
      binaryTimeoutMs: 60,
      xhrFactory: fakeXhrFactory(),
    })
    // 上传路径完全不经过 fetch：timeoutMs 再小也不该影响它。
    const promise = client.putBinary('/v1/books/x/file', new Uint8Array([1, 2, 3]), 'application/epub+zip')
    const xhr = lastXhr!
    expect(xhr.method).toBe('PUT')
    xhr.respond(201, JSON.stringify({ contentHash: 'sha256:x', sizeBytes: 3 }))
    await expect(promise).resolves.toMatchObject({ status: 201 })
  })
})

describe('二进制端点的字节完整性', () => {
  it('requestBinary 原样返回字节（不被 UTF-8 解码损坏）', async () => {
    // 含 0x00 / 0xFF / 0x10 等 UTF-8 解码会破坏的字节。
    const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x10, 0x80, 0x7f])
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      fetchImpl: (async () =>
        new Response(payload, { status: 200, headers: { 'Content-Type': 'application/epub+zip' } })) as typeof fetch,
    })

    const bytes = await client.requestBinary('/v1/books/x/file')
    expect(Array.from(bytes)).toEqual(Array.from(payload))
  })

  it('putBinary 原样发送字节，并带对 Content-Type', async () => {
    const payload = new Uint8Array([0x00, 0x01, 0x02, 0xfd, 0xfe, 0xff])
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      xhrFactory: fakeXhrFactory(),
    })

    const promise = client.putBinary('/v1/books/x/file', payload, 'application/epub+zip')
    const xhr = lastXhr!
    xhr.respond(201, JSON.stringify({ contentHash: 'sha256:x', sizeBytes: payload.byteLength }))

    const res = await promise
    expect(res.status).toBe(201)
    expect(xhr.method).toBe('PUT')
    expect(xhr.requestHeaders['Content-Type']).toBe('application/epub+zip')
    expect(Array.from(xhr.sent as Uint8Array)).toEqual(Array.from(payload))
  })

  it('二进制端点的 4xx 仍然抛出结构化 ApiError', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: 'not_found', message: 'book file has not been uploaded yet' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch,
    })
    await expect(client.requestBinary('/v1/books/x/file')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
  })

  it('上传的 4xx 也抛出结构化 ApiError（服务端 code 透传）', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      xhrFactory: fakeXhrFactory(),
    })
    const promise = client.putBinary('/v1/books/x/file', new Uint8Array([1]), 'application/epub+zip')
    lastXhr!.respond(507, JSON.stringify({ code: 'quota_exceeded', message: 'storage quota exceeded' }))
    await expect(promise).rejects.toMatchObject({ status: 507, code: 'quota_exceeded' })
  })
})

describe('上传的进度 / 取消 / 卡死识别', () => {
  it('上传进度按字节回调（loaded/total）', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      xhrFactory: fakeXhrFactory(),
    })
    const seen: Array<{ loaded: number; total: number | null }> = []
    const promise = client.putBinary('/v1/books/x/file', new Uint8Array(100), 'application/epub+zip', {
      onProgress: (p) => seen.push({ loaded: p.loaded, total: p.total }),
    })
    const xhr = lastXhr!
    xhr.progress(25, 100)
    xhr.progress(80, 100)
    xhr.finishUpload()
    xhr.respond(201, JSON.stringify({ ok: true }))
    await promise

    expect(seen).toEqual([
      { loaded: 25, total: 100 },
      { loaded: 80, total: 100 },
    ])
  })

  it('用户取消 ⇒ canceled（而不是含糊的 network_error）', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      xhrFactory: fakeXhrFactory(),
    })
    const controller = new AbortController()
    const promise = client.putBinary('/v1/books/x/file', new Uint8Array(10), 'application/epub+zip', {
      signal: controller.signal,
    })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ code: 'canceled' })
    expect(lastXhr!.aborted).toBe(true)
  })

  it('长时间没有任何字节进展 ⇒ stall_timeout（能识别"卡住"）', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      xhrFactory: fakeXhrFactory(),
    })
    const promise = client.putBinary('/v1/books/x/file', new Uint8Array(10), 'application/epub+zip', {
      stallTimeoutMs: 120,
    })
    await expect(promise).rejects.toMatchObject({ code: 'stall_timeout' })
  })

  it('持续有进展时不会误判为卡死', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      xhrFactory: fakeXhrFactory(),
    })
    const promise = client.putBinary('/v1/books/x/file', new Uint8Array(10), 'application/epub+zip', {
      stallTimeoutMs: 120,
    })
    const xhr = lastXhr!
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 40))
      xhr.progress(i + 1, 10)
    }
    xhr.finishUpload()
    xhr.respond(201, JSON.stringify({ ok: true }))
    await expect(promise).resolves.toMatchObject({ status: 201 })
  })

  it('请求体发完但服务器不回话 ⇒ response_timeout', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      xhrFactory: fakeXhrFactory(),
    })
    const promise = client.putBinary('/v1/books/x/file', new Uint8Array(10), 'application/epub+zip', {
      responseTimeoutMs: 120,
    })
    lastXhr!.finishUpload()
    await expect(promise).rejects.toMatchObject({ code: 'response_timeout' })
  })
})
