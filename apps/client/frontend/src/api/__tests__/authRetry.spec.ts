import { describe, expect, it } from 'vitest'
import { createApiClient, ApiError } from '../client'

/**
 * 401 → 刷新令牌 → 重试一次的契约。
 *
 * ★ 这条用例锁的是一个**真实线上问题**：
 *   用户打开书库，第一眼就是黄条 `操作失败：invalid or expired token`；
 *   非要点一下「刷新云端」按钮才恢复正常。
 *
 *   根因：令牌刷新只写在 `features/sync/engine.ts` 的 `#withAuthRetry` 里，
 *   而书库的 `refreshCloud()` / `uploadToCloud()` / `downloadCloud()` 是**直接**调
 *   `getApi()` 的，根本不经过同步引擎。access token 一过期，书库必然先炸一次。
 *
 *   修复：把 401 兜底收敛到 API 客户端这唯一出口，所有 `getApi()` 调用自动受益。
 */

/** 造一个按脚本返回响应的 fetch：每次调用消费一个脚本项。 */
function scriptedFetch(
  script: Array<{ status: number; body?: unknown }>,
  captured: Array<{ url: string; auth: string | null }> = [],
): typeof fetch {
  let i = 0
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {})
    captured.push({ url: String(input), auth: headers.get('Authorization') })
    const step = script[Math.min(i, script.length - 1)]
    i += 1
    const status = step?.status ?? 500
    const body = step?.body ?? {}
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as typeof fetch
}

const unauthorized = {
  status: 401,
  body: { code: 'invalid_token', message: 'invalid or expired token' },
}

describe('API 客户端 401 自动刷新', () => {
  it('★ 401 时刷新令牌并重试一次，调用方拿到成功结果', async () => {
    const captured: Array<{ url: string; auth: string | null }> = []
    let token = 'stale-token'
    let refreshes = 0

    const client = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => token,
      refreshAccessToken: async () => {
        refreshes += 1
        token = 'fresh-token'
        return token
      },
      fetchImpl: scriptedFetch([unauthorized, { status: 200, body: { items: [] } }], captured),
    })

    const result = await client.request<{ items: unknown[] }>('/v1/books')

    expect(result.items).toEqual([])
    expect(refreshes, '应该恰好刷新一次').toBe(1)
    expect(captured).toHaveLength(2)
    // 第一次带旧 token，第二次带新 token —— 证明重试用的是刷新后的凭据
    expect(captured[0]?.auth).toBe('Bearer stale-token')
    expect(captured[1]?.auth).toBe('Bearer fresh-token')
  })

  it('刷新失败（返回 null）时，把原始 401 抛给调用方', async () => {
    let refreshes = 0
    const client = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => 'stale',
      refreshAccessToken: async () => {
        refreshes += 1
        return null
      },
      fetchImpl: scriptedFetch([unauthorized]),
    })

    const err = await client.request('/v1/books').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
    expect(refreshes).toBe(1)
  })

  it('★ 刷新后仍然 401 ⇒ 只重试一次，不死循环', async () => {
    let calls = 0
    let refreshes = 0
    const client = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => 'still-bad',
      refreshAccessToken: async () => {
        refreshes += 1
        return 'still-bad'
      },
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1
        return Promise.resolve(
          new Response(JSON.stringify({ code: 'invalid_token', message: 'nope' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }) as typeof fetch,
    })

    const err = await client.request('/v1/books').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
    expect(calls, '原始请求 + 重试一次 = 2 次').toBe(2)
    expect(refreshes, '只刷新一次').toBe(1)
  })

  it('★ 并发多个 401 只刷新一次（refresh token 是轮换的，重复刷新会吊销会话）', async () => {
    let refreshes = 0
    let token = 'stale'

    const client = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => token,
      refreshAccessToken: async () => {
        refreshes += 1
        // 模拟真实的刷新延迟：并发请求会在这个窗口里全部撞上 401
        await new Promise((r) => setTimeout(r, 10))
        token = 'fresh'
        return token
      },
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers ?? {}).get('Authorization')
        const ok = auth === 'Bearer fresh'
        return Promise.resolve(
          ok
            ? new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              })
            : new Response(JSON.stringify({ code: 'invalid_token', message: 'expired' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
              }),
        )
      }) as typeof fetch,
    })

    const results = await Promise.all([
      client.request<{ ok: boolean }>('/v1/books'),
      client.request<{ ok: boolean }>('/v1/books'),
      client.request<{ ok: boolean }>('/v1/books'),
    ])

    expect(results.every((r) => r.ok)).toBe(true)
    expect(refreshes, '三个并发 401 只能触发一次刷新').toBe(1)
  })

  it('没有配置刷新回调时，401 原样抛出（不吞错）', async () => {
    const client = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => 'stale',
      fetchImpl: scriptedFetch([unauthorized]),
    })

    const err = await client.request('/v1/books').catch((e: unknown) => e)
    expect((err as ApiError).status).toBe(401)
  })

  it('非 401 的错误不触发刷新', async () => {
    let refreshes = 0
    const client = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: () => 'tok',
      refreshAccessToken: async () => {
        refreshes += 1
        return 'new'
      },
      fetchImpl: scriptedFetch([{ status: 500, body: { code: 'internal', message: 'boom' } }]),
    })

    const err = await client.request('/v1/books').catch((e: unknown) => e)
    expect((err as ApiError).status).toBe(500)
    expect(refreshes).toBe(0)
  })
})
