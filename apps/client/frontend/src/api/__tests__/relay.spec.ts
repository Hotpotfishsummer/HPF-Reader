import { describe, expect, it } from 'vitest'
import { createApiClient } from '../client'
import {
  RELAY_PATH,
  RELAY_TARGET_QUERY,
  RELAY_TOKEN_HEADER,
  buildRelayRequest,
  decodeRelayTarget,
  encodeRelayTarget,
  getApiRelayTransport,
  relayFetch,
  resolveFetchTarget,
  setApiRelayTransport,
  shouldRelayUrl,
} from '../relay'

/**
 * API 中继的 URL 改写测试（P0：C→S 传输认证的前端半边）。
 *
 * 关键不变式：
 *   1. 桌面端（transport 可用）时，https URL **必须**被改写成本机中继地址，
 *      否则 API 流量仍会经过 Chromium 的 TLS，`--ignore-certificate-errors`
 *      的漏洞就还在；
 *   2. 证据（onExchange）里记录的必须是**原始 URL**，不是 127.0.0.1 的中继地址；
 *   3. web / 移动端（transport 为 null）必须原样直连，不能被中继逻辑污染。
 */

const TRANSPORT = { baseURL: 'http://127.0.0.1:54321', token: 'test-token-abc' }

describe('encodeRelayTarget / decodeRelayTarget', () => {
  it('往返编解码保持原样（含中文与查询串）', () => {
    const targets = [
      'https://api.example.com/v1/books?limit=200&cursor=a%2Fb',
      'https://api.example.com/v1/books/中文 id/file',
      'http://127.0.0.1:8080/healthz',
      'https://[::1]:8443/v1/sync/push',
    ]
    for (const target of targets) {
      expect(decodeRelayTarget(encodeRelayTarget(target))).toBe(target)
    }
  })

  it('输出 base64url（无 + / =），与 Go 的 RawURLEncoding 对应', () => {
    const encoded = encodeRelayTarget('https://api.example.com/v1/books?x=???>>>~~~')
    expect(encoded).not.toMatch(/[+/=]/)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('解码 padding 形式也安全（宽容输入）', () => {
    const encoded = encodeRelayTarget('https://api.example.com/v1/books')
    const withPadding = encoded + '='.repeat((4 - (encoded.length % 4)) % 4)
    expect(decodeRelayTarget(withPadding)).toBe('https://api.example.com/v1/books')
  })
})

describe('shouldRelayUrl', () => {
  it('https / http 需要中继', () => {
    expect(shouldRelayUrl('https://api.example.com/v1/books')).toBe(true)
    expect(shouldRelayUrl('HTTPS://API.EXAMPLE.COM/v1/books')).toBe(true)
    expect(shouldRelayUrl('http://127.0.0.1:8080/healthz')).toBe(true)
  })

  it('相对路径 / 其它协议不中继', () => {
    expect(shouldRelayUrl('/v1/books')).toBe(false)
    expect(shouldRelayUrl('ws://example.com/x')).toBe(false)
    expect(shouldRelayUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('buildRelayRequest', () => {
  it('拼出 <base>/r?u=<base64url> 并带上中继 token 头', () => {
    const target = 'https://api.example.com/v1/books?limit=200'
    const { url, headers } = buildRelayRequest(TRANSPORT, target)

    expect(url.startsWith(`http://127.0.0.1:54321${RELAY_PATH}?${RELAY_TARGET_QUERY}=`)).toBe(true)
    expect(headers[RELAY_TOKEN_HEADER]).toBe('test-token-abc')

    const query = new URL(url).searchParams.get(RELAY_TARGET_QUERY)
    expect(query).not.toBeNull()
    expect(decodeRelayTarget(query as string)).toBe(target)
  })

  it('baseURL 末尾的斜杠不会产生双斜杠', () => {
    const { url } = buildRelayRequest({ ...TRANSPORT, baseURL: 'http://127.0.0.1:54321/' }, 'https://a.example/x')
    expect(url).toBe('http://127.0.0.1:54321/r?u=' + encodeRelayTarget('https://a.example/x'))
  })
})

describe('resolveFetchTarget', () => {
  it('transport 可用 → 改写 URL 并追加 token 头，同时保留原始 URL', () => {
    const target = 'https://api.example.com/v1/books'
    const resolved = resolveFetchTarget(target, { Authorization: 'Bearer xyz' }, TRANSPORT)

    expect(resolved.relayed).toBe(true)
    expect(resolved.originalUrl).toBe(target)
    expect(resolved.url).toContain('127.0.0.1:54321')
    expect(resolved.headers.get(RELAY_TOKEN_HEADER)).toBe(TRANSPORT.token)
    // 业务头必须保留（token 由 Go 侧透传给上游）。
    expect(resolved.headers.get('Authorization')).toBe('Bearer xyz')
  })

  it('transport 为 null（web/移动端）→ 原样直连', () => {
    const target = 'https://api.example.com/v1/books'
    const resolved = resolveFetchTarget(target, { Authorization: 'Bearer xyz' }, null)

    expect(resolved.relayed).toBe(false)
    expect(resolved.url).toBe(target)
    expect(resolved.originalUrl).toBe(target)
    expect(resolved.headers.get(RELAY_TOKEN_HEADER)).toBeNull()
  })

  it('非 http(s) 目标即使有 transport 也不改写', () => {
    const resolved = resolveFetchTarget('ws://example.com/x', undefined, TRANSPORT)
    expect(resolved.relayed).toBe(false)
    expect(resolved.url).toBe('ws://example.com/x')
  })
})

describe('relayFetch', () => {
  it('经中继时把请求打到中继地址并带 token 头', async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    await relayFetch('https://api.example.com/v1/books', { method: 'GET' }, fakeFetch, TRANSPORT)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('127.0.0.1:54321/r?u=')
    expect(calls[0]?.headers.get(RELAY_TOKEN_HEADER)).toBe(TRANSPORT.token)
  })

  it('无 transport 时直接用原始 URL（不引入中继地址）', async () => {
    const calls: string[] = []
    const fakeFetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    await relayFetch('https://api.example.com/v1/books', {}, fakeFetch, null)

    expect(calls).toEqual(['https://api.example.com/v1/books'])
  })
})

describe('setApiRelayTransport', () => {
  it('设置与读取进程级当前值', () => {
    setApiRelayTransport(TRANSPORT)
    expect(getApiRelayTransport()).toEqual(TRANSPORT)
  })

  it('空 baseURL / 空 token 视为不可用（诚实降级为直连）', () => {
    setApiRelayTransport({ baseURL: '', token: 'x' })
    expect(getApiRelayTransport()).toBeNull()
    setApiRelayTransport({ baseURL: 'http://127.0.0.1:1', token: '' })
    expect(getApiRelayTransport()).toBeNull()
  })

  it('null 重置', () => {
    setApiRelayTransport(TRANSPORT)
    setApiRelayTransport(null)
    expect(getApiRelayTransport()).toBeNull()
  })
})

describe('api client 经中继但不污染证据', () => {
  it('★ 证据里记录原始 URL（不是 127.0.0.1 中继地址）', async () => {
    const seenUrls: string[] = []
    const fakeFetch = (async (input: RequestInfo | URL) => {
      seenUrls.push(String(input))
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const exchanges: Array<{ url: string }> = []
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      fetchImpl: fakeFetch,
      relayTransport: TRANSPORT,
      onExchange: (exchange) => exchanges.push({ url: exchange.url }),
    })

    await client.request('/v1/books?limit=200')

    // 实际请求走了中继……
    expect(seenUrls).toHaveLength(1)
    expect(seenUrls[0]).toContain('127.0.0.1:54321/r?u=')
    // ……但证据记录的是原始 URL，否则无法核对真实端点。
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0]?.url).toBe('https://api.example.com/v1/books?limit=200')
  })

  it('二进制上传同样经中继，且 Content-Type / body 不被破坏', async () => {
    const payload = new Uint8Array([0x00, 0xff, 0x10, 0x7f])
    let capturedUrl = ''
    let capturedBody: unknown
    let capturedContentType: string | null = null

    // 上传走 XHR（只有它能报告请求体方向的进度）：这里注入一个假 XHR 来观察。
    const fakeXhr = {
      method: '',
      url: '',
      responseType: '',
      status: 201,
      statusText: 'Created',
      responseText: JSON.stringify({ id: 'b1' }),
      sent: null as unknown,
      aborted: false,
      requestHeaders: {} as Record<string, string>,
      upload: { onprogress: null, onload: null },
      onload: null as (() => void) | null,
      onerror: null,
      onabort: null,
      ontimeout: null,
      open(method: string, url: string) {
        this.method = method
        this.url = url
      },
      setRequestHeader(key: string, value: string) {
        this.requestHeaders[key] = value
      },
      getResponseHeader() {
        return 'application/json'
      },
      send(body: unknown) {
        this.sent = body
      },
      abort() {
        this.aborted = true
      },
    }

    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      xhrFactory: () => fakeXhr as unknown as XMLHttpRequest,
      relayTransport: TRANSPORT,
    })

    const promise = client.putBinary('/v1/books/b1/file', payload, 'application/octet-stream')
    capturedUrl = fakeXhr.url
    capturedBody = fakeXhr.sent
    capturedContentType = fakeXhr.requestHeaders['Content-Type'] ?? null
    fakeXhr.onload?.()

    await promise
    expect(capturedUrl).toContain('127.0.0.1:54321/r?u=')
    expect(capturedBody).toBe(payload)
    expect(capturedContentType).toBe('application/octet-stream')
  })

  it('二进制下载经中继，返回原始字节', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    let capturedUrl = ''

    const fakeFetch = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    }) as typeof fetch

    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      fetchImpl: fakeFetch,
      relayTransport: TRANSPORT,
    })

    const bytes = await client.requestBinary('/v1/books/b1/file')
    expect(capturedUrl).toContain('127.0.0.1:54321/r?u=')
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5])
  })

  it('relayTransport 显式 null 覆盖进程级当前值（web 端语义）', async () => {
    setApiRelayTransport(TRANSPORT)
    const calls: string[] = []
    const fakeFetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      fetchImpl: fakeFetch,
      relayTransport: null,
    })
    await client.request('/v1/books')
    expect(calls).toEqual(['https://api.example.com/v1/books'])
    setApiRelayTransport(null)
  })
})
