import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useServerStore } from '../server'
import {
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  onServerUrlChanged,
  probeServer,
  readServerUrl,
  resetServerUrlCacheForTest,
  SERVER_STORAGE_KEY,
  writeServerUrl,
} from '../serverUrl'

/**
 * 服务器地址（自建后端）单测。
 *
 * 这里守的是三条容易出错的语义：
 *  1. 输入归一化（用户会填 "192.168.1.10:8080" 这种不带协议的写法）；
 *  2. **一个持久化键**：UI 与同步引擎读到的必须是同一个值（否则"改了地址请求还打旧地址"）；
 *  3. 「测试连接」失败必须如实返回失败，不能伪装成功。
 */
describe('server address store', () => {
  beforeEach(() => {
    localStorage.clear()
    resetServerUrlCacheForTest()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    resetServerUrlCacheForTest()
  })

  it('归一化：补协议、去尾斜杠、空串回默认', () => {
    expect(normalizeServerUrl('192.168.1.10:8080')).toBe('http://192.168.1.10:8080')
    expect(normalizeServerUrl('  https://books.example.com/  ')).toBe('https://books.example.com')
    expect(normalizeServerUrl('http://127.0.0.1:8080///')).toBe('http://127.0.0.1:8080')
    expect(normalizeServerUrl('')).toBe(DEFAULT_SERVER_URL)
    expect(normalizeServerUrl('   ')).toBe(DEFAULT_SERVER_URL)
    expect(normalizeServerUrl(null)).toBe(DEFAULT_SERVER_URL)
    // 已有协议不能被再次前缀
    expect(normalizeServerUrl('https://a.example')).toBe('https://a.example')
  })

  it('写入后立即可读，并且落在约定的持久化键里（UI 与引擎同一份真相）', () => {
    expect(readServerUrl()).toBe(DEFAULT_SERVER_URL)

    writeServerUrl('https://my.server:8443/')
    resetServerUrlCacheForTest()

    expect(readServerUrl()).toBe('https://my.server:8443')
    const raw = localStorage.getItem(SERVER_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual({ baseUrl: 'https://my.server:8443' })
  })

  it('地址变更会广播给订阅者，取消订阅后不再收到', () => {
    const seen: string[] = []
    const off = onServerUrlChanged((url) => seen.push(url))

    writeServerUrl('http://10.0.0.5:9000')
    off()
    writeServerUrl('http://10.0.0.6:9000')

    expect(seen).toEqual(['http://10.0.0.5:9000'])
  })

  it('store.save() 立即生效并持久化，store.reset() 回到默认地址', () => {
    const store = useServerStore()
    expect(store.isDefault).toBe(true)

    store.draft = 'books.lan:8080'
    const saved = store.save()
    expect(saved).toBe('http://books.lan:8080')
    expect(store.baseUrl).toBe('http://books.lan:8080')
    expect(store.isDefault).toBe(false)
    resetServerUrlCacheForTest()
    expect(readServerUrl()).toBe('http://books.lan:8080')

    store.reset()
    expect(store.baseUrl).toBe(DEFAULT_SERVER_URL)
    expect(store.isDefault).toBe(true)
  })

  it('probeServer：200 且 status=ok 时成功，并带回往返耗时', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    )
    const result = await probeServer('books.lan:8080')
    expect(result.ok).toBe(true)
    expect(result.message).toBe('ok')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('probeServer：非 2xx 与网络异常都如实返回失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })))
    const bad = await probeServer('http://127.0.0.1:9')
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('502')

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const down = await probeServer('http://127.0.0.1:9')
    expect(down.ok).toBe(false)
    expect(down.message).toContain('ECONNREFUSED')
  })
})
